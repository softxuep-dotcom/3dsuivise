import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { GameSimulation } from "../game/simulation/GameSimulation";
import { clamp, lerp, mulberry32 } from "../game/simulation/geometry";
import type { CampDefinition, CritterKind, CritterState, GroundItem, Vec2, WolfState, WorldDefinition, WorldDrop } from "../game/simulation/types";
import { CRITTER_SPECS } from "../game/simulation/types";
import { distanceToCampApproach, terrainHeightAt, terrainMoistureAt, terrainSaltAt, terrainSlopeAt } from "../game/terrain/TerrainModel";

interface CampView {
  flame: THREE.Group;
  glow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
}

interface WolfView {
  group: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
}

interface CritterView {
  group: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
}

const makeMaterial = (color: THREE.ColorRepresentation, roughness = 0.9): THREE.MeshStandardMaterial => (
  new THREE.MeshStandardMaterial({ color, roughness, flatShading: true })
);

const smoothTerrainBlend = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

// 头狼是全场唯一的巨型剪影；白天的野狼用浅沙色，和夜袭狼的暗褐区分开。
const wolfScale = (wolf: WolfState): number => (
  wolf.kind === "alpha" ? 1.85 : wolf.kind === "large" ? 1.22 : 0.84
);

const wolfBodyColor = (wolf: WolfState): number => {
  if (wolf.kind === "alpha") return 0x2a211a;
  if (wolf.role === "wild") return 0xb59a6d;
  if (wolf.kind === "large") return 0x4a3a29;
  return wolf.raider ? 0x604a34 : 0x7d6449;
};

/** 猎物配色：整体压在沙色系里，靠明度和一点点色相区分，不抢狼的戏。 */
const CRITTER_COLORS: Record<CritterKind, { body: number; accent: number }> = {
  camel: { body: 0xc19a63, accent: 0x8f6f45 },
  lizard: { body: 0x8f9a5c, accent: 0x5f6a3c },
  hare: { body: 0xd8c49a, accent: 0xf0e4cc },
  vulture: { body: 0x4a423a, accent: 0xd0b98c },
  gerbil: { body: 0xc9a878, accent: 0xe8d6b4 },
  rat: { body: 0xa89478, accent: 0xf2ece0 },
  beetle: { body: 0x3d3630, accent: 0x6b5c48 },
  sandworm: { body: 0xd9c091, accent: 0xb99d70 },
};

// --- 低多边形猎物模型。都朝 +X 方向，和狼保持一致。 ---

const addLegs = (
  group: THREE.Group,
  material: THREE.Material,
  count: number,
  radius: number,
  height: number,
  spreadX: number,
  spreadZ: number,
): void => {
  for (let index = 0; index < count; index += 1) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.8, height, 4), material);
    leg.position.set(index < count / 2 ? spreadX : -spreadX, height / 2, index % 2 === 0 ? spreadZ : -spreadZ);
    group.add(leg);
  }
};

function buildCamel(group: THREE.Group, body: THREE.Material, accent: THREE.Material): void {
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.15, 3, 6), body);
  torso.rotation.z = Math.PI / 2;
  torso.position.y = 1.32;
  torso.castShadow = true;
  group.add(torso);
  // 两个驼峰是骆驼最好认的剪影特征。
  for (let index = 0; index < 2; index += 1) {
    const hump = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 5), body);
    hump.position.set(index === 0 ? 0.22 : -0.24, 1.72, 0);
    hump.scale.set(1, 0.85, 0.9);
    group.add(hump);
  }
  const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.72, 3, 5), body);
  neck.position.set(0.78, 1.78, 0);
  neck.rotation.z = -0.5;
  group.add(neck);
  const head = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.28, 3, 5), accent);
  head.rotation.z = Math.PI / 2.4;
  head.position.set(1.12, 2.06, 0);
  group.add(head);
  addLegs(group, accent, 4, 0.09, 1.32, 0.42, 0.26);
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.02, 0.5, 4), accent);
  tail.position.set(-0.82, 1.28, 0);
  tail.rotation.z = 0.7;
  group.add(tail);
}

function buildLizard(group: THREE.Group, body: THREE.Material, accent: THREE.Material): void {
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.62, 3, 6), body);
  torso.rotation.z = Math.PI / 2;
  torso.position.y = 0.24;
  torso.scale.set(1, 1, 0.72);
  torso.castShadow = true;
  group.add(torso);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.42, 5), accent);
  head.rotation.z = -Math.PI / 2;
  head.position.set(0.6, 0.26, 0);
  group.add(head);
  // 长尾巴：三节递减，贴着地面拖出去。
  for (let index = 0; index < 3; index += 1) {
    const seg = new THREE.Mesh(new THREE.ConeGeometry(0.13 - index * 0.035, 0.34, 4), body);
    seg.rotation.z = Math.PI / 2;
    seg.position.set(-0.5 - index * 0.3, 0.22 - index * 0.02, 0);
    group.add(seg);
  }
  addLegs(group, accent, 4, 0.05, 0.24, 0.28, 0.22);
}

function buildHare(group: THREE.Group, body: THREE.Material, accent: THREE.Material): void {
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.32, 6, 5), body);
  torso.position.y = 0.4;
  torso.scale.set(1.25, 0.95, 0.9);
  torso.castShadow = true;
  group.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 6, 5), body);
  head.position.set(0.36, 0.56, 0);
  group.add(head);
  // 长耳朵 —— 野兔唯一需要的识别符号。
  for (let index = 0; index < 2; index += 1) {
    const ear = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.3, 3, 4), accent);
    ear.position.set(0.32, 0.86, index === 0 ? 0.09 : -0.09);
    ear.rotation.z = -0.22;
    group.add(ear);
  }
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.1, 5, 4), accent);
  tail.position.set(-0.42, 0.44, 0);
  group.add(tail);
  addLegs(group, body, 4, 0.06, 0.24, 0.2, 0.2);
}

function buildVulture(group: THREE.Group, body: THREE.Material, accent: THREE.Material): void {
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.44, 3, 6), body);
  torso.rotation.z = Math.PI / 2;
  torso.position.y = 0.6;
  torso.castShadow = true;
  group.add(torso);
  // 光秃秃的脖子和喙，是秃鹰的招牌。
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.3, 5), accent);
  neck.position.set(0.34, 0.82, 0);
  neck.rotation.z = -0.35;
  group.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 5, 4), accent);
  head.position.set(0.46, 0.96, 0);
  group.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 4), accent);
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.62, 0.94, 0);
  group.add(beak);
  for (let index = 0; index < 2; index += 1) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.3), body);
    wing.position.set(-0.05, 0.66, index === 0 ? 0.28 : -0.28);
    wing.rotation.x = index === 0 ? 0.2 : -0.2;
    group.add(wing);
  }
  addLegs(group, accent, 2, 0.045, 0.6, 0.06, 0.13);
}

function buildRodent(group: THREE.Group, body: THREE.Material, accent: THREE.Material): void {
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.3, 3, 6), body);
  torso.rotation.z = Math.PI / 2;
  torso.position.y = 0.24;
  torso.castShadow = true;
  group.add(torso);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.3, 5), accent);
  head.rotation.z = -Math.PI / 2;
  head.position.set(0.42, 0.26, 0);
  group.add(head);
  // 细长尾巴，比身体还长。
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.012, 0.62, 4), accent);
  tail.rotation.z = Math.PI / 2.6;
  tail.position.set(-0.5, 0.3, 0);
  group.add(tail);
  addLegs(group, accent, 4, 0.04, 0.2, 0.16, 0.16);
}

function buildBeetle(group: THREE.Group, body: THREE.Material, accent: THREE.Material): void {
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.28, 6, 5), body);
  shell.position.y = 0.2;
  shell.scale.set(1.15, 0.62, 0.95);
  shell.castShadow = true;
  group.add(shell);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 5, 4), accent);
  head.position.set(0.3, 0.17, 0);
  group.add(head);
  // 六条细腿，贴地叉开。
  for (let index = 0; index < 6; index += 1) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.2, 4), accent);
    const along = 0.18 - Math.floor(index / 2) * 0.18;
    leg.position.set(along, 0.09, index % 2 === 0 ? 0.22 : -0.22);
    leg.rotation.x = index % 2 === 0 ? 0.7 : -0.7;
    group.add(leg);
  }
}

function buildSandworm(group: THREE.Group, body: THREE.Material): void {
  // 一串递减的球体，只露出半截身子 —— 剩下的当作埋在沙里。
  for (let index = 0; index < 5; index += 1) {
    const seg = new THREE.Mesh(new THREE.SphereGeometry(0.2 - index * 0.028, 6, 4), body);
    seg.position.set(0.3 - index * 0.22, 0.14 - index * 0.02, 0);
    seg.scale.set(1, 0.72, 1);
    if (index === 0) seg.castShadow = true;
    group.add(seg);
  }
}

const wolfEyeColor = (wolf: WolfState): number => {
  if (wolf.kind === "alpha") return 0xff2b1f;
  if (wolf.role === "wild") return 0xe8d9a8;
  if (wolf.kind === "large") return 0xff4938;
  return wolf.raider ? 0xff784d : 0xf3c668;
};

export class GameRenderer {
  readonly canvas: HTMLCanvasElement;

  private readonly simulation: GameSimulation;
  private readonly world: WorldDefinition;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(47, 1, 0.1, 320);
  private readonly renderer: THREE.WebGLRenderer;
  /** 上下文丢失期间跳过绘制，否则每帧都会刷一串 GL 错误。 */
  private contextLost = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly terrainMesh: THREE.Mesh;
  private readonly worldPoint = new THREE.Vector3();
  private readonly cameraFocus = new THREE.Vector3();
  private readonly playerGroup: THREE.Group;
  private readonly playerFallback: THREE.Group;
  private readonly playerBodyMaterial: THREE.MeshStandardMaterial;
  private readonly carriedWood: THREE.Object3D;
  private readonly carriedStone: THREE.Object3D;
  private readonly weaponMount: THREE.Group;
  private readonly knife: THREE.Group;
  private readonly spear: THREE.Group;
  private readonly playerCoat: THREE.Group;
  private readonly previousPlayerPosition = new THREE.Vector2();
  private readonly playerActions = new Map<string, THREE.AnimationAction>();
  private readonly playerModelMaterials = new Set<THREE.MeshStandardMaterial>();
  private playerModel: THREE.Group | null = null;
  private playerCape: THREE.Object3D | null = null;
  private playerMixer: THREE.AnimationMixer | null = null;
  private currentPlayerAction: THREE.AnimationAction | null = null;
  private currentPlayerAnimation = "";
  private readonly campViews = new Map<number, CampView>();
  private readonly itemViews = new Map<number, THREE.Object3D>();
  private readonly cactusViews = new Map<number, THREE.Object3D>();
  private readonly ironViews = new Map<number, THREE.Object3D>();
  private readonly wellViews = new Map<number, THREE.Object3D>();
  private readonly wellPips = new Map<number, THREE.Object3D[]>();
  private readonly structureViews = new Map<number, THREE.Object3D>();
  private readonly structureFlames = new Map<number, THREE.Object3D>();
  /** 井顶水珠的浮动相位。 */
  private wellBob = 0;
  private readonly wolfViews = new Map<number, WolfView>();
  private readonly critterViews = new Map<number, CritterView>();
  private readonly dropViews = new Map<number, THREE.Object3D>();
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly fireLight = new THREE.PointLight(0xff8b38, 0, 22, 2);
  private readonly sand: THREE.Points;
  private cameraShake = 0;
  private time = 0;

  constructor(root: HTMLElement, world: WorldDefinition, simulation: GameSimulation) {
    this.world = world;
    this.simulation = simulation;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.canvas = this.renderer.domElement;
    root.appendChild(this.canvas);
    this.bindContextRecovery();

    // 荒漠白天：泛黄的尘霾天空，地面反照强烈。
    this.scene.background = new THREE.Color(0xd8bf8d);
    this.scene.fog = new THREE.FogExp2(0xcbae7d, 0.0075);
    this.hemisphere = new THREE.HemisphereLight(0xffeec4, 0x8a6a44, 2.2);
    this.scene.add(this.hemisphere);
    this.sun = new THREE.DirectionalLight(0xfff0cc, 3.2);
    this.sun.position.set(-35, 55, 25);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.left = -32;
    this.sun.shadow.camera.right = 32;
    this.sun.shadow.camera.top = 32;
    this.sun.shadow.camera.bottom = -32;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 130;
    this.scene.add(this.sun, this.fireLight);

    this.terrainMesh = this.buildGround();
    this.buildCampWalls();
    this.buildTrees();
    this.buildGroundCover();
    this.buildLandmarks();
    this.buildCamps();
    this.buildCacti();
    this.buildIronNodes();
    this.buildWells();
    this.playerBodyMaterial = makeMaterial(0x2f7b8d, 0.75);
    const player = this.buildPlayer();
    this.playerGroup = player.group;
    this.playerFallback = player.fallback;
    this.carriedWood = player.carriedWood;
    this.carriedStone = player.carriedStone;
    this.weaponMount = player.weaponMount;
    this.knife = player.knife;
    this.spear = player.spear;
    this.playerCoat = player.coat;
    this.scene.add(this.playerGroup);
    this.previousPlayerPosition.set(simulation.player.x, simulation.player.z);
    void this.loadPlayerAsset();
    this.sand = this.buildSand();
    this.scene.add(this.sand);

    this.cameraFocus.set(simulation.player.x, this.worldHeight(simulation.player.x, simulation.player.z), simulation.player.z);
    this.resize();
    window.addEventListener("resize", this.resize);
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      document.getElementById("unsupported")?.classList.remove("hidden");
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      document.getElementById("unsupported")?.classList.add("hidden");
    });
  }

  render(deltaSeconds: number): void {
    // 上下文丢失期间任何 GL 调用都会报错刷屏，直接跳过这一帧。
    if (this.contextLost) return;
    const delta = Math.min(deltaSeconds, 0.05);
    this.time += delta;
    this.syncPlayer(delta);
    this.syncItems();
    this.syncCacti();
    this.syncIronNodes();
    this.syncWells(delta);
    this.syncStructures();
    this.syncCritters(delta);
    this.syncWolves(delta);
    this.syncDrops();
    this.syncFires();
    this.syncDayNight();
    this.updateCamera(delta);
    this.updateSand(delta);
    this.renderer.render(this.scene, this.camera);
  }

  screenToWorld(clientX: number, clientY: number): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh, false)[0];
    if (!hit) return null;
    this.worldPoint.copy(hit.point);
    return { x: this.worldPoint.x, z: this.worldPoint.z };
  }

  impact(strength: number): void {
    this.cameraShake = Math.max(this.cameraShake, strength);
  }

  private readonly resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.fov = width < 760 ? (width < height ? 58 : 50) : 47;
    this.camera.updateProjectionMatrix();
    // Keep the CSS size in viewport pixels while WebGL uses the DPR-scaled
    // drawing buffer internally. With `updateStyle = false`, the canvas's
    // intrinsic DPR-scaled dimensions become its layout size on mobile,
    // cropping the view and pushing the real screen centre down-right.
    this.renderer.setSize(width, height);
  };

  private buildGround(): THREE.Mesh {
    const size = this.world.size + 8;
    const segments = this.world.terrain.resolution;
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
      const height = terrainHeightAt(this.world, point);
      const slope = terrainSlopeAt(this.world, point, 1.15);
      const moisture = terrainMoistureAt(this.world, point);
      const saltAmount = terrainSaltAt(this.world, point);
      color.copy(sand).lerp(gravel, moisture * 0.72);
      let campWear = 0;
      for (const camp of this.world.camps) {
        const distance = Math.hypot(x - camp.x, z - camp.z);
        const wear = 1 - smoothTerrainBlend(camp.radius * 0.2, camp.radius * 0.55, distance);
        campWear = Math.max(campWear, wear * (camp.kind === "windy-ridge" ? 0.28 : camp.kind === "deep-cave" ? 0.5 : 0.42));
      }
      let pathWear = 0;
      for (const camp of this.world.camps) {
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
      map: this.createGroundTexture(),
    });
    const ground = new THREE.Mesh(geometry, material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const edgeMaterial = makeMaterial(0x4b514c, 1);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(this.world.size + 12, 5.5, this.world.size + 12), edgeMaterial);
    edge.position.y = -3.4;
    edge.receiveShadow = true;
    this.scene.add(edge);
    return ground;
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
  private createGroundTexture(): THREE.DataTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create terrain texture");
    const image = context.createImageData(canvas.width, canvas.height);
    const random = mulberry32(this.world.terrain.seed + 9187);
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
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    return texture;
  }

  /**
   * WebGL 上下文丢失/恢复。
   *
   * 移动端把标签页切到后台、或系统回收显存时，浏览器会丢掉 WebGL 上下文。
   * 默认行为是**永不恢复**——必须 preventDefault 才会触发 restore，
   * 否则回到前台就是一块死掉的黑画布。
   *
   * 恢复之后 three.js 会自己把几何体和纹理重新上传，前提是它们的 CPU 侧数据还在；
   * 地面贴图已经从 CanvasTexture 换成 DataTexture 正是为了保证这一点。
   */
  private bindContextRecovery(): void {
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.contextLost = true;
      console.warn("WebGL 上下文丢失，等待浏览器恢复");
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      // 尺寸在丢失期间可能变过（转屏），恢复后重新对齐一次。
      this.resize();
      console.info("WebGL 上下文已恢复");
    });
  }

  private createGrassTuftGeometry(): THREE.BufferGeometry {
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

  private buildCampWalls(): void {
    const wallData = this.world.walls.filter((wall) => wall.kind === "wall");
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
      position.set(wall.x, this.worldHeight(wall.x, wall.z) + height * 0.52 - 0.12, wall.z);
      rotation.setFromEuler(new THREE.Euler(index * 0.73, index * 0.41, index * 0.27));
      scale.set(wall.radius, height, wall.radius * 0.9);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private buildTrees(): void {
    const trunkGeometry = new THREE.CylinderGeometry(0.22, 0.4, 3.4, 6);
    const branchGeometry = new THREE.ConeGeometry(1.25, 3.5, 7);
    const trunkMaterial = makeMaterial(0x7a6446, 1);
    const branchMaterial = makeMaterial(0x8a7550, 1);
    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, this.world.trees.length);
    const branches = new THREE.InstancedMesh(branchGeometry, branchMaterial, this.world.trees.length);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    this.world.trees.forEach((tree, index) => {
      const terrainY = this.worldHeight(tree.x, tree.z);
      position.set(tree.x, terrainY + 1.65 * tree.scale, tree.z);
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), tree.rotation);
      scale.setScalar(tree.scale);
      matrix.compose(position, rotation, scale);
      trunks.setMatrixAt(index, matrix);
      position.y = terrainY + 3.55 * tree.scale;
      matrix.compose(position, rotation, scale);
      branches.setMatrixAt(index, matrix);
    });
    trunks.castShadow = true;
    branches.castShadow = true;
    this.scene.add(trunks, branches);
  }

  private buildGroundCover(): void {
    const random = mulberry32(this.world.terrain.seed + 4403);
    const collect = (targetCount: number, maxSlope: number, moistureBias: number): Array<{ x: number; z: number; scale: number; rotation: number }> => {
      const points: Array<{ x: number; z: number; scale: number; rotation: number }> = [];
      let attempts = 0;
      while (points.length < targetCount && attempts < targetCount * 18) {
        attempts += 1;
        const point = { x: (random() - 0.5) * (this.world.size - 10), z: (random() - 0.5) * (this.world.size - 10) };
        if (terrainSlopeAt(this.world, point) > maxSlope) continue;
        const moisture = terrainMoistureAt(this.world, point);
        if (random() > clamp(0.42 + moisture * moistureBias, 0.18, 0.96)) continue;
        if (this.world.camps.some((camp) => Math.hypot(point.x - camp.x, point.z - camp.z) < camp.radius - 1.6)) continue;
        const hitsTrail = this.world.camps.some((camp) => distanceToCampApproach(camp, point) < camp.approachWidth * 0.5 + 1.6);
        if (hitsTrail) continue;
        points.push({ ...point, scale: 0.62 + random() * 0.78, rotation: random() * Math.PI * 2 });
      }
      return points;
    };

    const grassPoints = collect(760, 0.5, 0.62);
    const heathPoints = collect(210, 0.42, 0.88);
    const pebblePoints = collect(260, 0.62, -0.18);
    const grass = new THREE.InstancedMesh(
      this.createGrassTuftGeometry(),
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
        position.set(point.x, this.worldHeight(point.x, point.z) + baseHeight * point.scale, point.z);
        quaternion.setFromEuler(new THREE.Euler(0, point.rotation, 0));
        scale.set(point.scale, point.scale * scaleY, point.scale);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    };
    place(grass, grassPoints, 0.02, 1.12);
    place(heath, heathPoints, 0.18, 0.62);
    place(pebbles, pebblePoints, 0.12, 0.58);
  }

  private buildLandmarks(): void {
    const deadwoodMaterial = makeMaterial(0x7a6446, 1);
    const ironMaterial = makeMaterial(0x5e554a, 0.95);
    const stoneMaterial = makeMaterial(0x8a7a63, 1);
    for (const landmark of this.world.landmarks) {
      const group = new THREE.Group();
      group.position.set(landmark.x, this.worldHeight(landmark.x, landmark.z), landmark.z);
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
      this.scene.add(group);
    }
  }

  private buildIronNodes(): void {
    const rockMaterial = makeMaterial(0x7d6a52, 1);
    const oreMaterial = new THREE.MeshStandardMaterial({
      color: 0xa26a45,
      emissive: 0x32170b,
      emissiveIntensity: 0.65,
      roughness: 0.72,
      flatShading: true,
    });
    for (const node of this.simulation.ironNodes) {
      const group = new THREE.Group();
      group.position.set(node.x, this.worldHeight(node.x, node.z), node.z);
      group.rotation.y = node.rotation;
      const base = new THREE.Mesh(new THREE.DodecahedronGeometry(0.88, 0), rockMaterial);
      base.position.y = 0.58;
      base.scale.set(1.25, 0.76, 1);
      base.castShadow = true;
      group.add(base);
      for (let index = 0; index < 3; index += 1) {
        const ore = new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 0), oreMaterial);
        ore.position.set(-0.42 + index * 0.4, 0.78 + (index % 2) * 0.18, 0.48 - index * 0.15);
        group.add(ore);
      }
      this.scene.add(group);
      this.ironViews.set(node.id, group);
    }
  }

  /**
   * 干枯的井：一圈石砌井沿 + 一根横木。做得比铁矿显眼 ——
   * 它是玩家规划路线的地标，必须能在远处一眼认出来。
   */
  private buildWells(): void {
    const stoneMaterial = makeMaterial(0x8a7c63, 1);
    const beamMaterial = makeMaterial(0x6b5334, 1);
    for (const well of this.simulation.world.wells) {
      const group = new THREE.Group();
      group.position.set(well.x, this.worldHeight(well.x, well.z), well.z);
      group.rotation.y = well.rotation;

      const rim = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.5, 0.82, 12, 1, true), stoneMaterial);
      rim.position.y = 0.41;
      rim.castShadow = true;
      group.add(rim);

      const mouth = new THREE.Mesh(new THREE.CircleGeometry(1.3, 12), makeMaterial(0x1d1710, 1));
      mouth.rotation.x = -Math.PI / 2;
      mouth.position.y = 0.8;
      group.add(mouth);

      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 2.1, 6), beamMaterial);
        post.position.set(side * 1.2, 1.05, 0);
        post.castShadow = true;
        group.add(post);
      }
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.6, 6), beamMaterial);
      beam.rotation.z = Math.PI / 2;
      beam.position.y = 2.05;
      group.add(beam);

      // 井顶浮起三颗水珠代表存量：远距离就能读出这趟值不值得跑。
      const pips: THREE.Object3D[] = [];
      const pipGeometry = new THREE.OctahedronGeometry(0.17, 0);
      for (let index = 0; index < 3; index += 1) {
        const pip = new THREE.Mesh(pipGeometry, new THREE.MeshStandardMaterial({
          color: 0x5cc7f0,
          emissive: 0x1d6f96,
          emissiveIntensity: 0.9,
          roughness: 0.35,
        }));
        pip.position.set((index - 1) * 0.42, 2.55, 0);
        group.add(pip);
        pips.push(pip);
      }
      this.wellPips.set(well.id, pips);

      this.scene.add(group);
      this.wellViews.set(well.id, group);
    }
  }

  private buildCamps(): void {
    const emberMaterial = new THREE.MeshStandardMaterial({
      color: 0xff7a26,
      emissive: 0xff4c12,
      emissiveIntensity: 2.6,
      roughness: 0.65,
      flatShading: true,
    });
    const innerMaterial = new THREE.MeshBasicMaterial({ color: 0xffdb67 });
    const logMaterial = makeMaterial(0x4c2d20, 1);
    const rockMaterial = makeMaterial(0x4c575a, 1);

    for (const camp of this.world.camps) {
      const group = new THREE.Group();
      group.position.set(camp.x, this.worldHeight(camp.x, camp.z), camp.z);
      for (let index = 0; index < 8; index += 1) {
        const angle = (index / 8) * Math.PI * 2;
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.38, 0), rockMaterial);
        rock.position.set(Math.cos(angle) * 1.18, 0.28, Math.sin(angle) * 1.18);
        rock.scale.set(1.15, 0.72, 0.9);
        rock.rotation.y = angle;
        rock.castShadow = true;
        group.add(rock);
      }
      for (let index = 0; index < 3; index += 1) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.6, 6), logMaterial);
        log.rotation.z = Math.PI / 2;
        log.rotation.y = (index / 3) * Math.PI;
        log.position.y = 0.32 + index * 0.03;
        log.castShadow = true;
        group.add(log);
      }
      const flame = new THREE.Group();
      const outer = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.65, 7), emberMaterial);
      outer.position.y = 1.02;
      const inner = new THREE.Mesh(new THREE.ConeGeometry(0.31, 1.05, 6), innerMaterial);
      inner.position.set(0.08, 0.82, 0.03);
      flame.add(outer, inner);
      group.add(flame);

      const glowMaterial = new THREE.MeshBasicMaterial({
        color: 0xff8c3a,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const glow = new THREE.Mesh(new THREE.CircleGeometry(7.4, 32), glowMaterial);
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.035;
      group.add(glow);

      const backAngle = camp.entranceAngle + Math.PI;
      if (camp.kind === "deep-cave") {
        const caveMaterial = makeMaterial(0x414843, 1);
        const caveMouth = new THREE.Mesh(
          new THREE.CircleGeometry(3.15, 9),
          new THREE.MeshBasicMaterial({ color: 0x151b1c, side: THREE.DoubleSide }),
        );
        caveMouth.position.set(Math.cos(backAngle) * 8.05, 2.25, Math.sin(backAngle) * 8.05);
        caveMouth.rotation.y = -backAngle - Math.PI / 2;
        group.add(caveMouth);
        for (let index = -1; index <= 1; index += 1) {
          const caveRock = new THREE.Mesh(new THREE.DodecahedronGeometry(1.55, 0), caveMaterial);
          const angle = backAngle + index * 0.16;
          caveRock.position.set(Math.cos(angle) * 8.2, 1.1 + (index === 0 ? 1.1 : 0), Math.sin(angle) * 8.2);
          caveRock.scale.set(index === 0 ? 2.3 : 1.55, index === 0 ? 1.8 : 1.35, 1.5);
          caveRock.castShadow = true;
          group.add(caveRock);
        }
      } else if (camp.kind === "windy-ridge") {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 5.2, 6), makeMaterial(0x55483c, 1));
        pole.position.set(Math.cos(backAngle) * 5.8, 2.6, Math.sin(backAngle) * 5.8);
        pole.castShadow = true;
        group.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.72), makeMaterial(0x8c553b, 0.85));
        flag.position.copy(pole.position).add(new THREE.Vector3(0.85, 1.55, 0));
        flag.rotation.y = -camp.entranceAngle;
        group.add(flag);
        for (let cairnIndex = 0; cairnIndex < 3; cairnIndex += 1) {
          const cairn = new THREE.Mesh(new THREE.DodecahedronGeometry(0.38, 0), makeMaterial(0x737871, 1));
          cairn.position.set(
            Math.cos(backAngle - 0.72) * 5.2,
            0.28 + cairnIndex * 0.46,
            Math.sin(backAngle - 0.72) * 5.2,
          );
          cairn.scale.set(1 - cairnIndex * 0.18, 0.72, 0.9 - cairnIndex * 0.12);
          cairn.castShadow = true;
          group.add(cairn);
        }
      } else {
        const crateMaterial = makeMaterial(0x654b34, 1);
        for (let index = 0; index < 3; index += 1) {
          const crate = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.85, 1), crateMaterial);
          crate.position.set(Math.cos(backAngle + 0.35) * (5.2 + index), 0.45, Math.sin(backAngle + 0.35) * (5.2 + index));
          crate.rotation.y = backAngle + index * 0.4;
          crate.castShadow = true;
          group.add(crate);
        }
        const canvasMaterial = new THREE.MeshStandardMaterial({ color: 0x7c6248, roughness: 1, side: THREE.DoubleSide });
        const leanTo = new THREE.Mesh(new THREE.PlaneGeometry(3.7, 2.6), canvasMaterial);
        leanTo.position.set(Math.cos(backAngle - 0.55) * 5.4, 1.55, Math.sin(backAngle - 0.55) * 5.4);
        leanTo.rotation.set(-Math.PI / 2.7, -backAngle, 0.08);
        leanTo.castShadow = true;
        group.add(leanTo);
        for (const side of [-1, 1]) {
          const support = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 2.3, 5), crateMaterial);
          support.position.copy(leanTo.position).add(new THREE.Vector3(side * 1.45, -0.5, side * 0.12));
          support.rotation.z = side * 0.12;
          support.castShadow = true;
          group.add(support);
        }
        const brokenFence = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.16, 0.22), crateMaterial);
        brokenFence.position.set(Math.cos(backAngle + 1.1) * 6.5, 0.72, Math.sin(backAngle + 1.1) * 6.5);
        brokenFence.rotation.y = backAngle - 0.35;
        brokenFence.rotation.z = -0.18;
        brokenFence.castShadow = true;
        group.add(brokenFence);
      }
      this.scene.add(group);
      this.campViews.set(camp.id, { flame, glow });
    }
  }

  /** 仙人掌：柱状主干 + 两条手臂 + 顶花，是荒漠里唯一稳定的水源。 */
  private buildCacti(): void {
    const fleshMaterial = makeMaterial(0x4f7a48, 0.95);
    const flowerMaterial = new THREE.MeshStandardMaterial({ color: 0xe0567a, roughness: 0.6, emissive: 0x3a0a18 });
    const spineMaterial = makeMaterial(0xd8cba4, 0.8);
    const random = mulberry32(4127);
    for (const patch of this.simulation.cacti) {
      const group = new THREE.Group();
      const trunkHeight = 1.6 + random() * 0.9;
      const trunk = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, trunkHeight, 3, 7), fleshMaterial);
      trunk.position.y = trunkHeight / 2 + 0.3;
      trunk.castShadow = true;
      group.add(trunk);
      // 两条手臂朝相反方向伸出，高度略有差异，避免看起来太对称。
      for (let side = 0; side < 2; side += 1) {
        const dir = side === 0 ? 1 : -1;
        const armHeight = 0.55 + random() * 0.4;
        const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, armHeight, 3, 6), fleshMaterial);
        arm.position.set(dir * 0.42, 0.75 + side * 0.42 + armHeight / 2, 0);
        arm.castShadow = true;
        group.add(arm);
        const elbow = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.34, 3, 6), fleshMaterial);
        elbow.rotation.z = Math.PI / 2;
        elbow.position.set(dir * 0.24, 0.75 + side * 0.42, 0);
        group.add(elbow);
      }
      const flower = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), flowerMaterial);
      flower.position.y = trunkHeight + 0.42;
      group.add(flower);
      for (let index = 0; index < 3; index += 1) {
        const spine = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 4), spineMaterial);
        const angle = (index / 3) * Math.PI * 2;
        spine.position.set(Math.cos(angle) * 0.31, 0.6 + index * 0.42, Math.sin(angle) * 0.31);
        spine.rotation.z = -Math.cos(angle) * 1.2;
        spine.rotation.x = Math.sin(angle) * 1.2;
        group.add(spine);
      }
      group.rotation.y = random() * Math.PI * 2;
      group.position.set(patch.x, this.worldHeight(patch.x, patch.z), patch.z);
      this.scene.add(group);
      this.cactusViews.set(patch.id, group);
    }
  }

  private buildPlayer(): {
    group: THREE.Group;
    fallback: THREE.Group;
    carriedWood: THREE.Object3D;
    carriedStone: THREE.Object3D;
    weaponMount: THREE.Group;
    knife: THREE.Group;
    spear: THREE.Group;
    coat: THREE.Group;
  } {
    const group = new THREE.Group();
    const fallback = new THREE.Group();
    group.add(fallback);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.56, 1.05, 4, 7), this.playerBodyMaterial);
    body.position.y = 1.27;
    body.castShadow = true;
    fallback.add(body);

    const hoodMaterial = makeMaterial(0x173942, 0.85);
    const faceMaterial = makeMaterial(0xd9a17e, 0.8);
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.48, 8, 6), hoodMaterial);
    hood.position.set(0, 2.12, 0);
    hood.castShadow = true;
    fallback.add(hood);
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.28, 7, 5), faceMaterial);
    face.position.set(0.35, 2.12, 0);
    face.scale.set(0.65, 0.85, 0.85);
    fallback.add(face);

    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.75, 0.72), makeMaterial(0x5c4933, 1));
    pack.position.set(-0.43, 1.42, 0);
    pack.castShadow = true;
    fallback.add(pack);

    const coat = new THREE.Group();
    const coatMaterial = makeMaterial(0x6b3f2d, 1);
    const coatBody = new THREE.Mesh(new THREE.ConeGeometry(0.78, 1.55, 7, 1, true), coatMaterial);
    coatBody.position.set(0, 1.16, 0);
    coatBody.rotation.z = Math.PI;
    coatBody.castShadow = true;
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.13, 5, 8), makeMaterial(0x9b7254, 1));
    collar.position.set(0, 1.82, 0);
    collar.rotation.x = Math.PI / 2;
    coat.add(coatBody, collar);
    coat.visible = false;
    fallback.add(coat);

    // A single pivot owns every weapon view. The pivot is reparented from the
    // fallback character to the animated hand slot after the GLB loads, so a
    // future weapon replacement only needs a new view under this mount.
    const weaponMount = new THREE.Group();
    weaponMount.name = "PlayerWeaponMount";
    weaponMount.position.set(0.55, 1.12, -0.46);
    weaponMount.rotation.z = -0.35;
    group.add(weaponMount);

    const knife = this.createKnifeView();
    weaponMount.add(knife);
    const spear = this.createSpearView();
    spear.visible = false;
    weaponMount.add(spear);

    const carriedWood = this.createItemView({ kind: "wood" } as GroundItem);
    carriedWood.position.set(-0.1, 1.6, 0.75);
    carriedWood.scale.setScalar(0.8);
    carriedWood.visible = false;
    group.add(carriedWood);
    const carriedStone = this.createItemView({ kind: "stone" } as GroundItem);
    carriedStone.position.set(-0.1, 1.55, 0.75);
    carriedStone.scale.setScalar(0.85);
    carriedStone.visible = false;
    group.add(carriedStone);
    return { group, fallback, carriedWood, carriedStone, weaponMount, knife, spear, coat };
  }

  /** Default one-handed weapon. Its origin is the grip point used by handslot.r. */
  private createKnifeView(): THREE.Group {
    const knife = new THREE.Group();
    knife.name = "SurvivalKnife";

    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.105, 0.42, 7),
      makeMaterial(0x4b3023, 0.92),
    );
    handle.position.y = -0.08;
    const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 7), makeMaterial(0x8a6842, 0.72));
    pommel.position.y = -0.32;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.07, 0.1), makeMaterial(0x75644f, 0.58));
    guard.position.y = 0.15;

    const bladeShape = new THREE.Shape();
    bladeShape.moveTo(-0.11, 0);
    bladeShape.lineTo(0.14, 0);
    bladeShape.lineTo(0.09, 0.78);
    bladeShape.lineTo(0, 0.95);
    bladeShape.lineTo(-0.07, 0.77);
    bladeShape.closePath();
    const blade = new THREE.Mesh(
      new THREE.ExtrudeGeometry(bladeShape, { depth: 0.055, bevelEnabled: false }),
      new THREE.MeshStandardMaterial({ color: 0xb8c1bd, roughness: 0.42, metalness: 0.52, flatShading: true }),
    );
    blade.position.set(0, 0.17, -0.0275);

    knife.add(handle, pommel, guard, blade);
    knife.traverse((object) => {
      if (object instanceof THREE.Mesh) object.castShadow = true;
    });
    return knife;
  }

  /** Upgraded two-handed weapon; shares the same grip-space origin as the knife. */
  private createSpearView(): THREE.Group {
    const spear = new THREE.Group();
    spear.name = "IronSpear";
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 2.45, 6), makeMaterial(0x60442d, 1));
    shaft.position.y = 0.72;
    shaft.castShadow = true;
    const point = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.55, 5), makeMaterial(0x8b9693, 0.65));
    point.position.y = 2.22;
    point.castShadow = true;
    spear.add(shaft, point);
    return spear;
  }

  /**
   * KayKit 的人物和动画分开发布，但都使用 Rig_Medium。
   * 动画轨道会按骨骼名绑定到人物，武器则挂到官方预留的 handslot.r。
   */
  private async loadPlayerAsset(): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    // GitHub Pages serves the game from a project subdirectory. Resolve assets
    // from Vite's configured base instead of the site root so the model does
    // not 404 and fall back to the procedural player in production.
    const assetRoot = `${import.meta.env.BASE_URL}assets/characters/kaykit`;
    try {
      const [character, movement, general, combat] = await Promise.all([
        loader.loadAsync(`${assetRoot}/Rogue_Hooded.glb`),
        loader.loadAsync(`${assetRoot}/Rig_Medium_MovementBasic.glb`),
        loader.loadAsync(`${assetRoot}/Rig_Medium_General.glb`),
        loader.loadAsync(`${assetRoot}/Rig_Medium_CombatMelee.glb`),
      ]);

      const model = character.scene;
      model.name = "KayKit_Rogue_Hooded";
      const bounds = new THREE.Box3().setFromObject(model);
      const sourceHeight = Math.max(0.001, bounds.max.y - bounds.min.y);
      const modelScale = 2.6 / sourceHeight;
      model.scale.setScalar(modelScale);
      model.position.y = -bounds.min.y * modelScale;
      // KayKit 人物原始朝向为 +Z；游戏内逻辑的正面是 +X。
      model.rotation.y = Math.PI / 2;

      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = true;
        object.frustumCulled = false;
        const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
        const clonedMaterials = sourceMaterials.map((material) => material.clone());
        object.material = Array.isArray(object.material) ? clonedMaterials : clonedMaterials[0];
        for (const material of clonedMaterials) {
          if (material instanceof THREE.MeshStandardMaterial) this.playerModelMaterials.add(material);
        }
      });

      this.playerModel = model;
      this.playerCape = model.getObjectByName("RogueHooded_Cape") ?? null;
      if (this.playerCape) this.playerCape.visible = this.simulation.player.armor !== "none";
      this.playerFallback.visible = false;
      this.playerGroup.add(model);
      this.attachPlayerWeapons(model);

      this.playerMixer = new THREE.AnimationMixer(model);
      const clips = [...movement.animations, ...general.animations, ...combat.animations];
      for (const clip of clips) {
        if (!clip.name || clip.name === "T-Pose") continue;
        this.playerActions.set(clip.name, this.playerMixer.clipAction(clip));
      }
      this.playPlayerAnimation("Idle_A");
    } catch (error) {
      console.warn("KayKit player failed to load; keeping the procedural fallback.", error);
    }
  }

  private attachPlayerWeapons(model: THREE.Object3D): void {
    const rightHandSlot = model.getObjectByName("handslot.r") ?? model.getObjectByName("hand.r");
    if (!rightHandSlot) return;

    rightHandSlot.add(this.weaponMount);
    // KayKit's handslot.r sits just beyond the fingertips. Pull the shared
    // grip pivot back to the palm centre so handles pass through the hand
    // instead of appearing to float beside it. This offset is expressed in
    // handslot-local space and is shared by every weapon view.
    this.weaponMount.position.set(-0.096, 0, 0.058);
    this.weaponMount.rotation.set(0, 0, 0);
    this.weaponMount.scale.setScalar(0.86);
  }

  private playPlayerAnimation(name: string, oneShot = false, speed = 1): void {
    const action = this.playerActions.get(name);
    if (!action || this.currentPlayerAnimation === name) return;

    const fadeDuration = oneShot ? 0.04 : 0.12;
    this.currentPlayerAction?.fadeOut(fadeDuration);
    action.reset();
    action.enabled = true;
    action.clampWhenFinished = oneShot;
    action.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, oneShot ? 1 : Infinity);
    action.setEffectiveTimeScale(speed);
    action.setEffectiveWeight(1);
    action.fadeIn(fadeDuration).play();
    this.currentPlayerAction = action;
    this.currentPlayerAnimation = name;
  }

  private syncPlayerAnimation(delta: number, moving: boolean): void {
    if (!this.playerMixer) return;
    const player = this.simulation.player;

    if (player.attackFlash > 0) {
      const attackName = player.weapon === "iron-spear" ? "Melee_2H_Attack_Stab" : "Melee_1H_Attack_Chop";
      const attack = this.playerActions.get(attackName);
      const speed = attack ? attack.getClip().duration / 0.22 : 1;
      this.playPlayerAnimation(attackName, true, speed);
    } else if (player.hurtFlash > 0) {
      const hit = this.playerActions.get("Hit_A");
      const speed = hit ? hit.getClip().duration / 0.3 : 1;
      this.playPlayerAnimation("Hit_A", true, speed);
    } else if (moving) {
      this.playPlayerAnimation("Running_A", false, 1.15);
    } else if (player.resting) {
      this.playPlayerAnimation("Idle_B", false, 0.55);
    } else {
      this.playPlayerAnimation("Idle_A");
    }
    this.playerMixer.update(delta);
  }

  /** 风沙：贴地横向吹，而不是从天上落下来。 */
  private buildSand(): THREE.Points {
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

  private syncPlayer(delta: number): void {
    const player = this.simulation.player;
    const movedDistance = Math.hypot(
      player.x - this.previousPlayerPosition.x,
      player.z - this.previousPlayerPosition.y,
    );
    const moving = movedDistance > Math.max(0.004, delta * 0.05);
    this.previousPlayerPosition.set(player.x, player.z);
    const restingHeight = player.resting ? (this.playerModel ? -0.12 : -0.5) : 0;
    const idleBob = this.playerModel ? 0 : player.resting ? Math.sin(this.time * 2) * 0.012 : Math.sin(this.time * 9) * 0.025;
    this.playerGroup.position.set(player.x, this.worldHeight(player.x, player.z) + restingHeight + idleBob, player.z);
    const angle = -Math.atan2(player.facing.z, player.facing.x);
    this.playerGroup.rotation.y = angle;
    const attackProgress = player.attackFlash > 0 ? 1 - player.attackFlash / 0.22 : 0;
    this.knife.visible = player.weapon === "survival-knife";
    this.spear.visible = player.weapon === "iron-spear";
    if (!this.playerModel) {
      this.weaponMount.rotation.z = -0.35 - Math.sin(attackProgress * Math.PI) * 1.7;
    }
    // 枯木已改为背包物品，手上不再显示；carriedWood 保留给放置物预览复用。
    this.carriedWood.visible = false;
    this.carriedStone.visible = player.carrying === "stone";
    this.playerCoat.visible = player.armor !== "none" && !this.playerModel;
    if (this.playerCape) this.playerCape.visible = player.armor !== "none";
    const hurt = player.hurtFlash > 0;
    this.playerBodyMaterial.color.setHex(hurt ? 0xe4544d : 0x2f7b8d);
    for (const material of this.playerModelMaterials) {
      material.emissive.setHex(hurt ? 0x5b100c : 0x000000);
      material.emissiveIntensity = hurt ? 0.8 : 0;
    }
    if (hurt) this.cameraShake = Math.max(this.cameraShake, 0.13);
    const targetScaleY = this.playerModel ? 1 : player.resting ? 0.74 : player.attackFlash > 0 ? 0.93 : 1;
    this.playerGroup.scale.y = lerp(this.playerGroup.scale.y, targetScaleY, delta * 15);
    this.syncPlayerAnimation(delta, moving);
  }

  private syncItems(): void {
    for (const item of this.simulation.items) {
      let view = this.itemViews.get(item.id);
      if (view && view.userData.kind !== item.kind) {
        this.scene.remove(view);
        this.itemViews.delete(item.id);
        view = undefined;
      }
      if (!view) {
        view = this.createItemView(item);
        this.scene.add(view);
        this.itemViews.set(item.id, view);
      }
      view.visible = item.active;
      if (!item.active) continue;
      view.position.set(item.x, this.worldHeight(item.x, item.z) + (item.kind === "wood" ? 0.35 : 0.48), item.z);
      view.rotation.y = item.rotation;
      const damageScale = clamp(item.hp / (item.kind === "stone" ? 220 : 70), 0.55, 1);
      view.scale.setScalar(item.placed ? damageScale : 1);
    }
  }

  private createItemView(item: GroundItem): THREE.Object3D {
    let view: THREE.Object3D;
    if (item.kind === "wood") {
      const group = new THREE.Group();
      const material = makeMaterial(0x65432d, 1);
      for (let index = 0; index < 2; index += 1) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 1.65, 7), material);
        log.rotation.z = Math.PI / 2;
        log.position.z = (index - 0.5) * 0.38;
        log.castShadow = true;
        group.add(log);
      }
      view = group;
    } else {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7, 0), makeMaterial(0x748084, 1));
      mesh.scale.set(2.15, 1.32, 1.7);
      mesh.castShadow = true;
      group.add(mesh);
      view = group;
    }
    view.userData.kind = item.kind;
    return view;
  }

  private syncCacti(): void {
    for (const patch of this.simulation.cacti) {
      const view = this.cactusViews.get(patch.id);
      // 割光的仙人掌整株隐藏，等它自己长回来。
      if (view) view.visible = patch.juice > 0;
    }
  }

  private syncIronNodes(): void {
    for (const node of this.simulation.ironNodes) {
      const view = this.ironViews.get(node.id);
      if (!view) continue;
      view.visible = node.ore > 0;
      if (node.ore > 0) view.scale.setScalar(0.78 + node.ore * 0.09);
    }
  }

  /** 井顶水珠 = 剩余格数，枯井整体矮一截。两个信号叠加，远近都读得出来。 */
  private syncWells(delta: number): void {
    this.wellBob = (this.wellBob + delta) % (Math.PI * 2);
    for (const well of this.simulation.wells) {
      const view = this.wellViews.get(well.id);
      if (view) view.scale.setScalar(well.charges > 0 ? 1 : 0.9);
      const pips = this.wellPips.get(well.id);
      if (!pips) continue;
      for (let index = 0; index < pips.length; index += 1) {
        const filled = index < well.charges;
        pips[index].visible = filled;
        if (filled) pips[index].position.y = 2.55 + Math.sin(this.wellBob * 1.6 + index * 0.7) * 0.09;
      }
    }
  }

  /**
   * 放置物按需建视图 —— 它们是运行时才出现的，不能像地形那样一次性建完。
   * 火窖灭掉时只熄火焰、留下石圈，因为它还能再添柴复燃。
   */
  private syncStructures(): void {
    for (const structure of this.simulation.structures) {
      let view = this.structureViews.get(structure.id);
      if (!view) {
        view = structure.kind === "campfire" ? this.createCampfireView(structure.id) : this.createStakeView();
        view.position.set(structure.x, this.worldHeight(structure.x, structure.z), structure.z);
        view.rotation.y = structure.rotation;
        this.scene.add(view);
        this.structureViews.set(structure.id, view);
      }
      view.visible = structure.active;
      const flame = this.structureFlames.get(structure.id);
      if (flame) flame.visible = structure.active && structure.fuel > 0;
      // 被啃过的树桩矮下去一截，远处也能看出防线快破了。
      if (structure.kind === "stake") {
        view.scale.y = 0.55 + (structure.hp / structure.maxHp) * 0.45;
      }
    }
  }

  private createCampfireView(id: number): THREE.Group {
    const group = new THREE.Group();
    const stoneMaterial = makeMaterial(0x7d7266, 1);
    for (let index = 0; index < 7; index += 1) {
      const angle = (index / 7) * Math.PI * 2;
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.26, 0), stoneMaterial);
      stone.position.set(Math.cos(angle) * 0.95, 0.16, Math.sin(angle) * 0.95);
      stone.castShadow = true;
      group.add(stone);
    }
    const logs = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 1.25, 6), makeMaterial(0x5d452c, 1));
    logs.rotation.z = Math.PI / 2;
    logs.position.y = 0.24;
    group.add(logs);

    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.0, 7), new THREE.MeshStandardMaterial({
      color: 0xff8a2b, emissive: 0xff5a12, emissiveIntensity: 1.5, roughness: 0.5,
    }));
    flame.position.y = 0.82;
    group.add(flame);
    const light = new THREE.PointLight(0xff9a45, 2.1, 16, 2);
    light.position.y = 1.1;
    flame.add(light);
    this.structureFlames.set(id, flame);
    return group;
  }

  private createStakeView(): THREE.Group {
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

  private syncCritters(delta: number): void {
    const liveIds = new Set<number>();
    for (const critter of this.simulation.critters) {
      liveIds.add(critter.id);
      let view = this.critterViews.get(critter.id);
      if (!view) {
        view = this.createCritterView(critter);
        this.critterViews.set(critter.id, view);
        this.scene.add(view.group);
      }
      const spec = CRITTER_SPECS[critter.kind];
      const terrainY = this.worldHeight(critter.x, critter.z);
      view.group.position.set(critter.x, terrainY, critter.z);
      view.group.rotation.y = -Math.atan2(critter.facing.z, critter.facing.x);
      if (critter.mode === "dead") {
        // 侧翻缩小，和狼的死亡表现一致。
        view.group.rotation.z = lerp(view.group.rotation.z, Math.PI / 2, delta * 8);
        view.group.scale.setScalar(clamp(critter.deathTimer / 0.7, 0, 1) * spec.scale);
      } else {
        view.group.rotation.z = 0;
        view.group.scale.setScalar(spec.scale);
        // 使用连续的落脚曲线，避免 abs(sin) 在触地瞬间形成尖角，看起来像模型发抖。
        // 骆驼体型大、腿长，步态应比小动物更沉稳；吃草时基本保持贴地。
        const isCamel = critter.kind === "camel";
        const bounce = isCamel
          ? (critter.mode === "flee" ? 0.045 : 0.004)
          : (critter.mode === "flee" ? 0.07 : 0.012);
        const rate = isCamel
          ? (critter.mode === "flee" ? 7 : 1.6)
          : (critter.mode === "flee" ? 10 : 2.5);
        const stride = (1 - Math.cos(this.time * rate + critter.id * 0.83)) * 0.5;
        view.group.position.y = terrainY + stride * bounce;
      }
      view.bodyMaterial.color.setHex(critter.hurtFlash > 0 ? 0xe04a46 : CRITTER_COLORS[critter.kind].body);
    }
    for (const [id, view] of this.critterViews) {
      if (liveIds.has(id)) continue;
      this.scene.remove(view.group);
      view.bodyMaterial.dispose();
      this.critterViews.delete(id);
    }
  }

  private createCritterView(critter: CritterState): CritterView {
    const palette = CRITTER_COLORS[critter.kind];
    const bodyMaterial = makeMaterial(palette.body, 0.95);
    const accentMaterial = makeMaterial(palette.accent, 0.9);
    const group = new THREE.Group();
    switch (critter.kind) {
      case "camel": buildCamel(group, bodyMaterial, accentMaterial); break;
      case "lizard": buildLizard(group, bodyMaterial, accentMaterial); break;
      case "hare": buildHare(group, bodyMaterial, accentMaterial); break;
      case "vulture": buildVulture(group, bodyMaterial, accentMaterial); break;
      case "gerbil":
      case "rat": buildRodent(group, bodyMaterial, accentMaterial); break;
      case "beetle": buildBeetle(group, bodyMaterial, accentMaterial); break;
      case "sandworm": buildSandworm(group, bodyMaterial); break;
    }
    return { group, bodyMaterial };
  }

  private syncWolves(delta: number): void {
    const liveIds = new Set<number>();
    for (const wolf of this.simulation.wolves) {
      liveIds.add(wolf.id);
      let view = this.wolfViews.get(wolf.id);
      if (!view) {
        view = this.createWolfView(wolf);
        this.wolfViews.set(wolf.id, view);
        this.scene.add(view.group);
      }
      view.group.position.set(wolf.x, this.worldHeight(wolf.x, wolf.z) + (wolf.mode === "dead" ? 0.2 : 0), wolf.z);
      view.group.rotation.y = -Math.atan2(wolf.facing.z, wolf.facing.x);
      const kindScale = wolfScale(wolf);
      if (wolf.mode === "dead") {
        view.group.rotation.z = lerp(view.group.rotation.z, Math.PI / 2, delta * 8);
        view.group.scale.setScalar(clamp(wolf.deathTimer / 0.8, 0, 1) * kindScale);
      } else {
        view.group.rotation.z = 0;
        view.group.scale.setScalar(kindScale);
        // 只在地形高度之上叠加步态。直接赋成 0~0.04 会把狼埋到地形内部。
        const stride = (1 - Math.cos(this.time * 8 + wolf.id * 0.83)) * 0.5;
        view.group.position.y += stride * 0.04;
      }
      view.bodyMaterial.color.setHex(
        wolf.hurtFlash > 0 ? 0xe04a46 : wolf.mode === "retreating" ? 0x7d9094 : wolfBodyColor(wolf),
      );
      view.bodyMaterial.emissive.setHex(wolf.mode === "chase" ? 0x160000 : 0x000000);
    }
    for (const [id, view] of this.wolfViews) {
      if (liveIds.has(id)) continue;
      this.scene.remove(view.group);
      view.bodyMaterial.dispose();
      this.wolfViews.delete(id);
    }
  }

  private syncDrops(): void {
    const liveIds = new Set<number>();
    for (const drop of this.simulation.drops) {
      if (!drop.active) continue;
      liveIds.add(drop.id);
      let view = this.dropViews.get(drop.id);
      if (!view) {
        view = this.createDropView(drop);
        this.dropViews.set(drop.id, view);
        this.scene.add(view);
      }
      const age = this.simulation.elapsed - drop.createdAt;
      const burst = clamp(age / 0.42, 0, 1);
      const hop = Math.sin(burst * Math.PI) * 1.15;
      view.position.set(drop.x, this.worldHeight(drop.x, drop.z) + 0.25 + hop, drop.z);
      view.rotation.y = drop.burstAngle + this.time * 0.8;
      const timeLeft = drop.expiresAt - this.simulation.elapsed;
      view.visible = timeLeft > 20 || Math.floor(this.time * 7) % 2 === 0;
    }
    for (const [id, view] of this.dropViews) {
      if (liveIds.has(id)) continue;
      this.scene.remove(view);
      this.dropViews.delete(id);
    }
  }

  private createDropView(drop: WorldDrop): THREE.Object3D {
    if (drop.kind === "hide") {
      const hide = new THREE.Mesh(new THREE.CircleGeometry(0.62, 5), makeMaterial(0x7a4931, 1));
      hide.rotation.x = -Math.PI / 2;
      hide.scale.set(1.25, 0.82, 1);
      hide.castShadow = true;
      return hide;
    }
    const group = new THREE.Group();
    const meat = new THREE.Mesh(new THREE.DodecahedronGeometry(0.42, 0), makeMaterial(0x9e3f3d, 0.9));
    meat.scale.set(1.25, 0.65, 0.9);
    meat.castShadow = true;
    group.add(meat);
    const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.82, 6), makeMaterial(0xd7c8ad, 1));
    bone.rotation.z = Math.PI / 2;
    bone.position.y = 0.08;
    group.add(bone);
    return group;
  }

  private createWolfView(wolf: WolfState): WolfView {
    const group = new THREE.Group();
    const bodyMaterial = makeMaterial(wolfBodyColor(wolf), 0.95);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 1.05, 3, 5), bodyMaterial);
    body.rotation.z = Math.PI / 2;
    body.position.set(0, 0.75, 0);
    body.scale.set(1, 1, 0.82);
    body.castShadow = true;
    group.add(body);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.85, 5), bodyMaterial);
    head.rotation.z = -Math.PI / 2;
    head.position.set(0.95, 0.88, 0);
    head.castShadow = true;
    group.add(head);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.85, 5), bodyMaterial);
    tail.rotation.z = Math.PI / 2.35;
    tail.position.set(-0.85, 0.88, 0);
    group.add(tail);
    const eyeMaterial = new THREE.MeshBasicMaterial({ color: wolfEyeColor(wolf) });
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 5, 4), eyeMaterial);
    eye.position.set(1.12, 0.98, 0.29);
    group.add(eye);
    return { group, bodyMaterial };
  }

  private syncFires(): void {
    let nearestLit: CampDefinition | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const camp of this.world.camps) {
      const view = this.campViews.get(camp.id);
      if (!view) continue;
      const fuel = this.simulation.camps[camp.id].fuel;
      const lit = fuel > 0;
      view.flame.visible = lit;
      view.glow.visible = lit;
      if (!lit) continue;
      const flutter = 0.86 + Math.sin(this.time * 12 + camp.id * 2.3) * 0.12 + Math.sin(this.time * 19) * 0.05;
      const fuelScale = clamp(fuel / 70, 0.42, 1);
      view.flame.scale.set(flutter * fuelScale, (1.05 / flutter) * fuelScale, flutter * fuelScale);
      view.glow.material.opacity = 0.07 + fuelScale * 0.07;
      const value = (camp.x - this.simulation.player.x) ** 2 + (camp.z - this.simulation.player.z) ** 2;
      if (value < nearestDistance) {
        nearestDistance = value;
        nearestLit = camp;
      }
    }
    if (nearestLit && nearestDistance < 32 * 32) {
      this.fireLight.position.set(nearestLit.x, this.worldHeight(nearestLit.x, nearestLit.z) + 2.4, nearestLit.z);
      this.fireLight.intensity = 3.2 + Math.sin(this.time * 14) * 0.3;
    } else {
      this.fireLight.intensity = 0;
    }
  }

  private syncDayNight(): void {
    const daylight = this.simulation.getDaylight();
    // 沙漠昼夜温差极大，配色也走两个极端：
    // 白天是被尘霾漂白的暖黄，夜晚是冷到发青的深蓝 —— 视觉上直接对应体温轴的两端。
    const sky = new THREE.Color().lerpColors(new THREE.Color(0x2c3d5c), new THREE.Color(0xd8bf8d), daylight);
    this.scene.background = sky;
    if (this.scene.fog) this.scene.fog.color.copy(sky);
    this.hemisphere.color.lerpColors(new THREE.Color(0x8fa6cf), new THREE.Color(0xffeec4), daylight);
    this.hemisphere.groundColor.lerpColors(new THREE.Color(0x3a4356), new THREE.Color(0x8a6a44), daylight);
    // 夜晚半球光强度从 1.34 提到 1.85，让地形细节可见
    this.hemisphere.intensity = lerp(1.85, 2.2, daylight);
    this.sun.color.lerpColors(new THREE.Color(0xa8bce0), new THREE.Color(0xfff0cc), daylight);
    // 夜晚太阳（当作月光）强度从 0.82 提到 1.45，地面不再糊成一片
    this.sun.intensity = lerp(1.45, 3.2, daylight);
    // 夜晚曝光略提，让篝火光圈外也能辨识
    this.renderer.toneMappingExposure = lerp(1.12, 1.05, daylight);
  }

  private updateCamera(delta: number): void {
    const player = this.simulation.player;
    const smoothing = 1 - Math.exp(-delta * 5.5);
    this.cameraFocus.x = lerp(this.cameraFocus.x, player.x, smoothing);
    this.cameraFocus.z = lerp(this.cameraFocus.z, player.z, smoothing);
    this.cameraFocus.y = lerp(this.cameraFocus.y, this.worldHeight(player.x, player.z), smoothing);
    const distanceScale = window.innerWidth < 760 && window.innerWidth < window.innerHeight ? 1.18 : 1;
    const shakeX = (Math.random() - 0.5) * this.cameraShake;
    const shakeZ = (Math.random() - 0.5) * this.cameraShake;
    this.camera.position.set(
      this.cameraFocus.x + 19 * distanceScale + shakeX,
      this.cameraFocus.y + 24 * distanceScale,
      this.cameraFocus.z + 19 * distanceScale + shakeZ,
    );
    this.camera.lookAt(this.cameraFocus.x, this.cameraFocus.y + 0.8, this.cameraFocus.z);
    this.cameraShake = Math.max(0, this.cameraShake - delta * 0.8);
    this.sun.position.set(this.cameraFocus.x - 35, this.cameraFocus.y + 55, this.cameraFocus.z + 25);
    this.sun.target.position.set(this.cameraFocus.x, this.cameraFocus.y, this.cameraFocus.z);
    this.sun.target.updateMatrixWorld();
  }

  private updateSand(delta: number): void {
    const attribute = this.sand.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    for (let index = 0; index < attribute.count; index += 1) {
      const offset = index * 3;
      // 主风向横吹，垂直方向只有很轻的起伏，越贴地的沙粒跑得越快。
      const gust = 7.5 + (index % 11) * 0.85;
      array[offset] += delta * gust;
      array[offset + 1] += delta * Math.sin(this.time * 1.7 + index) * 0.35;
      array[offset + 2] += delta * (gust * 0.34);
      if (array[offset] > 35 || array[offset + 2] > 35) {
        array[offset] = -35 - Math.random() * 6;
        array[offset + 1] = Math.pow(Math.random(), 2.4) * 9;
        array[offset + 2] = (Math.random() - 0.5) * 70;
      }
    }
    attribute.needsUpdate = true;
    this.sand.position.set(this.cameraFocus.x, this.cameraFocus.y, this.cameraFocus.z);
    const material = this.sand.material as THREE.PointsMaterial;
    // 和飘雪相反：白天日晒起风，沙尘最浓；夜里风停，几乎看不见。
    material.opacity = lerp(0.14, 0.5, this.simulation.getDaylight());
  }

  private worldHeight(x: number, z: number): number {
    return terrainHeightAt(this.world, { x, z });
  }
}
