/**
 * 静态景物的建造：地面、营地矮墙、地被、狗巢、地标、风沙、暖意光环、刀刃。
 *
 * 从 GameRenderer.ts 拆出来。这些函数**只在开局跑一次**，把网格挂进场景就完事，
 * 不参与每帧循环，也不持有任何状态 —— 所以它们要的不是渲染器，只是
 * {@link SceneryContext} 那三样：往哪儿挂、地图长什么样、地面在这一点有多高。
 */
import * as THREE from "three";
import { clamp, mulberry32 } from "../game/simulation/geometry";
import type { WorldDefinition } from "../game/simulation/types";
import { distanceToCampApproach, terrainHeightAt, terrainMoistureAt, terrainSaltAt, terrainSlopeAt } from "../game/terrain/TerrainModel";
import type { BladeVisual } from "./renderPrimitives";
import { makeMaterial } from "./renderPrimitives";
import { BLOB_SHADOW_CAPACITY, createBlobShadowTexture, smoothTerrainBlend } from "./renderTuning";
import { mergeStaticGroup } from "./staticBatching";

/** 建景物要看到的那一小片世界。 */
export interface SceneryContext {
  readonly scene: THREE.Scene;
  readonly world: WorldDefinition;
  /** 低功耗档：草丛、砾石这类纯装饰要按它减量。 */
  readonly lowPower: boolean;
  /** 地面在这一点的高度。景物必须踩在地形上，不能悬空或埋进沙里。 */
  worldHeight(x: number, z: number): number;
}


/**
 * 地面噪点贴图。
 *
 * 这里**必须**是 DataTexture 而不是 CanvasTexture：CanvasTexture 只持有一个
 * 从未挂进 DOM 的 <canvas>，移动端 Chrome 在标签页切后台时会在内存压力下
 * 丢弃游离 canvas 的后备存储；回到前台重新上传纹理就是一片全黑。
 * （地面是 vertexColors + map，贴图一黑就整片黑；树石用纯色材质，所以不受影响。）
 *
 * 改成把像素抓进一个常驻的 Uint8Array 之后，浏览器没法回收它，
 * WebGL 上下文真的丢失时 three.js 也能从这份数据重新上传。
 * canvas 仍然用来画那 90 道划痕 —— 只是它现在只是个临时画板，用完即弃。
 */
export function createGroundTexture(renderer: THREE.WebGLRenderer, world: WorldDefinition): THREE.DataTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create terrain texture");
  const image = context.createImageData(canvas.width, canvas.height);
  const random = mulberry32(world.terrain.seed + 9187);
  for (let index = 0; index < canvas.width * canvas.height; index += 1) {
    const grain = 202 + Math.floor(random() * 38);
    image.data[index * 4] = grain;
    image.data[index * 4 + 1] = grain - 4 + Math.floor(random() * 7);
    image.data[index * 4 + 2] = grain - 13 + Math.floor(random() * 8);
    image.data[index * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  context.globalAlpha = 0.18;
  context.strokeStyle = "#70745d";
  for (let index = 0; index < 90; index += 1) {
    const x = random() * 128;
    const y = random() * 128;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + 1 + random() * 3, y - 1 - random() * 3);
    context.stroke();
  }
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const texture = new THREE.DataTexture(
    new Uint8Array(pixels.data.buffer.slice(0)),
    canvas.width,
    canvas.height,
    THREE.RGBAFormat,
  );
  texture.needsUpdate = true;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(24, 24);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

export function buildGround(ctx: SceneryContext, renderer: THREE.WebGLRenderer): THREE.Mesh {
  const size = ctx.world.size + 8;
  const segments = ctx.world.terrain.resolution;
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const colors = new Float32Array(positions.count * 3);
  // 荒漠调色：明亮的沙丘 → 湿润洼地的暗砾石 → 踩实的土路 → 裸岩 → 盐碱壳
  const sand = new THREE.Color(0xc9a86a);
  const gravel = new THREE.Color(0x9c7f52);
  const packedEarth = new THREE.Color(0x8a6435);
  const rock = new THREE.Color(0x8d7355);
  const salt = new THREE.Color(0xe2ddc9);
  const color = new THREE.Color();
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const z = -positions.getY(index);
    const point = { x, z };
    const height = terrainHeightAt(ctx.world, point);
    const slope = terrainSlopeAt(ctx.world, point, 1.15);
    const moisture = terrainMoistureAt(ctx.world, point);
    const saltAmount = terrainSaltAt(ctx.world, point);
    // 0.72 → 0.42：最深处从「比沙地暗 17%」收到「暗 10%」。
    // 配合 terrainMoistureAt 改成的多倍频，湿地退成砂砾斑驳，不再是一滩水。
    color.copy(sand).lerp(gravel, moisture * 0.42);
    let campWear = 0;
    for (const camp of ctx.world.camps) {
      const distance = Math.hypot(x - camp.x, z - camp.z);
      const wear = 1 - smoothTerrainBlend(camp.radius * 0.2, camp.radius * 0.55, distance);
      campWear = Math.max(campWear, wear * (camp.kind === "windy-ridge" ? 0.28 : camp.kind === "deep-cave" ? 0.5 : 0.42));
    }
    let pathWear = 0;
    for (const camp of ctx.world.camps) {
      const pathDistance = distanceToCampApproach(camp, point);
      pathWear = Math.max(pathWear, 1 - smoothTerrainBlend(camp.approachWidth * 0.48, camp.approachWidth * 0.48 + 1.65, pathDistance));
    }
    color.lerp(packedEarth, campWear);
    color.lerp(rock, smoothTerrainBlend(0.42, 0.86, slope));
    // 上坡的通路要始终看得清，所以土路色在裸岩色之后再刷一遍，
    // 并且踩实的路面不会结盐壳。
    color.lerp(packedEarth, pathWear * 0.84);
    color.lerp(salt, saltAmount * 0.85 * (1 - pathWear * 0.82));
    const variation = 0.93 + Math.sin(x * 0.71 + z * 0.37) * 0.025 + Math.sin(z * 1.13) * 0.018;
    color.multiplyScalar(variation);
    positions.setZ(index, height);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    vertexColors: true,
    map: createGroundTexture(renderer, ctx.world),
  });
  const ground = new THREE.Mesh(geometry, material);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ctx.scene.add(ground);

  const edgeMaterial = makeMaterial(0x4b514c, 1);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(ctx.world.size + 12, 5.5, ctx.world.size + 12), edgeMaterial);
  edge.position.y = -3.4;
  edge.receiveShadow = true;
  ctx.scene.add(edge);
  return ground;
}

function createGrassTuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let blade = 0; blade < 3; blade += 1) {
    const angle = (blade / 3) * Math.PI;
    const sideX = Math.cos(angle) * 0.18;
    const sideZ = Math.sin(angle) * 0.18;
    const leanX = Math.sin(angle * 1.7) * 0.08;
    const leanZ = Math.cos(angle * 1.3) * 0.08;
    positions.push(
      -sideX, 0, -sideZ,
      sideX, 0, sideZ,
      leanX, 0.78, leanZ,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function buildGroundCover(ctx: SceneryContext): void {
  const random = mulberry32(ctx.world.terrain.seed + 4403);
  const collect = (targetCount: number, maxSlope: number, moistureBias: number): Array<{ x: number; z: number; scale: number; rotation: number }> => {
    const points: Array<{ x: number; z: number; scale: number; rotation: number }> = [];
    let attempts = 0;
    while (points.length < targetCount && attempts < targetCount * 18) {
      attempts += 1;
      const point = { x: (random() - 0.5) * (ctx.world.size - 10), z: (random() - 0.5) * (ctx.world.size - 10) };
      if (terrainSlopeAt(ctx.world, point) > maxSlope) continue;
      const moisture = terrainMoistureAt(ctx.world, point);
      if (random() > clamp(0.42 + moisture * moistureBias, 0.18, 0.96)) continue;
      if (ctx.world.camps.some((camp) => Math.hypot(point.x - camp.x, point.z - camp.z) < camp.radius - 1.6)) continue;
      const hitsTrail = ctx.world.camps.some((camp) => distanceToCampApproach(camp, point) < camp.approachWidth * 0.5 + 1.6);
      if (hitsTrail) continue;
      points.push({ ...point, scale: 0.62 + random() * 0.78, rotation: random() * Math.PI * 2 });
    }
    return points;
  };

  const grassPoints = collect(760, 0.5, 0.62);
  const heathPoints = collect(210, 0.42, 0.88);
  /*
   * 卵石 260 → 110。
   *
   * 草和灌木没人会误会，卵石会：它是全场唯一"长得像可搬石头、却碰都碰不了"的
   * 东西，而真正能搬的石头只有三十几块。两百多颗假石头混在里面，等于把那三十几块
   * 真的藏起来了。砍掉一半多，地表纹理还在，误导少一大半。
   */
  const pebblePoints = collect(110, 0.62, -0.18);
  const grass = new THREE.InstancedMesh(
    createGrassTuftGeometry(),
    new THREE.MeshStandardMaterial({ color: 0x9c8a5a, roughness: 1, side: THREE.DoubleSide }),
    grassPoints.length,
  );
  const heath = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.3, 0),
    makeMaterial(0x7d6a45, 1),
    heathPoints.length,
  );
  const pebbles = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.2, 0),
    makeMaterial(0x9c8b70, 1),
    pebblePoints.length,
  );
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  const place = (
    mesh: THREE.InstancedMesh,
    points: Array<{ x: number; z: number; scale: number; rotation: number }>,
    baseHeight: number,
    scaleY: number,
  ): void => {
    points.forEach((point, index) => {
      position.set(point.x, ctx.worldHeight(point.x, point.z) + baseHeight * point.scale, point.z);
      quaternion.setFromEuler(new THREE.Euler(0, point.rotation, 0));
      scale.set(point.scale, point.scale * scaleY, point.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
    });
    // 贴地装饰下方仍是会收影的地面；移动端让它们自己再采一次 PCF 没有视觉收益。
    mesh.receiveShadow = !ctx.lowPower;
    ctx.scene.add(mesh);
  };
  place(grass, grassPoints, 0.02, 1.12);
  place(heath, heathPoints, 0.18, 0.62);
  place(pebbles, pebblePoints, 0.12, 0.58);
}

export function buildCampWalls(ctx: SceneryContext): void {
  const wallData = ctx.world.walls.filter((wall) => wall.kind === "wall");
  if (wallData.length === 0) return;
  const geometry = new THREE.DodecahedronGeometry(1, 0);
  const material = makeMaterial(0x62665e, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, wallData.length);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  wallData.forEach((wall, index) => {
    const height = 1.5 + ((index * 17) % 9) * 0.08;
    position.set(wall.x, ctx.worldHeight(wall.x, wall.z) + height * 0.52 - 0.12, wall.z);
    rotation.setFromEuler(new THREE.Euler(index * 0.73, index * 0.41, index * 0.27));
    scale.set(wall.radius, height, wall.radius * 0.9);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  ctx.scene.add(mesh);
}

/**
 * 狗巢。地形已经刻出土垄与缺口（shape_dens），这里只补三样让它一眼可读的东西：
 * 巢口那个黑洞、洞口两侧被爪子刨出的土脊、以及散落的骨头。
 *
 * 关键是**黑洞要够黑**：它是玩家夜里从 53 米外唯一能定位到的东西。
 * 用一个不受光的纯黑圆面朝天倾斜嵌进坡里，比任何几何都更像"深不见底"。
 */
export function buildDens(ctx: SceneryContext): void {
  const earth = makeMaterial(0x6a5642, 1);
  const packed = makeMaterial(0x53412f, 1);
  const bone = makeMaterial(0xd9cfb4, 0.85);
  for (const den of ctx.world.dens) {
    const group = new THREE.Group();
    const mouth = den.mouth;
    group.position.set(mouth.x, ctx.worldHeight(mouth.x, mouth.z), mouth.z);
    // 让整组朝向巢口方向，后面的偏移就都能用局部坐标写。
    group.rotation.y = -den.mouthAngle;

    // 洞口：一个不受光的黑面，微微仰起嵌进土坡。
    const hole = new THREE.Mesh(
      new THREE.CircleGeometry(1.9, 14),
      new THREE.MeshBasicMaterial({ color: 0x08070a }),
    );
    hole.rotation.x = -Math.PI / 2.55;
    hole.position.set(-1.1, 1.05, 0);
    hole.scale.set(1, 0.72, 1);
    group.add(hole);

    // 洞沿：一圈压实的土，把黑面和土坡接起来，免得黑洞看着像贴纸。
    const lip = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.42, 5, 12, Math.PI * 1.25), packed);
    lip.rotation.set(-Math.PI / 2.55, 0, Math.PI * 0.12);
    lip.position.set(-1.05, 1.0, 0);
    lip.scale.set(1, 0.78, 1);
    lip.castShadow = true;
    group.add(lip);

    // 刨出来的土脊：洞口两侧各三道，越靠外越矮，读作"这里被反复进出过"。
    for (const side of [-1, 1]) {
      for (let index = 0; index < 3; index += 1) {
        const spoil = new THREE.Mesh(new THREE.SphereGeometry(0.62 - index * 0.13, 6, 4), earth);
        spoil.position.set(0.5 + index * 0.85, 0.24 - index * 0.05, side * (1.5 + index * 0.5));
        spoil.scale.set(1.5, 0.5, 1);
        spoil.rotation.y = side * 0.3;
        spoil.castShadow = true;
        group.add(spoil);
      }
    }

    // 骨头：吃剩下的。数量少、位置散，是气味不是装饰。
    const scatter = mulberry32(den.id * 7919 + 13);
    for (let index = 0; index < 7; index += 1) {
      const angle = scatter() * Math.PI * 2;
      const radius = 1.9 + scatter() * 4.2;
      const long = scatter() > 0.45;
      const piece = new THREE.Mesh(
        long
          ? new THREE.CylinderGeometry(0.075, 0.075, 0.55 + scatter() * 0.5, 5)
          : new THREE.SphereGeometry(0.16 + scatter() * 0.1, 5, 4),
        bone,
      );
      piece.position.set(Math.cos(angle) * radius + 1.4, 0.09, Math.sin(angle) * radius);
      piece.rotation.set(Math.PI / 2, 0, scatter() * Math.PI);
      piece.castShadow = true;
      group.add(piece);
    }

    group.position.y += 0.02;
    // 一个巢十几个小 Mesh，从建好到这局结束一动不动 —— 按材质压成两三块。
    mergeStaticGroup(group);
    ctx.scene.add(group);
  }
}

export function buildLandmarks(ctx: SceneryContext): void {
  const deadwoodMaterial = makeMaterial(0x7a6446, 1);
  const ironMaterial = makeMaterial(0x5e554a, 0.95);
  const stoneMaterial = makeMaterial(0x8a7a63, 1);
  for (const landmark of ctx.world.landmarks) {
    const group = new THREE.Group();
    group.position.set(landmark.x, ctx.worldHeight(landmark.x, landmark.z), landmark.z);
    group.rotation.y = landmark.rotation;
    group.scale.setScalar(landmark.scale);
    if (landmark.kind === "deadwood") {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.48, 5.6, 7), deadwoodMaterial);
      trunk.rotation.z = Math.PI / 2;
      trunk.position.y = 0.42;
      trunk.castShadow = true;
      group.add(trunk);
      for (const side of [-1, 1]) {
        const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.17, 1.8, 5), deadwoodMaterial);
        branch.position.set(side * 1.2, 0.64, side * 0.35);
        branch.rotation.z = Math.PI / 3 * side;
        branch.castShadow = true;
        group.add(branch);
      }
    } else if (landmark.kind === "wreck") {
      const bed = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.5, 2), deadwoodMaterial);
      bed.position.y = 0.72;
      bed.rotation.z = -0.12;
      bed.castShadow = true;
      group.add(bed);
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.8, 6), ironMaterial);
      axle.rotation.x = Math.PI / 2;
      axle.position.y = 0.55;
      group.add(axle);
      for (const side of [-1, 1]) {
        const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.13, 6, 10), ironMaterial);
        wheel.position.set(0.45, 0.68, side * 1.12);
        wheel.rotation.x = Math.PI / 2;
        wheel.castShadow = true;
        group.add(wheel);
      }
      const shaft = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.18, 0.22), deadwoodMaterial);
      shaft.position.set(3.2, 0.5, 0);
      shaft.rotation.z = -0.08;
      group.add(shaft);
    } else {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(1.35, 4.6, 0.8), stoneMaterial);
      slab.position.y = 2.15;
      slab.rotation.z = 0.08;
      slab.castShadow = true;
      group.add(slab);
      for (let mark = 0; mark < 3; mark += 1) {
        const rune = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.08, 0.84), makeMaterial(0x9b7043, 0.8));
        rune.position.set(0.18 - mark * 0.16, 1.45 + mark * 0.72, 0.42);
        rune.rotation.z = mark % 2 ? 0.55 : -0.35;
        group.add(rune);
      }
    }
    // 三道刻痕的材质是循环里现造的，参数一样却是三个对象 ——
    // mergeStaticGroup 按材质**指纹**分桶，所以它们照样能合到一块。
    mergeStaticGroup(group);
    ctx.scene.add(group);
  }
}

/** 移动端隔帧更新一次真实阴影；桌面端沿用 WebGLShadowMap.autoUpdate。 */
/**
 * 角色贴地阴影的实例批次。整批一次 draw call，零蒙皮、不进深度 pass。
 *
 * frustumCulled 关掉：这批的包围盒每帧都在变（实例矩阵改了 three 也不会自动重算），
 * 开着剔除会在角色跑到画面边缘时整批消失。它只有一次 draw call，不值得为它算剔除。
 */
export function createBlobShadows(): THREE.InstancedMesh {
  const geometry = new THREE.PlaneGeometry(1, 1);
  // PlaneGeometry 默认立在 XY 平面上，转成贴地的 XZ 平面。
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    map: createBlobShadowTexture(),
    transparent: true,
    // 不写深度：几十片半透明圆斑互相之间不该有遮挡关系，写了反而会互相裁。
    depthWrite: false,
    opacity: 0.4,
    color: 0x000000,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, BLOB_SHADOW_CAPACITY);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  // 排在贴地装饰之后、角色之前。
  mesh.renderOrder = 2;
  mesh.count = 0;
  return mesh;
}

/** 风沙：贴地横向吹，而不是从天上落下来。 */
export function buildSand(): THREE.Points {
  const count = 240;
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (Math.random() - 0.5) * 70;
    // 绝大部分沙粒贴着地面走，只有少量被卷到高处。
    positions[index * 3 + 1] = Math.pow(Math.random(), 2.4) * 9;
    positions[index * 3 + 2] = (Math.random() - 0.5) * 70;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0xe6cd9a, size: 0.16, transparent: true, opacity: 0.4, depthWrite: false });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

export function createStakeView(): THREE.Group {
  const group = new THREE.Group();
  const woodMaterial = makeMaterial(0x6b5334, 1);
  for (const offset of [-0.34, 0, 0.34]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.7, 6), woodMaterial);
    post.position.set(offset, 0.85, offset * 0.4);
    post.rotation.z = offset * 0.12;
    post.castShadow = true;
    group.add(post);
  }
  const tie = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.95, 5), makeMaterial(0x8a7a5c, 1));
  tie.rotation.z = Math.PI / 2;
  tie.position.y = 1.15;
  group.add(tie);
  return group;
}

/**
 * 脚下的取暖光环：一圈暖光 + 一小群往上飘的火星。
 *
 * 为什么值得单独做一个：篝火的有效半径是 10 米，几乎盖住整座营地，
 * 而这条边界**在画面上完全看不见** —— 玩家只能靠盯着体温条的涨跌反推自己
 * 在不在圈里，那是最糟糕的一种反馈。有了这圈光，"我正在烤火"变成一眼可见的
 * 身体状态，而不是一条要读数字才知道的隐藏属性。
 *
 * 第一夜教学最后一步"待在火边"也靠它 —— 那一步要教的正是这条看不见的边界。
 */
export function buildWarmthAura(): { group: THREE.Group; ring: THREE.Mesh; motes: THREE.Points } {
  const group = new THREE.Group();
  group.visible = false;

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 1.5, 28),
    new THREE.MeshBasicMaterial({
      color: 0xffa74a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  group.add(ring);

  // 火星用 Points 而不是若干个 Mesh：24 颗粒子一次绘制调用，
  // 而它们只需要"往上飘"这一种运动，不值得为此多 24 个对象。
  const count = 24;
  const positions = new Float32Array(count * 3);
  const random = mulberry32(90210);
  for (let index = 0; index < count; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 0.35 + random() * 1.15;
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = random() * 2.1;
    positions[index * 3 + 2] = Math.sin(angle) * radius;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const motes = new THREE.Points(geometry, new THREE.PointsMaterial({
    color: 0xffc06a,
    size: 0.13,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  }));
  group.add(motes);
  return { group, ring, motes };
}

/**
 * 七把刀剑共用一个生成函数。
 *
 * 刃身本来就是程序化的（一个五点 Shape 挤出来），所以"换武器"只是换几个数字：
 * 宽窄、长短、单刃还是双刃、什么颜色。零美术成本，也正因如此**区分只能靠
 * 剪影与颜色** —— 可用的攻击动画只有一个劈砍，七把武器挥起来是同一个动作。
 *
 * 规则：色相分线（刀线冷、剑线暖），明度与自发光分阶。
 * 宽刀砍下去像斧、窄剑砍下去像削 —— 手感差异靠剪影就出来了。
 */
export function createBladeView(spec: BladeVisual, lowPower: boolean): THREE.Group {
  const group = new THREE.Group();
  group.name = spec.name;

  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.085, 0.105, 0.42, 7),
    makeMaterial(spec.gripColor, 0.92),
  );
  handle.position.y = -0.08;
  const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 7), makeMaterial(0x8a6842, 0.72));
  pommel.position.y = -0.32;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.38 * spec.width, 0.07, 0.1), makeMaterial(0x75644f, 0.58));
  guard.position.y = 0.15;

  // 单刃（刀）把背侧拉直，双刃（剑）左右对称 —— 这是刀与剑最省事也最有效的区分。
  const back = spec.doubleEdged ? -0.11 * spec.width : -0.07 * spec.width;
  const buildShape = (scale: number): THREE.Shape => {
    const shape = new THREE.Shape();
    shape.moveTo(back * scale, 0);
    shape.lineTo(0.14 * spec.width * scale, 0);
    shape.lineTo(0.09 * spec.width * scale, 0.78 * spec.length);
    shape.lineTo(0, 0.95 * spec.length);
    shape.lineTo(-0.07 * spec.width * scale, 0.77 * spec.length);
    shape.closePath();
    return shape;
  };

  const bladeMaterial = new THREE.MeshStandardMaterial({
    color: spec.color,
    roughness: spec.roughness,
    metalness: spec.metalness,
    flatShading: true,
    ...(spec.emissive === undefined ? {} : { emissive: spec.emissive, emissiveIntensity: spec.emissiveIntensity ?? 0.5 }),
  });
  const blade = new THREE.Mesh(
    new THREE.ExtrudeGeometry(buildShape(1), { depth: 0.055, bevelEnabled: false }),
    bladeMaterial,
  );
  blade.position.set(0, 0.17, -0.0275);
  group.add(handle, pommel, guard, blade);

  // 三阶长剑的墨黑刃身上再叠一层亮白刃口。两段材质是它一眼可辨的特征，
  // 对应刀线三阶的赤热纹 —— 每条线的终点都要有一个远处也认得出的记号。
  if (spec.edgeColor !== undefined) {
    const edge = new THREE.Mesh(
      new THREE.ExtrudeGeometry(buildShape(0.45), { depth: 0.062, bevelEnabled: false }),
      new THREE.MeshStandardMaterial({ color: spec.edgeColor, roughness: 0.25, metalness: 0.4, flatShading: true }),
    );
    edge.position.set(0, 0.17, -0.031);
    group.add(edge);
  }

  group.traverse((object) => {
    // 低功耗档改用贴地圆斑，见 createBlobShadowTexture 那段。
    if (object instanceof THREE.Mesh) object.castShadow = !lowPower;
  });
  return group;
}
