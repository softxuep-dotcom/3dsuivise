import * as THREE from "three";
import type { RenderStats } from "../ui/PerfOverlay";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { GameSimulation } from "../game/simulation/GameSimulation";
import { clamp, lerp, mulberry32 } from "../game/simulation/geometry";
import type { CampDefinition, CritterState, GroundItem, Vec2, WeaponKind, WolfState, WorldDefinition, WorldDrop } from "../game/simulation/types";
import { BARRIER_STATS, CRITTER_SPECS, FUEL_REQUIRED } from "../game/simulation/types";
import { distanceToCampApproach, terrainHeightAt, terrainMoistureAt, terrainSaltAt, terrainSlopeAt } from "../game/terrain/TerrainModel";
import { instantiateAnimal, loadAnimal, type AnimalAsset, type AnimalInstance } from "./AnimalModels";
import { createCritterMesh } from "./CritterModels";

interface CampView {
  flame: THREE.Group;
  glow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
}

interface ItemRenderState {
  kind: GroundItem["kind"];
  active: boolean;
  placed: boolean;
  x: number;
  z: number;
  hp: number;
  rotation: number;
  flash: number;
}

interface WolfView {
  group: THREE.Group;
  /** Quaternius 狼的实例；资源没加载成功时是 null，此时 group 里是程序化替身。 */
  animal: AnimalInstance | null;
  /** 受击闪红要作用到的材质。狼模型有毛色与腹面两份，替身只有一份。 */
  tinted: THREE.MeshStandardMaterial[];
  /** 上一帧的世界坐标；模型朝向与步态都以真实位移为准，不直接照搬寻路的瞬时 facing。 */
  lastPosition: THREE.Vector2;
  /** 已平滑的显示朝向。狼停住时保持这个角度，避免原地左右甩身。 */
  visualHeading: number;
  /** 真实移动方向的低通结果；寻路连续左右试探时不会把抖动直接传给模型。 */
  travelDirection: THREE.Vector2;
  /** 0..1 的移动权重，给起步与停步留一个很短的缓冲。 */
  moveAmount: number;
  /** 头顶血条：受伤后短暂浮现。挂在场景根上而不是狼身上，免得继承死亡侧翻。 */
  bar: THREE.Group;
  barFill: THREE.Sprite;
  /** 血条剩余显示秒数。 */
  barTimer: number;
  /** 上一帧的血量，用来发现"这一刻挨打了"。 */
  lastHealth: number;
}

/**
 * 血条自己的尺度，**不复用 wolfScale**。
 *
 * wolfScale 的含义已经从"几何倍率"改成"世界高度"（1.15 / 1.7 / 2.7），
 * 直接拿去乘血条，头犬的血条会跟着长到近三倍宽、飘到头顶两米以上。
 * 这里保留接近原来的那组倍率，只留下"越大的狗血条越宽"这一点。
 */
/** 相机距离系数。竖屏拉远补视野，横屏拉近补可读性 —— 见 updateCamera。 */
const PORTRAIT_CAMERA_SCALE = 1.08;
const LANDSCAPE_CAMERA_SCALE = 0.64;

/** 可搬运物的本色，以及被啃到快碎时染向的暗红。 */
const STONE_COLOR = 0x748084;
const WOOD_COLOR = 0x65432d;
const BARRIER_DAMAGE_TINT = new THREE.Color(0x47231c);
const ITEM_UP = new THREE.Vector3(0, 1, 0);
const HIDDEN_ITEM_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * 地上的一捆枯木原来是两个独立 Mesh，也就是每捆两次 draw call。
 * 合并的只是渲染几何，碰撞和拾取仍然完全由 GroundItem 决定。
 */
const createWoodItemGeometry = (): THREE.BufferGeometry => {
  const logs = [-0.19, 0.19].map((z) => {
    const geometry = new THREE.CylinderGeometry(0.22, 0.26, 1.65, 7);
    geometry.rotateZ(Math.PI / 2);
    geometry.translate(0, 0, z);
    return geometry;
  });
  const merged = mergeGeometries(logs);
  for (const geometry of logs) geometry.dispose();
  return merged;
};

/** 石头原来的非均匀缩放烘进共享几何，实例矩阵只负责世界位置、朝向和耐久缩放。 */
const createStoneItemGeometry = (): THREE.BufferGeometry => {
  const geometry = new THREE.DodecahedronGeometry(0.7, 0);
  geometry.scale(2.15, 1.32, 1.7);
  return geometry;
};

const WOOD_ITEM_GEOMETRY = createWoodItemGeometry();

/*
 * 共享几何与材质：**参数是常量的，就不该每个实例现造一份。**
 *
 * 起因是真机读数：白天 geo 215，35 秒后的夜里 geo 414 —— 几何体数量翻了一倍。
 * renderer.info.memory.geometries **只在 dispose() 时才减**，而这份代码里
 * 一处几何体的 dispose 都没有（除了 createWoodItemGeometry 末尾那次合并清理）。
 *
 * 最大的漏点是掉落物：createDropView 每次都新建 CircleGeometry /
 * DodecahedronGeometry / CylinderGeometry，而它们三个的参数全是常量；
 * 掉落视图过期时只从场景里移除、材质和几何都不回收。按注释自己的说法
 * 「夜里一场仗能掉几十份肉皮牙」，一局下来就是几百个泄漏的 GPU 缓冲。
 *
 * 修法不是补 dispose，是**共享** —— 共享的东西本来就不该被回收，
 * 顺带把 draw call 之外的另一项（缓冲数量与显存）也压下去。
 * 仙人掌的刺与矿脉的棱柱同理：形状逐个都一样，只是摆放不同。
 *
 * 主干和手臂原先因为"每株高度随机"留在了原地，现在也提上来了：随机的只是
 * **高度**，而高度可以交给实例矩阵在 Y 上缩放表达，见 CACTUS_TRUNK_* 那两段。
 */
const DROP_HIDE_GEOMETRY = new THREE.CircleGeometry(0.62, 5);
const DROP_MEAT_GEOMETRY = new THREE.DodecahedronGeometry(0.42, 0);
const DROP_BONE_GEOMETRY = new THREE.CylinderGeometry(0.07, 0.07, 0.82, 6);
const CACTUS_SPINE_GEOMETRY = new THREE.ConeGeometry(0.04, 0.2, 4);
const CACTUS_ELBOW_GEOMETRY = new THREE.CapsuleGeometry(0.18, 0.34, 3, 6);
const CACTUS_FLOWER_GEOMETRY = new THREE.IcosahedronGeometry(0.16, 0);

/*
 * 主干与手臂的基准胶囊。
 *
 * 每株的高度仍然是随机的（主干 1.6~2.5、手臂 0.55~0.95），但不再各造一份几何 ——
 * 取区间中点做基准，逐株用实例矩阵在 Y 上缩放。CapsuleGeometry 的总高是
 * `height + 2 × radius`，所以缩放比取 `(目标总高) / (基准总高)`。
 *
 * 代价是两端的半球会跟着在 Y 上被拉长或压扁：主干缩放比落在 0.83~1.17 之间，
 * 半球的竖直半径因此在 0.25~0.35 之间浮动（原本恒为 0.3）。这是几厘米的事，
 * 摊在一株两三米高、七面体的低模仙人掌上看不出来 —— 而换到的是
 * 「32 株 288 个 Mesh」变成「5 个 InstancedMesh」。
 */
const CACTUS_TRUNK_RADIUS = 0.3;
const CACTUS_TRUNK_BASE_HEIGHT = 2.05;
const CACTUS_TRUNK_GEOMETRY = new THREE.CapsuleGeometry(CACTUS_TRUNK_RADIUS, CACTUS_TRUNK_BASE_HEIGHT, 3, 7);
const CACTUS_ARM_RADIUS = 0.18;
const CACTUS_ARM_BASE_HEIGHT = 0.75;
const CACTUS_ARM_GEOMETRY = new THREE.CapsuleGeometry(CACTUS_ARM_RADIUS, CACTUS_ARM_BASE_HEIGHT, 3, 6);

/**
 * 一株仙人掌的五个合批。每株的九个部件散在这五个批次里，槽位由 cactusSlots 给。
 * 一株 = 主干 1 + 手臂 2 + 肘 2 + 花 1 + 刺 3。
 */
interface CactusBatches {
  readonly trunks: THREE.InstancedMesh;
  readonly arms: THREE.InstancedMesh;
  readonly elbows: THREE.InstancedMesh;
  readonly flowers: THREE.InstancedMesh;
  readonly spines: THREE.InstancedMesh;
  /** 显隐翻转时要一起打 needsUpdate 的那五个，省得每次现拼数组。 */
  readonly all: readonly THREE.InstancedMesh[];
}

/**
 * 一株仙人掌九个部件的世界矩阵，建好就不再变（仙人掌不会移动）。
 * 割光时往实例里写零矩阵，长回来时把这些原样写回去 —— 比重算一遍便宜也短。
 */
interface CactusPlacement {
  readonly trunk: THREE.Matrix4;
  readonly arms: readonly THREE.Matrix4[];
  readonly elbows: readonly THREE.Matrix4[];
  readonly flower: THREE.Matrix4;
  readonly spines: readonly THREE.Matrix4[];
}

/**
 * 矿脉的四根棱柱。
 *
 * 高度四根各不相同（参差是"矿脉"读感的全部来源），但这四个高度对**每一个**
 * 矿脉都一样 —— 原先写在循环里，14 个矿脉造出 56 份几何，实际只需要 4 份。
 * 表和几何一起提上来，摆放参数留在原地。
 *
 * [绕 Y 的方位, 离心距, 高度, 外倾角]
 */
const IRON_SHARDS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 0.0, 2.05, 0.0],
  [1.9, 0.46, 1.42, 0.26],
  [3.6, 0.52, 1.68, 0.19],
  [5.2, 0.40, 1.15, 0.31],
];
/** 上细下粗的五棱柱：顶端收到 0.05，剪影是尖的。 */
const IRON_SHARD_GEOMETRIES = IRON_SHARDS.map(
  ([, , height]) => new THREE.CylinderGeometry(0.05, 0.3, height, 5),
);
const IRON_ORE_GEOMETRY = new THREE.OctahedronGeometry(0.34, 0);
const STONE_ITEM_GEOMETRY = createStoneItemGeometry();

/** 长角羚的沙褐主色。 */
const ORYX_COAT = 0xc19a63;

/** 动物素材下载的重试退避（毫秒）。长度 = 重试次数，所以一共尝试 3 次。 */
const ANIMAL_ASSET_RETRY_BACKOFF: readonly number[] = [700, 1800];
/** 长角羚的站立高度：2.3，比壮犬(1.7)高、比玩家(2.6)矮 —— 最值得追的那个剪影。 */
const ORYX_HEIGHT = 2.3;

/**
 * 狗的程序化替身。
 *
 * 只在 Wolf.glb 加载失败时用得上（GitHub Pages 从子目录发布，资源路径出过一次
 * 404）。**刻意做得很潦草**：它的存在意义是"别让夜里的狗变成隐形的"，
 * 不是备用美术方案 —— 做得越像，越会掩盖资源没加载成功这件事。
 */
function createFallbackDog(color: number): { mesh: THREE.Object3D; material: THREE.MeshStandardMaterial } {
  const material = makeMaterial(color, 0.95);
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.44, 3, 6), material);
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.28;
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 0.18), material);
  head.position.set(0.42, 0.36, 0);
  group.add(head);
  for (const [x, z] of [[0.24, 0.11], [0.24, -0.11], [-0.24, 0.11], [-0.24, -0.11]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.28, 4), material);
    leg.position.set(x, 0.14, z);
    group.add(leg);
  }
  return { mesh: group, material };
}

const wolfBarScale = (wolf: WolfState): number => (
  wolf.kind === "elite" ? 1.6 : wolf.kind === "large" ? 1.15 : 0.9
);

/**
 * 角色的贴地阴影（blob shadow）。
 *
 * 低功耗档不再让玩家、狼、猎物投真阴影，改成脚下贴一片圆形暗斑。
 *
 * 换掉的理由是**这档阴影本来就读不出形状**：阴影图 512²、阴影相机覆盖 ±32
 * 世界单位，也就是每米 8 texel；一只狼身长 1.5 米，落在阴影图上只有 12 texel。
 * 为这 12 个像素，深度 pass 要把 13 个骨骼网格（45 米剔除后的数量）**再蒙皮一遍** ——
 * 主 pass 一遍、阴影 pass 一遍。拿一坨读不出形状的斑点换一坨故意画的斑点，
 * 视觉上几乎不损失，省下的是整个动态深度 pass。
 *
 * 用 DataTexture 而不是 CanvasTexture，理由同 createGroundTexture：
 * 移动端 Chrome 会在后台回收游离 canvas 的后备存储，回前台重传就是一片全黑。
 */
/**
 * 低功耗档的阴影缓存。
 *
 * 角色改用贴地圆斑之后（见 createBlobShadowTexture），阴影图里**只剩静态几何** ——
 * 墙、树、地形、营地、卡车。静态的东西不需要每帧重画，只需要在阴影相机
 * 移出覆盖余量时重画一次。
 *
 * 三个数是配套的，不能单独改：
 *
 *   覆盖 ±44（原 ±32）—— 买出余量。原值是照着可视地面纵深约 60 单位定的，
 *     几乎没有富余；锚点一旦滞后就会在画面里出现一条"影子到此为止"的硬线。
 *     ±44 配 10 米的漂移余量，最坏情况下逆行方向仍覆盖 34 单位 > 30。
 *   768²（原 512²）—— 覆盖变大后维持精度。88 单位 / 768 = 每米 8.7 texel，
 *     比原来的 64/512 = 8 还略高。
 *   漂移余量 10 米 —— 玩家 8.2 米/秒，约 1.2 秒重锚一次（26fps 下约 32 帧）。
 *
 * 净账：原来每 2 帧光栅化 26 万 texel（13 万/帧摊销），现在每约 30 帧
 * 光栅化 59 万（约 2 万/帧摊销）—— **少 6 倍多，而且精度还高了一点**。
 *
 * 30 帧的强制上限是**兜底**：树被砍倒、结构物落地、卡车启动这些改变投影体的
 * 事件我都挂了钩子，但漏一个就会留下一片不该存在的影子。30 帧把任何漏网之鱼的
 * 存活时间压到 1 秒出头，而它对摊销成本几乎没有影响。
 */
const SHADOW_ANCHOR_MARGIN = 10;
const SHADOW_MAX_STALE_FRAMES = 30;
const LOW_POWER_SHADOW_EXTENT = 44;
const LOW_POWER_SHADOW_MAP = 768;

/*
 * ═══ 一次性画质上调 ═══  （要调参数的话，改这一块就够了）
 *
 * ## 它解决的是"好手机被一刀切压住"
 *
 * 移动档把 pixelRatio 钉死在 1.0。而现代旗舰手机的 devicePixelRatio 普遍是 2.5~3.5，
 * 所以 3D 画面实际是按原生 **1/9 的像素数**渲染再拉满屏 —— 屏幕最好的那批设备
 * 挨刀最狠。而它们的富余本来就浪费掉了：帧率撞在刷新率上限上，多出来的性能不产生
 * 任何收益。
 *
 * ## 为什么是"一次性、只向上"，而不是自适应梯子
 *
 * 梯子要调一堆阈值，而这些阈值只能在真机上验证 —— 手上只有一台旗舰机的话，
 * 下面那些降级档一次都跑不到，等于把一套没人验证过的机制推给最弱的那批玩家。
 *
 * 只允许**升一次、不许降**就没有这个问题：判据不满足时什么都不发生，
 * 弱机的行为和现在逐字相同；满足时也只动一次，玩家不会看见画质来回变。
 *
 * ## 两个判据必须同时成立
 *
 * 只看出帧间隔是不够的：帧率撞在 vsync 上限时，间隔恒等于刷新间隔，**读不出富余**——
 * 一台 120Hz 手机轻松跑满和勉强跑满，间隔都是 8.33ms。所以再加一条渲染耗时。
 *
 *   出帧间隔贴着刷新率  → GPU 跟得上，一帧没掉
 *   渲染耗时远低于刷新间隔 → CPU 侧确实有富余
 *
 * 两条都成立才升。前者管 GPU，后者管 CPU，缺一条都可能升错。
 */
/** 玩家真正开始玩之后先跳过这么久：着色器编译和 GLB 解析都挤在这一段。 */
const UPGRADE_WARMUP_MS = 3000;
/** 采样窗口。攒满这么久才做判断，判断完就永久收工。 */
const UPGRADE_WINDOW_MS = 3000;
/** 样本不够就不升 —— 宁可不动，也不能拿几帧下结论。 */
const UPGRADE_MIN_SAMPLES = 60;
/** 出帧间隔中位数不得超过刷新间隔的这个倍数（1.15 ≈ 允许偶尔掉一帧）。 */
const UPGRADE_MAX_INTERVAL_RATIO = 1.15;
/** 渲染耗时中位数不得超过刷新间隔的这个比例。留的余量要够 pixelRatio 抬上去之后的开销。 */
const UPGRADE_MAX_WORK_RATIO = 0.4;
/** 达标后 pixelRatio 抬到这里（仍受 devicePixelRatio 封顶）。 */
const UPGRADE_PIXEL_RATIO = 1.5;
/** 达标后阴影图抬到这里。范围 ±44 不动，所以每米 texel 数从 8.7 涨到 11.6。 */
const UPGRADE_SHADOW_MAP = 1024;

const BLOB_SHADOW_TEXTURE_SIZE = 64;
/** 同屏最多画几片。玩家 1 + 45 米内的狼与猎物，实测远不到这个数。 */
const BLOB_SHADOW_CAPACITY = 48;
/** 抬离地面多少，避免与地面 z-fighting。 */
const BLOB_SHADOW_LIFT = 0.04;
/** 估地形法线时左右各采样多远。 */
const BLOB_SHADOW_NORMAL_STEP = 0.5;
const BLOB_SHADOW_UP = new THREE.Vector3(0, 1, 0);
const BLOB_SHADOW_NORMAL = new THREE.Vector3();

const createBlobShadowTexture = (): THREE.DataTexture => {
  const size = BLOB_SHADOW_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const spread = Math.hypot(x - centre, y - centre) / centre;
      // (1 - r²)^1.6：中心实、边缘平滑归零。指数比 1 大是为了让边缘收得比线性快，
      // 免得斑点看起来像一块糊在地上的圆形污渍。
      const alpha = spread >= 1 ? 0 : Math.pow(1 - spread * spread, 1.6);
      data[index + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
};

/** 头顶血条：受伤后显示多久。够看清掉了多少，又不至于夜里几十条一直挂着。 */
const WOLF_BAR_SECONDS = 2.6;
const WOLF_BAR_WIDTH = 1.15;
const WOLF_BAR_HEIGHT = 0.15;

/** 沿最短圆弧平滑角度，跨过 ±π 时不会整圈回转。 */
const dampAngle = (current: number, target: number, speed: number, delta: number): number => {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * (1 - Math.exp(-speed * delta));
};

/**
 * 每只狼一套血条材质，不共用 —— 淡出是逐条各自算的，共用材质会让全场血条一起闪。
 * 精灵本来就不合批，两个精灵两次绘制，隐藏时直接跳过，所以这点开销是值的。
 */
const createWolfBar = (wolf: WolfState): { bar: THREE.Group; fill: THREE.Sprite } => {
  const group = new THREE.Group();
  const back = new THREE.Sprite(new THREE.SpriteMaterial({
    color: 0x0a0f13, transparent: true, opacity: 0.72, depthWrite: false,
  }));
  const fill = new THREE.Sprite(new THREE.SpriteMaterial({
    color: wolf.kind === "elite" ? 0xff8a3d : 0xe2564a, transparent: true, depthWrite: false,
  }));
  const barScale = wolfBarScale(wolf);
  back.scale.set(WOLF_BAR_WIDTH * barScale + 0.06, WOLF_BAR_HEIGHT * barScale + 0.05, 1);
  fill.scale.set(WOLF_BAR_WIDTH * barScale, WOLF_BAR_HEIGHT * barScale, 1);
  // 填充画在底板之上；两者都不写深度，避免互相打架。
  back.renderOrder = 8;
  fill.renderOrder = 9;
  group.add(back, fill);
  group.visible = false;
  return { bar: group, fill };
};

interface CritterView {
  group: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
  /** 只有长角羚用 Quaternius 的鹿；其余七种仍是程序化几何。 */
  animal: AnimalInstance | null;
  /** 没受击时该显示的颜色。程序化几何是白（顶点色自带配色），鹿是它的沙褐主色。 */
  baseColor: number;
}

const makeMaterial = (color: THREE.ColorRepresentation, roughness = 0.9): THREE.MeshStandardMaterial => (
  new THREE.MeshStandardMaterial({ color, roughness, flatShading: true })
);

/** 材质的"看起来一样吗"指纹。**按参数比，不按对象比** —— 理由见 mergeStaticGroup。 */
interface MaterialProbe {
  color?: THREE.Color;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  flatShading?: boolean;
  map?: THREE.Texture | null;
}

const materialSignature = (material: THREE.Material): string => {
  const probe = material as THREE.Material & MaterialProbe;
  return [
    material.type,
    probe.color?.getHexString() ?? "-",
    probe.emissive?.getHexString() ?? "-",
    probe.emissiveIntensity ?? "-",
    probe.roughness ?? "-",
    probe.metalness ?? "-",
    probe.flatShading ?? "-",
    probe.map?.uuid ?? "-",
    material.side,
    material.transparent,
    material.opacity,
    material.depthWrite,
    material.depthTest,
  ].join("|");
};

/**
 * 把一组"零件之间不动"的装饰按材质压成整块，一种材质一个网格。
 *
 * ## 为什么值得做
 *
 * 巢、地标、营地、铁矿、油桶、井、卡车车体，写法都一样：一个 Group 里塞十几二十个
 * 小 Mesh，每个几十到一百个顶点。它们彼此之间从建好到这一局结束不会动、不会换色、
 * 不会单独显隐 —— 也就是说这些 Mesh 之间**没有一条信息是运行时才知道的**，
 * 完全可以在建的时候就烤成一块。
 *
 * ## 关键：烤的是**组的局部坐标**
 *
 * 所以"整个组会不会动"完全无所谓。铁矿按储量整体缩放、油桶被扛走、卡车通关时开走 ——
 * 这些都写在 Group 上，合批之后照样生效。只要零件**彼此之间**不动就能合。
 *
 * ## 为什么逐个对象合，不跨对象合
 *
 * 跨对象会把整张图的巢连成一个横跨全图的网格，包围球覆盖所有地方，于是**永远进不了
 * 视锥剔除** —— 玩家在空旷沙漠里也要提交全图的装饰。逐个合两头都占：簇内的十几条塌成
 * 两三条，而"这座营地在不在画面里"仍然由 three 逐个剔除。
 *
 * ## 两个必须按参数分桶的地方
 *
 * **材质按指纹分桶，不按对象。** 石碑的三道刻痕、井口的黑面都是在循环里
 * `makeMaterial(...)` 现造的，参数完全相同却是不同对象；按对象分桶等于没合。
 *
 * **castShadow / receiveShadow 也进桶键。** 同一个 deadwood 材质，树干投影、车辕不投影，
 * 合到一起就只能二选一，画面会变。
 *
 * @param keep 这些对象（连同其子树）原样留下 —— 营火的火苗、井上的水珠这些每帧都在动。
 */
const mergeStaticGroup = (group: THREE.Object3D, keep: ReadonlySet<THREE.Object3D> = new Set()): void => {
  interface Bucket {
    material: THREE.Material;
    cast: boolean;
    receive: boolean;
    /** 合并前可能被整桶换成非索引版本，所以不是 readonly。 */
    parts: THREE.BufferGeometry[];
    sources: THREE.Mesh[];
  }
  group.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const buckets = new Map<string, Bucket>();

  const walk = (object: THREE.Object3D): void => {
    if (keep.has(object)) return;
    for (const child of [...object.children]) walk(child);
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    const key = `${materialSignature(object.material)}|${object.castShadow}|${object.receiveShadow}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material: object.material, cast: object.castShadow, receive: object.receiveShadow, parts: [], sources: [] };
      buckets.set(key, bucket);
    }
    // applyMatrix4 会连法线一起按法线矩阵变换，所以巢那些 scale(1.5, 0.5, 1) 的
    // 土脊不会因为非等比缩放而错光。
    const baked = object.geometry.clone();
    baked.applyMatrix4(local.multiplyMatrices(toLocal, object.matrixWorld));
    bucket.parts.push(baked);
    bucket.sources.push(object);
  };
  walk(group);

  for (const bucket of buckets.values()) {
    /*
     * 索引要先统一。
     *
     * mergeGeometries 要求一桶里的几何**要么全带 index、要么全不带**，否则返回 null
     * 并往控制台刷一行错。而 three 的多面体（Dodecahedron / Octahedron / Icosahedron，
     * 也就是这里的火圈石、石堆、洞穴巨石、矿石）是**非索引**的，圆柱方块球环面则都带索引 ——
     * 营地那种一个材质下既有石头又有木头的桶正好踩中。
     *
     * 混了就整桶转成非索引。这些都是 flatShading 的低模，本来就几乎没有共享顶点，
     * 展开的代价可以忽略；换来的是这些桶真的能合上。
     */
    const indexed = bucket.parts.filter((part) => part.index !== null).length;
    if (indexed > 0 && indexed < bucket.parts.length) {
      bucket.parts = bucket.parts.map((part) => {
        if (part.index === null) return part;
        const flat = part.toNonIndexed();
        part.dispose();
        return flat;
      });
    }
    // 只有一件的桶合了还是它自己，白搭一次拷贝，留原样。
    const geometry = bucket.parts.length > 1 ? mergeGeometries(bucket.parts, false) : null;
    for (const part of bucket.parts) part.dispose();
    // 万一还是合不上就放弃这一桶、保持原样 —— 宁可多几条 draw call，也不能把装饰弄丢。
    if (!geometry) continue;
    for (const source of bucket.sources) source.removeFromParent();
    const mesh = new THREE.Mesh(geometry, bucket.material);
    mesh.castShadow = bucket.cast;
    mesh.receiveShadow = bucket.receive;
    group.add(mesh);
  }
};

/**
 * 汽油桶。**整张图上唯一的锈红色**——沙丘、砾石、枯木、铁矿全是黄褐到灰的
 * 一族，所以这个色相在远处就是一个"那边有东西"的信号。没有小地图，
 * 桶能不能被看见完全取决于它在沙色里跳不跳得出来。
 */
function createBarrelView(): THREE.Group {
  const group = new THREE.Group();
  const shell = makeMaterial(0xb43a24, 0.65);
  const band = makeMaterial(0x6f2416, 0.6);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 1.18, 12), shell);
  drum.castShadow = true;
  group.add(drum);
  for (const y of [-0.3, 0.3]) {
    const hoop = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.1, 12), band);
    hoop.position.y = y;
    group.add(hoop);
  }
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.14, 8), band);
  cap.position.set(0.2, 0.62, 0);
  group.add(cap);
  return group;
}

/*
 * 开局指路的浮动箭头。
 *
 * **做成几何体而不是贴图**：场景里每一件道具都是这么搭起来的（锥、胶囊、盒子 +
 * 平直着色），一张外来的箭头贴图会是整个 3D 场景里唯一一处纹理 —— 风格上对不上，
 * 还得为一个开局十几秒就退场的东西背一张图的体积和授权。
 *
 * 尺寸和"不发光柱"这两条是照着 buildTruckBeacon 那段定的：那里拆掉过一根 26 米的
 * 加色光柱，理由是"网游任务标记那一套，和低多边形沙漠不搭，而且注定挡视野"。
 * 所以这根箭头做得小（总高 1.68 米，和人一般高）、贴着目标浮、正常参与深度测试，
 * 不做任何穿墙显示。
 *
 * 这个高度是量出来的，不是estimate：竖屏一屏见 15.6 米、375 CSS px，1 米 ≈ 24 px，
 * 而等距相机压着看，竖向还要再乘 cos(41.8°) ≈ 0.75 —— 1.68 米落到屏幕上约 30 px。
 * 上一版做 1.32 米（约 24 px），在开局那一屏里读起来像地上插了根小钉子。
 *
 * 四棱锥的头配四棱柱的柄 —— 段数取 4 是为了和仙人掌刺那些四面锥同一档面数，
 * 而且两者的顶点相位一致，接缝处不会错开。两段合成一个几何，整根一次 draw call。
 *
 * **尖端在 y=0，往上长**：摆的时候直接把"要指的那个点"交给它，不用再减半高。
 */
function createGuideArrowGeometry(): THREE.BufferGeometry {
  // 头**比自己高还宽**（半径 0.58 对高 0.66）：等距相机压着看，竖向本来就只剩
  // cos(41.8°) ≈ 0.75，头做瘦了从画面上读出来是一根钉子，不是箭头。
  const head = new THREE.ConeGeometry(0.72, 0.84, 4);
  head.rotateX(Math.PI);
  head.translate(0, 0.42, 0);
  const shaft = new THREE.CylinderGeometry(0.24, 0.24, 0.84, 4);
  // 0.84 是锥底，柄从那里接着往上长，所以中心在 0.84 + 0.84/2。
  shaft.translate(0, 1.26, 0);
  const merged = mergeGeometries([head, shaft]);
  head.dispose();
  shaft.dispose();
  if (!merged) throw new Error("guide arrow geometry merge failed");
  return merged;
}

interface BladeVisual {
  name: string;
  /** 刃宽倍率，基准是求生匕首的 0.25。 */
  width: number;
  /** 刃长倍率，基准是求生匕首的 0.95。 */
  length: number;
  /** 剑是双刃对称，刀是单刃（背侧拉直）。 */
  doubleEdged: boolean;
  color: number;
  roughness: number;
  metalness: number;
  gripColor: number;
  emissive?: number;
  emissiveIntensity?: number;
  /** 三阶长剑的独立刃口 mesh 颜色。 */
  edgeColor?: number;
  /** 剑线连击时刃身发什么光。 */
  comboGlow?: number;
}

/**
 * 七把武器的外观。
 *
 * 只有一个劈砍动画，七把武器挥起来是同一个动作 —— 所以**区分全靠剪影与颜色**。
 * 规则是色相分线、明度与自发光分阶：
 *
 *   刀线走冷色，越往上越"热"（铁被反复锻打）：生铁灰 → 淬蓝钢 → 暗铁 + 赤热纹
 *   剑线走暖色，越往上越"黑"（骨 → 牙 → 淬过的齿）：骨白 → 琥珀牙黄 → 墨黑 + 白刃口
 *
 * 刀越往上越宽越长（最宽 ×1.85），剑越往上越窄越长（最窄 ×0.70）。
 * 宽刀砍下去像斧，窄剑砍下去像削。
 */
const WEAPON_VISUALS: Record<WeaponKind, BladeVisual> = {
  "survival-knife": {
    name: "SurvivalKnife", width: 1.00, length: 1.00, doubleEdged: false,
    color: 0xb8c1bd, roughness: 0.42, metalness: 0.52, gripColor: 0x4b3023,
  },

  "saber-1": {
    name: "IronCleaver", width: 1.35, length: 1.10, doubleEdged: false,
    color: 0x8a9299, roughness: 0.62, metalness: 0.35, gripColor: 0x4b3023,
  },
  "saber-2": {
    name: "ForgedBroadsaber", width: 1.55, length: 1.20, doubleEdged: false,
    color: 0x6f8ba8, roughness: 0.34, metalness: 0.72, gripColor: 0x3e2a1c,
  },
  "saber-3": {
    name: "SlagHeavysaber", width: 1.85, length: 1.30, doubleEdged: false,
    color: 0x4a4f57, roughness: 0.30, metalness: 0.80, gripColor: 0x2f2119,
    emissive: 0x8c2a10, emissiveIntensity: 0.55,
  },

  "sword-1": {
    name: "BoneShortsword", width: 0.85, length: 1.05, doubleEdged: true,
    color: 0xe4dcc4, roughness: 0.75, metalness: 0.05, gripColor: 0x5a4632,
    comboGlow: 0xfff0d0,
  },
  "sword-2": {
    name: "FangRapier", width: 0.75, length: 1.15, doubleEdged: true,
    color: 0xd9a441, roughness: 0.55, metalness: 0.15, gripColor: 0x4e3a24,
    comboGlow: 0xffc861,
  },
  "sword-3": {
    name: "SplitToothLongsword", width: 0.70, length: 1.28, doubleEdged: true,
    color: 0x2b2622, roughness: 0.45, metalness: 0.25, gripColor: 0x2a2119,
    edgeColor: 0xf2ece0, comboGlow: 0xf2ece0,
  },
};

const smoothTerrainBlend = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

// 精英狼比大狼再大一档，但不再是全场唯一的 BOSS 剪影。
/**
 * 三档狗的**站立高度**（世界单位）。模型按高度归一化到 1，所以这里就是高度本身。
 *
 * 尺子是玩家：玩家 2.6 高。于是野狗到腰（1.15）、壮犬到胸（1.7）、
 * 头犬比你还高一头（2.7）—— 等距视角下判断"这只咬不咬得动"靠的是剪影，不是血条，
 * 所以这三档必须一眼分得开。狼的高/长是 0.51，换算回体长是 2.3 / 3.3 / 5.3。
 */
const wolfScale = (wolf: WolfState): number => (
  wolf.kind === "elite" ? 2.7 : wolf.kind === "large" ? 1.7 : 1.15
);

/*
 * 昼夜光照配色表。**改这里就是改整个游戏的气质**，所以摊开写成常量而不是散在函数里。
 *
 * 白天走"暖主光 + 冷填充"，夜晚走"冷到底 + 一盏篝火"。见 syncDayNight 里那段。
 * 想回到 1.0.14 的全暖白天：DAY_SKY=d8bf8d、DAY_HEMI_SKY=ffeec4、
 * DAY_HEMI_GROUND=8a6a44、DAY_HEMI_INTENSITY=2.2、DAY_SUN_INTENSITY=3.2。
 */
const DAY_SKY = new THREE.Color(0xc9c3b4);
const DAY_HEMI_SKY = new THREE.Color(0xcdd8e6);
const DAY_HEMI_GROUND = new THREE.Color(0x8a7250);
const DAY_SUN = new THREE.Color(0xfff0cc);
const DAY_HEMI_INTENSITY = 1.15;
const DAY_SUN_INTENSITY = 4.1;

const NIGHT_SKY = new THREE.Color(0x2c3d5c);
const NIGHT_HEMI_SKY = new THREE.Color(0x8fa6cf);
const NIGHT_HEMI_GROUND = new THREE.Color(0x3a4356);
const NIGHT_SUN = new THREE.Color(0xa8bce0);

/** 腹面与口鼻的浅色。跟主色同色相、抬明度，模型自带的 Main_Light 槽正好吃这个。 */
const wolfBellyColor = (wolf: WolfState): number => {
  if (wolf.kind === "elite") return 0x7d5a3f;
  if (wolf.role === "guard") return 0x8e8f86;
  if (wolf.kind === "large") return 0xc98d55;
  return 0xf0d3a0;
};

/**
 * 三档狗的毛色。
 *
 * 分档规则是**明度**而不是色相：夜里只有篝火一盏光源，色相差在暗处基本读不出来，
 * 而明暗差还在。所以从白天的野狗到头犬是一路压暗，头犬几乎是黑褐色的一块。
 */
const wolfBodyColor = (wolf: WolfState): number => {
  if (wolf.kind === "elite") return 0x4a2f1e;
  // 守巢犬单独一个色：它和白天的壮犬同为 large，但玩家要学会的是
  // "巢边那三只不一样、碰它就得打完"。走**冷灰褐**而不是继续在暖褐里分深浅 ——
  // 全场只有它们不是沙漠色系，远远一眼就能认出来那圈是谁在守着。
  if (wolf.role === "guard") return 0x5b5f57;
  if (wolf.kind === "large") return 0x8f5228;
  if (wolf.role === "wild") return 0xd9a95f;
  return wolf.raider ? 0xc07a34 : 0xcf9a56;
};

/** 猎物配色：整体压在沙色系里，靠明度和一点点色相区分，不抢狼的戏。 */
export class GameRenderer {
  readonly canvas: HTMLCanvasElement;

  /** 软重启会换掉这两个引用，见 resetRun()。 */
  private simulation: GameSimulation;
  private world: WorldDefinition;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(47, 1, 0.1, 320);
  /*
   * 低功耗档下，超过这个距离的狗和猎物直接不画。
   * 夜里一口气 30 只狗、白天 52 只猎物，绝大多数时刻都在这个半径之外。
   * 注意只关**渲染**，模拟层照跑：狗该来还是会来，只是走到近处才画出来。
   *
   * **这个数必须和相机系数同比缩，改一个就要改另一个。** 45 配 1.08/0.64，41 配 0.98/0.58
   * （45/1.08 = 41.7，41/0.98 = 41.8，同一个比例）。距离系数是相似变换，所以同比之后
   * **屏幕上的表现完全不变**：狗"冒出来时占多少像素"在两组值下是同一个数。
   * 只改相机不改这里，弹入就会发生在目标更大的时候，反而更扎眼。
   *
   * 原注释说的"45 米外雾已经糊成背景色"是**错的**，一并改掉：FogExp2 的遮蔽率是
   * 1 - exp(-(密度×距离)²)，密度 0.0075 时 45 米只有 10.8%，几乎是透明的。
   *
   * 而实测（见 updateCamera 那张表）竖屏背向镜头那一侧地面能看到 80.2 米 ——
   * 也就是说这条剔除线**本来就在画面里**，远端确实会看到狗凭空出现。
   * 一直没动这个取舍：要消掉它得把线抬到 80 米，夜里多画的狗是实打实的开销，
   * 而它发生在画面最上缘、目标只有十几像素高的那一小块楔形区域里。
   */
  private static readonly LOW_POWER_DRAW_DISTANCE = 45;

  /** 触屏 / 窄屏走低功耗档：pixelRatio 1、512² 隔帧阴影、贴地装饰不收影、远处实体剔除。 */
  private readonly lowPower: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  /**
   * 阴影相机当前锚在哪。移动端不再每帧跟着相机走，只在漂移超过余量时重锚。
   * 初值是 NaN，保证第一帧必定重锚一次。
   */
  private readonly shadowAnchor = new THREE.Vector3(NaN, 0, 0);
  /** 有投影体发生变化，下一帧必须重画。 */
  private shadowDirty = true;
  /** 距离上次重画过了几帧。到 SHADOW_MAX_STALE_FRAMES 强制重画，兜住漏挂的钩子。 */
  private shadowStaleFrames = 0;
  /*
   * 掉落物的三份共享材质。做成字段而不是模块常量，是因为 makeMaterial 返回的是
   * MeshStandardMaterial，而模块级常量会跨 GameRenderer 实例存活 ——
   * 软重开虽然复用同一个渲染器，但测试里会反复新建，跨实例共享材质容易踩到
   * 一个实例 dispose 之后另一个还在用。
   */
  private readonly dropHideMaterial = makeMaterial(0x7a4931, 1);
  private readonly dropMeatMaterial = makeMaterial(0x9e3f3d, 0.9);
  private readonly dropBoneMaterial = makeMaterial(0xd7c8ad, 1);
  /** 角色贴地阴影。只在低功耗档存在；PC 用真阴影，那边不卡。 */
  private readonly blobShadows: THREE.InstancedMesh | null;
  /** 本帧已经写了几片。每帧从 0 重新累计，写完直接设 count，不留隐藏实例。 */
  private blobShadowCount = 0;
  private readonly blobShadowMatrix = new THREE.Matrix4();
  private readonly blobShadowPosition = new THREE.Vector3();
  private readonly blobShadowRotation = new THREE.Quaternion();
  private readonly blobShadowScale = new THREE.Vector3(1, 1, 1);
  /** 上下文丢失期间跳过绘制，否则每帧都会刷一串 GL 错误。 */
  private contextLost = false;
  /*
   * 一次性画质上调的采样状态，见 UPGRADE_* 那一块。
   * `upgradeSettled` 置位之后这套东西就彻底静默，不再有任何每帧开销。
   */
  private upgradeSettled = false;
  private upgradeStartedAt = 0;
  private lastFrameAt = 0;
  private readonly upgradeIntervals: number[] = [];
  private readonly upgradeWork: number[] = [];
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
  private readonly carriedStake: THREE.Object3D;
  private readonly carriedFuel: THREE.Object3D;
  private readonly truckGroup: THREE.Group;
  private truckRing: THREE.Mesh | null = null;
  /** 开局指路箭头。状态每帧从模拟层现算，见 syncGuideArrow。 */
  private readonly guideArrow: THREE.Mesh;
  /** 箭头的上下浮动与自转共用这一个相位，秒。 */
  private guidePhase = 0;
  /** 算车头世界坐标用的暂存，避免每帧 new 一个 Vector3。 */
  private readonly guideAnchor = new THREE.Vector3();
  /** 车斗上那一排已装的油桶，按 loaded 逐个点亮。 */
  private readonly truckLoadViews: THREE.Object3D[] = [];
  /** 新装油桶的落位反馈；只属于渲染层，不参与装车判定。 */
  private fuelLoadFeedbackTime = 0;
  private fuelLoadFeedbackIndex = -1;
  private readonly barrelViews = new Map<number, THREE.Object3D>();
  private readonly weaponMount: THREE.Group;
  private readonly blades: Map<WeaponKind, THREE.Group>;
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
  /** 天然枯木和石头各自合成一个 draw call；玩家放下的可破坏路障仍用 itemViews。 */
  private readonly staticWoodItems: THREE.InstancedMesh;
  private readonly staticStoneItems: THREE.InstancedMesh;
  private readonly itemInstanceCapacity: number;
  private readonly itemViews = new Map<number, THREE.Object3D>();
  private readonly itemRenderStates = new Map<number, ItemRenderState>();
  private readonly liveItemIds = new Set<number>();
  private readonly itemMatrix = new THREE.Matrix4();
  private readonly itemRotation = new THREE.Quaternion();
  private readonly itemPosition = new THREE.Vector3();
  private readonly itemScale = new THREE.Vector3(1, 1, 1);
  private treeTrunks: THREE.InstancedMesh | null = null;
  private treeBranches: THREE.InstancedMesh | null = null;
  /** 已经变成树桩的树。只记 id，用来避免每帧重写矩阵。 */
  private readonly felledTrees = new Set<number>();
  /** 路障挨打后的闪光余量（秒），按物品 id 记。 */
  private readonly barrierFlash = new Map<number, number>();
  /*
   * 仙人掌走合批，不再一株一个 Group。
   *
   * 32 株 × 9 个部件 = 288 个 Mesh，实测在开局营地那个机位上占了整帧 188 条
   * draw call 里的 53 条。而它每帧要做的事只有 syncCacti 那一句「割光了就隐藏」——
   * 没有逐株颜色、没有逐株动画，正好是实例矩阵能完整表达的那一类。
   *
   * 代价是剔除粒度：原先 32 株各自剔除（镜头里通常只画 6 株），现在整批同进同出。
   * 换到的三角形是白送的 —— 同一轮实测里把地形那 73.7k 三角整个隐藏，帧时间
   * 纹丝不动，而砍掉静态装饰的 draw call 省了 0.95 ms。这张图是 draw call 受限的。
   */
  private cactusBatches: CactusBatches | null = null;
  /** patch.id → 实例槽位。id 不保证等于下标，所以老老实实记一张表。 */
  private readonly cactusSlots = new Map<number, number>();
  private readonly cactusPlacements = new Map<number, CactusPlacement>();
  /** 上一次写进实例的显隐状态，用来避免每帧重写矩阵。 */
  private readonly cactusVisible = new Map<number, boolean>();
  private readonly ironViews = new Map<number, THREE.Object3D>();
  private readonly wellViews = new Map<number, THREE.Object3D>();
  private readonly wellPips = new Map<number, THREE.Object3D[]>();
  private readonly structureViews = new Map<number, THREE.Object3D>();
  /** 井顶水珠的浮动相位。 */
  private wellBob = 0;
  private readonly wolfViews = new Map<number, WolfView>();
  private readonly critterViews = new Map<number, CritterView>();
  private readonly dropViews = new Map<number, THREE.Object3D>();
  /** 三条每帧清空复用，避免 60 FPS 下持续制造短命 Set。 */
  private readonly liveWolfIds = new Set<number>();
  private readonly liveCritterIds = new Set<number>();
  private readonly liveDropIds = new Set<number>();
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly fireLight = new THREE.PointLight(0xff8b38, 0, 22, 2);
  private readonly sand: THREE.Points;
  private cameraShake = 0;
  /**
   * 过场镜头：不为 null 时相机看的是这个点而不是玩家。第一夜教学用它把视线
   * 从人物拉到营火上。回程要能插值，所以最后一次的目标点单独留着（cameraPanAnchor）。
   */
  private cameraPanTarget: Vec2 | null = null;
  private cameraPanAnchor: Vec2 | null = null;
  /** 0 = 看玩家，1 = 看过场目标。去程比回程慢一点，推出去的那一下才有分量。 */
  private cameraPan = 0;
  /**
   * 教学聚光灯。**这是一盏真的灯，不是一块盖在画面上的黑布。**
   *
   * 原先教学的压暗是 DOM 里一张 SVG 幕布（#tutorial-veil）。两个毛病：
   *
   *   1. **录不进去**。平台的会话录像抓的是画布，DOM 覆盖层不在里面 ——
   *      于是我们自以为做了很强的视觉引导，回放里却是一片正常光照的沙漠，
   *      根本看不出教学在指什么。看录像的人和玩游戏的人看到的不是同一个东西。
   *   2. **太重**。一整屏 78% 不透明的黑，第一眼像加载失败或者游戏坏了。
   *
   * 换成场景内的光：环境光压到四成，一盏聚光打在这一步的目标上。
   * 画布里发生的事，录像里就有；而"压暗一点 + 一束光"比"黑幕挖洞"温和得多。
   */
  private readonly tutorialSpot = new THREE.SpotLight(0xffe3b4, 0, 60, 0.5, 0.72, 1.1);
  private readonly tutorialSpotTarget = new THREE.Object3D();
  /** 聚光要照的世界坐标；null = 收灯。 */
  private tutorialFocus: Vec2 | null = null;
  /** 0~1 的淡入淡出，避免开关灯是硬切。 */
  private tutorialLight = 0;
  /** 脚下的取暖光环，见 buildWarmthAura。 */
  private readonly warmthAura: THREE.Group;
  private readonly warmthRing: THREE.Mesh;
  private readonly warmthMotes: THREE.Points;
  private warmthAmount = 0;
  private time = 0;
  /** 昼夜插值颜色每帧都会写，但对象本身不需要每帧重建。 */
  private readonly dayNightSky = new THREE.Color();
  private readonly onAssetProgress?: (loaded: number, total: number) => void;
  private readonly playerAssetReady: Promise<void>;
  /** Quaternius 的狼与鹿；它们在游戏画面出现后才开始下载。 */
  private wolfAsset: AnimalAsset | null = null;
  private deerAsset: AnimalAsset | null = null;
  private animalAssetLoadingStarted = false;

  constructor(
    root: HTMLElement,
    world: WorldDefinition,
    simulation: GameSimulation,
    onAssetProgress?: (loaded: number, total: number) => void,
  ) {
    this.world = world;
    this.simulation = simulation;
    this.onAssetProgress = onAssetProgress;
    /*
     * 移动端画质档。
     *
     * 起因是 Poki 实测手机 MEDIAN FPS 只有 19，而当时手机和台式机用的是
     * **同一套设置，没有任何降级分支**。1.0.16 一口气关了四样：分辨率、MSAA、
     * 阴影、远处实体。事后看，那一刀砍得太宽 —— 后三样里有两样砍错了地方：
     *
     *   pixelRatio 1.6 → 1.0   ✔ 留着。片元数直接降到 39%，这是唯一一条
     *                            效果可以精确算出来、不依赖场景内容的改动。
     *   MSAA 关掉              ✘ 撤回。移动 GPU 全是 TBR，MSAA 在片上解析，
     *                            省不下按倍数的填充；而分辨率已经降了，
     *                            少了超采样兜底，锯齿反而更需要它。
     *   阴影关掉               ✘ 撤回，改成把阴影本身做便宜（512² 图 + 收紧 far
     *                            + 小物件不投影），见下面几段。
     *   45 米外不画            ✔ 留着。它省的是 CPU：每只狗一个 AnimationMixer，
     *                            80 个实体压到 13 个，而且省在夜里那段最卡的地方。
     *
     * 桌面端始终保持原样，那边本来就不卡。
     */
    this.lowPower = matchMedia("(pointer: coarse)").matches || window.innerWidth <= 760;
    /*
     * MSAA 在移动端**留着**。
     *
     * 1.0.16 曾经在低功耗档一起关掉，那是矫枉过正：移动 GPU 全是 TBR
     * （Adreno / Mali / Apple），MSAA 在片上解析，代价是多占一点 tile memory
     * 加一次 resolve —— 不是"按倍数吃填充"。而 pixelRatio 已经从 1.6 压到 1.0，
     * 少了超采样这层遮掩，锯齿反而更需要 MSAA 兜着。
     */
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.lowPower ? 1 : 1.6));
    this.renderer.shadowMap.enabled = true;
    /*
     * 低功耗档也保留 PCF，不降级成 BasicShadowMap。
     *
     * 阴影图在这一档同时缩到 512²（见下），块状边缘正需要 PCF 那几次采样糊开；
     * 换成 Basic 省下的是主 pass 每个受光片元的几次纹理采样，但换来的硬边
     * 配上 512² 会直接暴露成阶梯。省错地方了。
     */
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    /*
     * PC 保持原来的每帧实时阴影。移动端只把 shadow pass 降到隔帧一次；主画面、
     * 光照颜色和 PCF 采样仍逐帧更新。这样保留动态阴影，只让它最多落后一个画面帧。
     */
    this.renderer.shadowMap.autoUpdate = !this.lowPower;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.canvas = this.renderer.domElement;
    root.appendChild(this.canvas);
    this.bindContextRecovery();

    // 荒漠白天：泛黄的尘霾天空，地面反照强烈。
    this.scene.background = DAY_SKY.clone();
    this.scene.fog = new THREE.FogExp2(DAY_SKY.getHex(), 0.0075);
    this.hemisphere = new THREE.HemisphereLight(DAY_HEMI_SKY, DAY_HEMI_GROUND, DAY_HEMI_INTENSITY);
    this.scene.add(this.hemisphere);
    this.sun = new THREE.DirectionalLight(DAY_SUN, DAY_SUN_INTENSITY);
    this.sun.position.set(-35, 55, 25);
    this.sun.castShadow = true;
    /*
     * 阴影图在低功耗档缩到 512²。
     *
     * 这是这一档里最划算的一刀：深度 pass 要光栅化的片元从 100 万降到 26 万，
     * 带宽同比例降，而**质量损失是有上限的** —— 阴影相机覆盖 64×64 世界单位，
     * 1024² 是每单位 16 texel，512² 是 8 texel。低多边形沙漠里的影子本来就是
     * 大色块，8 texel/米配上 PCF 的软化，在手机屏上看不出台阶。
     *
     * 相机范围保持 ±32：它是照着实际能看到的地面范围定的（相机架在焦点偏移
     * (19,24,19)、竖直 FOV 47°，可视地面纵深约 60 单位）。再收就会在画面里
     * 出现一条"影子到此为止"的硬线，那比影子糙难看得多。
     *
     * far 从 130 收到 110：太阳架在焦点上方 (−35,+55,+25)、距离约 70，
     * 130 给了 60 单位的富余，用不着那么多。收紧只赚深度精度，不损画面。
     */
    const shadowMap = this.lowPower ? LOW_POWER_SHADOW_MAP : 1024;
    this.sun.shadow.mapSize.set(shadowMap, shadowMap);
    // 低功耗档覆盖放大到 ±44 是为了给锚点漂移买余量，见 SHADOW_ANCHOR_MARGIN 那段。
    const extent = this.lowPower ? LOW_POWER_SHADOW_EXTENT : 32;
    this.sun.shadow.camera.left = -extent;
    this.sun.shadow.camera.right = extent;
    this.sun.shadow.camera.top = extent;
    this.sun.shadow.camera.bottom = -extent;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = this.lowPower ? 110 : 130;
    this.scene.add(this.sun, this.fireLight);

    this.terrainMesh = this.buildGround();
    this.buildCampWalls();
    this.buildTrees();
    this.buildGroundCover();
    this.buildLandmarks();
    this.itemInstanceCapacity = simulation.items.reduce((capacity, item) => Math.max(capacity, item.id + 1), 1);
    this.staticWoodItems = this.createStaticItemInstances(WOOD_ITEM_GEOMETRY, WOOD_COLOR);
    this.staticStoneItems = this.createStaticItemInstances(STONE_ITEM_GEOMETRY, STONE_COLOR);
    this.scene.add(this.staticWoodItems, this.staticStoneItems);
    this.blobShadows = this.lowPower ? this.createBlobShadows() : null;
    if (this.blobShadows) this.scene.add(this.blobShadows);
    this.buildDens();
    this.buildCamps();
    this.buildCacti();
    this.buildIronNodes();
    this.buildWells();
    this.truckGroup = this.buildTruck();
    this.buildBarrels();
    this.guideArrow = this.buildGuideArrow();
    this.playerBodyMaterial = makeMaterial(0x2f7b8d, 0.75);
    const player = this.buildPlayer();
    this.playerGroup = player.group;
    this.playerFallback = player.fallback;
    this.carriedWood = player.carriedWood;
    this.carriedStone = player.carriedStone;
    this.carriedStake = player.carriedStake;
    this.carriedFuel = player.carriedFuel;
    this.weaponMount = player.weaponMount;
    this.blades = player.blades;
    this.playerCoat = player.coat;
    this.scene.add(this.playerGroup);
    this.previousPlayerPosition.set(simulation.player.x, simulation.player.z);
    this.playerAssetReady = this.loadPlayerAsset();
    this.sand = this.buildSand();
    this.scene.add(this.sand);
    const aura = this.buildWarmthAura();
    this.warmthAura = aura.group;
    this.warmthRing = aura.ring;
    this.warmthMotes = aura.motes;
    this.scene.add(this.warmthAura);
    // 聚光灯不投阴影：教学要的是"这里亮"，不是多一层几何解算。
    this.tutorialSpot.castShadow = false;
    this.tutorialSpot.target = this.tutorialSpotTarget;
    this.scene.add(this.tutorialSpot, this.tutorialSpotTarget);

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
    const frameStart = this.upgradeSettled ? 0 : performance.now();
    const delta = Math.min(deltaSeconds, 0.05);
    this.time += delta;
    // 贴地阴影每帧重新累计：写完直接设 count，不需要隐藏用不到的实例。
    this.blobShadowCount = 0;
    this.syncPlayer(delta);
    this.syncItems(delta);
    this.syncBarrels(delta);
    this.syncGuideArrow(delta);
    this.syncCacti();
    this.syncIronNodes();
    this.syncTrees();
    this.syncWells(delta);
    this.syncStructures();
    this.syncCritters(delta);
    this.syncWolves(delta);
    this.syncDrops();
    this.syncFires();
    // 排在 syncDayNight 之前：那一步要按这一步算出的 tutorialLight 去压环境光。
    this.updateTutorialLight(delta);
    this.syncDayNight();
    this.updateCamera(delta);
    this.updateSand(delta);
    this.updateWarmthAura(delta);
    if (this.blobShadows) {
      this.blobShadows.count = this.blobShadowCount;
      this.blobShadows.instanceMatrix.needsUpdate = true;
    }
    this.scheduleShadowUpdate();
    this.renderer.render(this.scene, this.camera);
    // 排在最后：要量的是这一帧渲染的全部耗时。收工之后这一句直接 return。
    if (!this.upgradeSettled) this.probeQualityUpgrade(frameStart);
  }

  /**
   * 一次性画质上调的采样与判定。每帧调一次，判完就永久关掉。
   *
   * 设计意图和两个判据写在 UPGRADE_* 常量那一块，这里只讲实现上的三个取舍：
   *
   * **只在移动档跑。** 桌面档本来就是 1.6 / 1024，没有可升的余地。
   *
   * **等 `simulation.running` 才开始计时。** 玩家还停在开场页时场上没有狼、没有猎物，
   * 那时候量出来的富余是假的，照着它升档会在入夜时翻车。
   *
   * **异常帧整个丢掉。** 切后台、着色器编译、GC 长停顿都会混进来；它们既不代表
   * 这台机器的稳态开销，又足以把中位数拖歪。
   */
  private probeQualityUpgrade(frameStart: number): void {
    if (!this.lowPower) { this.upgradeSettled = true; return; }
    if (!this.simulation.running) { this.lastFrameAt = 0; return; }
    const now = performance.now();
    if (this.upgradeStartedAt === 0) this.upgradeStartedAt = now;
    const interval = this.lastFrameAt > 0 ? frameStart - this.lastFrameAt : 0;
    this.lastFrameAt = frameStart;
    const elapsed = now - this.upgradeStartedAt;
    if (elapsed < UPGRADE_WARMUP_MS) return;
    if (interval > 0 && interval < 250) {
      this.upgradeIntervals.push(interval);
      this.upgradeWork.push(now - frameStart);
    }
    if (elapsed < UPGRADE_WARMUP_MS + UPGRADE_WINDOW_MS) return;

    // 到点了，判一次就收工 —— 无论升不升，这一局都不会再来第二次。
    this.upgradeSettled = true;
    if (this.upgradeIntervals.length < UPGRADE_MIN_SAMPLES) return;
    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[sorted.length >> 1];
    };
    const sorted = [...this.upgradeIntervals].sort((a, b) => a - b);
    // 刷新间隔按观测到的最快帧倒推。取 5% 分位而不是最小值：偶发的短间隔会把最小值拉歪。
    // 12ms 以下认 120Hz，否则一律按 60Hz —— 机器慢到从没跑出满帧时我们也无从分辨，
    // 而默认 60Hz 会让下面两条判据保持保守。
    const vsync = sorted[Math.floor(sorted.length * 0.05)] <= 12 ? 8.33 : 16.67;
    const keepingUp = median(this.upgradeIntervals) <= vsync * UPGRADE_MAX_INTERVAL_RATIO;
    const hasHeadroom = median(this.upgradeWork) <= vsync * UPGRADE_MAX_WORK_RATIO;
    if (!keepingUp || !hasHeadroom) return;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, UPGRADE_PIXEL_RATIO));
    // setPixelRatio 之后要按新比例重新分配绘制缓冲，否则画布还是旧尺寸。
    this.resize();
    // 换阴影图尺寸必须先把旧的那张扔掉，three 才会按新尺寸重建。
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.sun.shadow.mapSize.set(UPGRADE_SHADOW_MAP, UPGRADE_SHADOW_MAP);
    // 新图是空的，下一帧必须重画，不能等 30 帧兜底。
    this.markShadowDirty();
  }

  /**
   * 把镜头推到某个世界坐标上，传 null 收回到玩家身上。
   *
   * 唯一的用户是第一夜教学：入夜那一刻时间停住、狼在远处嚎，镜头从人物推到
   * 营火上再收回来 —— 这一推就是"你今晚要守的是那堆火"这句话的全部内容。
   * 收回来是插值的，不是瞬切，所以调用方只管一开一关。
   */
  focusOn(target: Vec2 | null): void {
    this.cameraPanTarget = target;
    if (target) this.cameraPanAnchor = { x: target.x, z: target.z };
  }

  /**
   * 教学聚光：压暗全场，把一束光打在这个世界坐标上。传 null 收灯。
   * 每帧可以改目标（猎物会跑），插值由 updateTutorialLight 负责。
   */
  spotlightOn(target: Vec2 | null): void {
    this.tutorialFocus = target;
  }

  private updateTutorialLight(delta: number): void {
    const wants = this.tutorialFocus !== null;
    // 0.45 秒亮起、0.7 秒退场：亮得干脆，收得从容。
    this.tutorialLight = clamp(this.tutorialLight + delta / (wants ? 0.45 : -0.7), 0, 1);
    if (this.tutorialFocus) {
      const { x, z } = this.tutorialFocus;
      const ground = this.worldHeight(x, z);
      this.tutorialSpotTarget.position.set(x, ground, z);
      this.tutorialSpotTarget.updateMatrixWorld();
      // 灯挂在目标正上方偏相机一侧，光斑才不会被角色自己挡住。
      this.tutorialSpot.position.set(x + 4.5, ground + 17, z + 4.5);
    }
    this.tutorialSpot.intensity = this.tutorialLight * 165;
    this.tutorialSpot.visible = this.tutorialLight > 0.01;
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

  /**
   * 世界坐标 → 画布内的 CSS 像素坐标。给 HUD 的屏幕边缘指示器用。
   *
   * `behind` 表示目标在相机背后：这时投影出来的 x/y 是镜像的，直接拿去用会让
   * 箭头指反方向，所以调用方必须自己处理这一位。
   */
  worldToScreen(x: number, z: number): { x: number; y: number; behind: boolean } {
    this.worldPoint.set(x, this.worldHeight(x, z) + 1.2, z);
    this.worldPoint.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + ((this.worldPoint.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - this.worldPoint.y) / 2) * rect.height,
      behind: this.worldPoint.z > 1,
    };
  }

  impact(strength: number): void {
    this.cameraShake = Math.max(this.cameraShake, strength);
  }

  /**
   * 一桶油进入车斗后的短反馈：新桶从槽位上方落下，停车环亮一下，镜头轻震。
   * 不用 focusOn() —— 那是 1.35 秒的教学推镜，会抢走玩家视线和镜头控制。
   */
  fuelLoaded(loaded: number): void {
    this.fuelLoadFeedbackIndex = clamp(Math.round(loaded) - 1, 0, this.truckLoadViews.length - 1);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.fuelLoadFeedbackTime = 0;
      return;
    }
    this.fuelLoadFeedbackTime = 0.52;
    this.impact(0.065);
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

  /**
   * 软重启：换掉世界与模拟层，**不重建渲染器**。
   *
   * 原先"再来一局"走的是 `window.location.reload()` —— 整页重载：重新解析 HTML 与
   * 主包、重下重解 646 KB 的 GLB、重建 resolution² 顶点的地形网格、重编译着色器，
   * 外加开场那几次 nextPaint() 的 150 ms 兜底。而平台数据显示长会话是**重开叠出来的**
   * （录像里有人 10 分钟开了 5、6 局），也就是说这笔钱每两分钟收一次。
   *
   * 能只换引用，是因为世界在换出生营地时几乎没变 —— placeBarrels 拆出独立随机流之后
   * （见 createWorld 里那段注释），15 个字段里只有 walls 1/36、initialItems 4/97、
   * barrels 7/10、truck 和 startCampId 不同，树、仙人掌、矿脉、井、地标逐字节相同。
   * 地形更是完全一致。
   *
   * 动态实体仍会从 simulation 同步；地面物品现在有渲染状态缓存和实例槽，所以换局时
   * 明确清一次缓存，让下一帧把新世界完整写进批次。玩法状态仍只存在 simulation 中。
   */
  resetRun(world: WorldDefinition, simulation: GameSimulation): void {
    // 砍成树桩的树要长回来。felledTrees 只在砍倒那一刻写实例矩阵，不还原就一直是树桩。
    // 趁 this.world 还是旧的先还原 —— 树在各营地之间是一样的，但别依赖这一点。
    for (const id of this.felledTrees) this.placeTree(id, 1);
    this.felledTrees.clear();

    this.world = world;
    this.simulation = simulation;

    // 玩家放下的路障：syncStructures 只按当前结构补视图、从不删，
    // 而新一局的结构 id 从头开始，不清就会有上一局的桩子挂在场上。
    for (const view of this.structureViews.values()) this.scene.remove(view);
    this.structureViews.clear();
    this.barrierFlash.clear();
    for (const id of this.itemViews.keys()) this.removeItemView(id);
    this.itemRenderStates.clear();
    for (let index = 0; index < this.itemInstanceCapacity; index += 1) {
      this.staticWoodItems.setMatrixAt(index, HIDDEN_ITEM_MATRIX);
      this.staticStoneItems.setMatrixAt(index, HIDDEN_ITEM_MATRIX);
    }
    this.staticWoodItems.instanceMatrix.needsUpdate = true;
    this.staticStoneItems.instanceMatrix.needsUpdate = true;
    // 软重开换了世界：投影体全变了，下一帧必须重画并重锚。
    this.markShadowDirty();
    this.shadowAnchor.set(NaN, 0, 0);

    // 相机与过场回到开局：上一局若死在推镜或教学聚光灯里，这些值会留着。
    this.cameraPanTarget = null;
    this.cameraPanAnchor = null;
    this.cameraPan = 0;
    this.tutorialFocus = null;
    this.tutorialLight = 0;
    this.cameraShake = 0;
    this.fuelLoadFeedbackTime = 0;
    this.fuelLoadFeedbackIndex = -1;
    const player = simulation.player;
    this.previousPlayerPosition.set(player.x, player.z);
    this.cameraFocus.set(player.x, this.worldHeight(player.x, player.z), player.z);
  }

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
      // 0.72 → 0.42：最深处从「比沙地暗 17%」收到「暗 10%」。
      // 配合 terrainMoistureAt 改成的多倍频，湿地退成砂砾斑驳，不再是一滩水。
      color.copy(sand).lerp(gravel, moisture * 0.42);
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
      // autoUpdate 在移动端关闭，上下文恢复后阴影图是空的，必须显式重建。
      this.markShadowDirty();
      console.info("WebGL 上下文已恢复");
    });
  }

  /** 移动端隔帧更新一次真实阴影；桌面端沿用 WebGLShadowMap.autoUpdate。 */
  /**
   * 角色贴地阴影的实例批次。整批一次 draw call，零蒙皮、不进深度 pass。
   *
   * frustumCulled 关掉：这批的包围盒每帧都在变（实例矩阵改了 three 也不会自动重算），
   * 开着剔除会在角色跑到画面边缘时整批消失。它只有一次 draw call，不值得为它算剔除。
   */
  private createBlobShadows(): THREE.InstancedMesh {
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

  /**
   * 记一片贴地阴影。由 syncPlayer / syncWolves / syncCritters 在**已经通过
   * 45 米剔除之后**调用 —— 剔除逻辑只写一份，这里不重复判距离。
   */
  /**
   * 低功耗档的"这东西不投影"开关。
   *
   * 两类东西走这里：
   *
   * **角色**（玩家、狼、鹿、程序化猎物）—— 改用 pushBlobShadow 的贴地圆斑。
   * 它们的 castShadow 是设在共享源网格上的（AnimalModels.loadAnimal 与
   * CritterModels），clone 全部继承 true，而那两个模块不知道画质档存在。
   *
   * **会移动的小件**（油桶、树桩）—— 阴影图每米 8.7 texel，1.18 米的油桶只有
   * 10 个 texel、树桩更是不到 2 个，本来就看不出形状；而它们一动就让缓存的
   * 阴影图作废。关掉之后阴影图里只剩真正静态的几何，缓存才立得住。
   */
  private applyLowPowerShadowPolicy(root: THREE.Object3D): void {
    if (!this.lowPower) return;
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.castShadow = false;
    });
  }

  private pushBlobShadow(x: number, z: number, radius: number): void {
    const mesh = this.blobShadows;
    if (!mesh || this.blobShadowCount >= BLOB_SHADOW_CAPACITY) return;
    /*
     * **必须贴着坡面躺，不能一律水平。**
     *
     * 地形可走坡度上限是 0.78（mapBlueprint）。一片水平的圆斑半宽 0.75 米
     * （精英狼那一档），落在 0.5 的坡上，上坡那半边要抬 0.37 米 —— 整个埋进地里，
     * 剩下半个月牙。抬高解决不了：抬够了不埋，下坡那边就浮在半空。
     *
     * 所以按地形法线转一次。法线用左右各 0.5 米的高度差估，两次额外的
     * terrainHeightAt —— 那是纯函数采样，和已经在做的每帧一次同一个量级。
     * 边缘 alpha 本来就衰减到 0，法线估得糙一点看不出来。
     */
    const height = this.worldHeight(x, z);
    const step = BLOB_SHADOW_NORMAL_STEP;
    const slopeX = (this.worldHeight(x + step, z) - this.worldHeight(x - step, z)) / (2 * step);
    const slopeZ = (this.worldHeight(x, z + step) - this.worldHeight(x, z - step)) / (2 * step);
    BLOB_SHADOW_NORMAL.set(-slopeX, 1, -slopeZ).normalize();
    this.blobShadowPosition.set(x, height + BLOB_SHADOW_LIFT, z);
    this.blobShadowRotation.setFromUnitVectors(BLOB_SHADOW_UP, BLOB_SHADOW_NORMAL);
    this.blobShadowScale.set(radius * 2, 1, radius * 2);
    this.blobShadowMatrix.compose(this.blobShadowPosition, this.blobShadowRotation, this.blobShadowScale);
    mesh.setMatrixAt(this.blobShadowCount, this.blobShadowMatrix);
    this.blobShadowCount += 1;
  }

  /**
   * 决定这一帧要不要重画阴影图，以及要不要把阴影相机挪个窝。
   *
   * 桌面端直接返回：那边 autoUpdate 开着，three.js 每帧自己重画，本来就不卡。
   *
   * 移动端**太阳只在重锚那一帧移动**。这一点是必须的：three.js 在
   * needsUpdate 为 false 时会跳过 shadow.updateMatrices，采样矩阵停在上次重画的
   * 状态；如果这期间还每帧挪灯，灯和贴图就对不上了。反过来说，灯不挪也不影响
   * 光照方向 —— 位置是焦点加固定偏移 (−35,+55,+25)，方向恒定。
   */
  /**
   * 把 three.js 自己的统计交出去给 PerfOverlay。
   *
   * renderer.info 是零成本的：three 本来就在累计这些计数，这里只是读一次。
   * programs 是**已编译的着色器程序数** —— 它比 draw calls 更能说明材质有没有
   * 被无谓地 clone（每只狼一份材质 = 每只狼一个程序），所以一并报出来。
   */
  getRenderStats(): RenderStats {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  private scheduleShadowUpdate(): void {
    if (!this.lowPower) return;
    this.shadowStaleFrames += 1;
    const focus = this.cameraFocus;
    const drift = Math.hypot(focus.x - this.shadowAnchor.x, focus.z - this.shadowAnchor.z);
    // 取反写法：首帧 shadowAnchor 是 NaN，drift 也是 NaN，NaN <= margin 为 false。
    const needsRedraw = this.shadowDirty
      || this.shadowStaleFrames >= SHADOW_MAX_STALE_FRAMES
      // 卡车是静态投影体里唯一会自己跑的：驶离那十几秒退回逐帧。
      || this.simulation.isDeparting()
      || !(drift <= SHADOW_ANCHOR_MARGIN);
    if (!needsRedraw) {
      this.renderer.shadowMap.needsUpdate = false;
      return;
    }
    this.shadowAnchor.set(focus.x, focus.y, focus.z);
    this.sun.position.set(focus.x - 35, focus.y + 55, focus.z + 25);
    this.sun.target.position.set(focus.x, focus.y, focus.z);
    this.sun.target.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = true;
    this.shadowDirty = false;
    this.shadowStaleFrames = 0;
  }

  /** 投影体变了（砍树、造结构、卡车启动），下一帧必须重画阴影图。 */
  private markShadowDirty(): void {
    this.shadowDirty = true;
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

  /**
   * 树。树干和树冠各一个 InstancedMesh —— 十八棵树共两次 draw call。
   *
   * 砍空之后不删实例，只把它重新摆成一截树桩（见 syncTrees）：碰撞体在 walls 里
   * 从建好就不再变，所以"砍倒的树还挡着路"是免费的，而实例数固定也省掉了重建网格。
   */
  private buildTrees(): void {
    const trunkGeometry = new THREE.CylinderGeometry(0.22, 0.4, 3.4, 6);
    const branchGeometry = new THREE.ConeGeometry(1.25, 3.5, 7);
    const trunkMaterial = makeMaterial(0x7a6446, 1);
    const branchMaterial = makeMaterial(0x8a7550, 1);
    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, this.world.trees.length);
    const branches = new THREE.InstancedMesh(branchGeometry, branchMaterial, this.world.trees.length);
    trunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    branches.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    trunks.castShadow = true;
    branches.castShadow = true;
    this.treeTrunks = trunks;
    this.treeBranches = branches;
    this.world.trees.forEach((_, index) => this.placeTree(index, 1));
    this.scene.add(trunks, branches);
  }

  /**
   * 把第 index 棵树摆成给定的"完整度"：1 是整棵，0 是一截树桩。
   *
   * 树桩做法是把树干压到两成高、树冠缩到零 —— 缩到零的实例仍然会被提交，
   * 但零体积不产生像素，比维护一份"哪些实例还活着"的映射简单得多。
   */
  private placeTree(index: number, fullness: number): void {
    const tree = this.world.trees[index];
    if (!tree || !this.treeTrunks || !this.treeBranches) return;
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), tree.rotation);
    const terrainY = this.worldHeight(tree.x, tree.z);
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();

    // 树干：整棵是原高，树桩压到 0.2 —— 还看得出是根桩子，不至于矮到像块石头。
    const trunkScaleY = fullness > 0 ? 1 : 0.2;
    position.set(tree.x, terrainY + 1.65 * tree.scale * trunkScaleY, tree.z);
    scale.set(tree.scale, tree.scale * trunkScaleY, tree.scale);
    matrix.compose(position, rotation, scale);
    this.treeTrunks.setMatrixAt(index, matrix);
    this.treeTrunks.instanceMatrix.needsUpdate = true;

    // 树冠：砍空就没了。
    position.set(tree.x, terrainY + 3.55 * tree.scale, tree.z);
    scale.setScalar(fullness > 0 ? tree.scale : 0);
    matrix.compose(position, rotation, scale);
    this.treeBranches.setMatrixAt(index, matrix);
    this.treeBranches.instanceMatrix.needsUpdate = true;
  }

  /** 每帧对一遍：砍空的树该是树桩。只在状态真的变了时才写矩阵。 */
  private syncTrees(): void {
    for (const tree of this.simulation.trees) {
      const felled = tree.wood <= 0;
      if (this.felledTrees.has(tree.id) === felled) continue;
      if (felled) this.felledTrees.add(tree.id);
      else this.felledTrees.delete(tree.id);
      this.placeTree(tree.id, felled ? 0 : 1);
      // 树是阴影图里最大的一块，砍倒/长回必须立刻重画，等不到 30 帧兜底。
      this.markShadowDirty();
    }
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
    /*
     * 卵石 260 → 110。
     *
     * 草和灌木没人会误会，卵石会：它是全场唯一"长得像可搬石头、却碰都碰不了"的
     * 东西，而真正能搬的石头只有三十几块。两百多颗假石头混在里面，等于把那三十几块
     * 真的藏起来了。砍掉一半多，地表纹理还在，误导少一大半。
     */
    const pebblePoints = collect(110, 0.62, -0.18);
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
      // 贴地装饰下方仍是会收影的地面；移动端让它们自己再采一次 PCF 没有视觉收益。
      mesh.receiveShadow = !this.lowPower;
      this.scene.add(mesh);
    };
    place(grass, grassPoints, 0.02, 1.12);
    place(heath, heathPoints, 0.18, 0.62);
    place(pebbles, pebblePoints, 0.12, 0.58);
  }

  /**
   * 狗巢。地形已经刻出土垄与缺口（shape_dens），这里只补三样让它一眼可读的东西：
   * 巢口那个黑洞、洞口两侧被爪子刨出的土脊、以及散落的骨头。
   *
   * 关键是**黑洞要够黑**：它是玩家夜里从 53 米外唯一能定位到的东西。
   * 用一个不受光的纯黑圆面朝天倾斜嵌进坡里，比任何几何都更像"深不见底"。
   */
  private buildDens(): void {
    const earth = makeMaterial(0x6a5642, 1);
    const packed = makeMaterial(0x53412f, 1);
    const bone = makeMaterial(0xd9cfb4, 0.85);
    for (const den of this.world.dens) {
      const group = new THREE.Group();
      const mouth = den.mouth;
      group.position.set(mouth.x, this.worldHeight(mouth.x, mouth.z), mouth.z);
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
      this.scene.add(group);
    }
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
      // 三道刻痕的材质是循环里现造的，参数一样却是三个对象 ——
      // mergeStaticGroup 按材质**指纹**分桶，所以它们照样能合到一块。
      mergeStaticGroup(group);
      this.scene.add(group);
    }
  }

  /**
   * 卡车。用的是 wreck 地标那套零件的"完好版"—— 同一种视觉语言，
   * 但它是唯一一辆车斗完整、有驾驶室、有油箱口的车，玩家一眼能认出这台不一样。
   */
  private buildTruck(): THREE.Group {
    const group = new THREE.Group();
    /*
     * 车身刷成**青绿**，不是沙色。
     *
     * 原来是 0x8a6236 —— 一个偏红的土黄，和脚下的沙子几乎同色同明度，
     * 于是这台"唯一的通关目标"在开局画面里读起来只是块石头。
     * 青绿是沙黄的补色，昼夜两种光照下都跳得出来，而且不和 HUD 的琥珀色
     * 或伤害红撞车。车斗挡板用更亮一档，让"装了几桶"更容易看清。
     */
    const body = makeMaterial(0x11a5a0, 1);
    const panelPaint = makeMaterial(0x16c2ba, 1);
    const iron = makeMaterial(0x39423f, 0.95);
    const glass = makeMaterial(0x9fe6df, 0.35);

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.55, 2.5), iron);
    chassis.position.y = 0.95;
    chassis.castShadow = true;
    group.add(chassis);

    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.5, 2.35), body);
    cab.position.set(1.9, 1.95, 0);
    cab.castShadow = true;
    group.add(cab);
    const windscreen = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.75, 1.9), glass);
    windscreen.position.set(2.86, 2.15, 0);
    group.add(windscreen);

    // 车斗四面挡板：装了几桶油要从外面看得见，所以侧板留矮。
    for (const [dx, dz, sx, sz] of [[-3.05, 0, 0.16, 2.4], [0.85, 0, 0.16, 2.4],
      [-1.1, 1.2, 4, 0.16], [-1.1, -1.2, 4, 0.16]] as const) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.9, sz), panelPaint);
      panel.position.set(dx, 1.68, dz);
      panel.castShadow = true;
      group.add(panel);
    }

    for (const dx of [2.05, -1.15, -2.75]) {
      for (const dz of [-1.28, 1.28]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.42, 12), iron);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(dx, 0.82, dz);
        wheel.castShadow = true;
        group.add(wheel);
      }
    }

    // 车斗里六个油桶位，装一桶亮一个。
    for (let index = 0; index < FUEL_REQUIRED; index += 1) {
      const slot = createBarrelView();
      this.applyLowPowerShadowPolicy(slot);
      slot.position.set(-2.45 + (index % 3) * 1.15, 1.5, index < 3 ? -0.6 : 0.62);
      slot.scale.setScalar(0.82);
      slot.visible = false;
      group.add(slot);
      this.truckLoadViews.push(slot);
    }

    this.buildTruckBeacon(group);
    /*
     * 车体合批。车斗上那六个油桶槽位要逐个显隐（装了几桶亮几个，还有落位反馈），
     * 地环是半透明、每帧改透明度 —— 这两样留着；底盘、驾驶室、轮子、油箱口可以合。
     * 卡车整体会在通关时开走，但那是 group 的位移，和零件之间的相对关系无关。
     */
    const truckDynamic = new Set<THREE.Object3D>(this.truckLoadViews);
    if (this.truckRing) truckDynamic.add(this.truckRing);
    mergeStaticGroup(group, truckDynamic);
    this.scene.add(group);
    return group;
  }

  /**
   * 卡车的常驻标记只剩**贴地一圈环**。
   *
   * 原来还有一道 26 米高的加色光柱 —— 那是网游任务标记那一套，和这游戏的
   * 低多边形沙漠完全不搭，而且它是**世界里的物件**，注定会挡视野。
   * "怎么找到车"这件事已经交给 HUD 的屏幕边缘指示器（见 HudController.syncTruckPointer），
   * 那个不在世界里，所以不会丑、也不会挡。
   *
   * 留下地环是因为它有另一个用途：告诉你**站到哪儿才能装油**。
   * 它贴着地、跟着地形，读起来像停车位划线，不像特效。
   */
  private buildTruckBeacon(group: THREE.Group): void {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 3.9, 40),
      new THREE.MeshBasicMaterial({
        color: 0x36d9cc,
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.09;
    group.add(ring);
    this.truckRing = ring;
  }

  private buildGuideArrow(): THREE.Mesh {
    /*
     * 颜色跟卡车走，不跟油桶走。
     *
     * 地环是 0x36d9cc、HUD 那枚卡车指示牌的字是 0x8ff0e6 —— 这一族青绿在这个游戏里
     * 已经固定表示"通关路线上的东西"。箭头先指的虽然是个红油桶，但它说的仍是
     * 同一句话（"往这儿走"），所以用同一族颜色，而不是跟着被指的东西变。
     *
     * 带自发光：白天它靠主光就够亮，但这根箭头在夜里也可能还在（玩家磨蹭到入夜），
     * 而夜里环境光压得很低，纯漫反射会整根沉进背景。
     */
    const mesh = new THREE.Mesh(
      createGuideArrowGeometry(),
      new THREE.MeshStandardMaterial({
        color: 0x2fe0cf,
        emissive: 0x0f9c90,
        roughness: 0.45,
        metalness: 0,
        // 和场上所有道具同一档：平直着色，四个面各自一个色阶，轮廓才咬得住沙子。
        flatShading: true,
      }),
    );
    // 它是"指路的"，不是场上的实体：不投影，免得地上多出一道解释不了的影子。
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    this.scene.add(mesh);
    return mesh;
  }

  /**
   * 开局那一趟的指路箭头：先浮在第一桶油上，扛起来之后挪到车头，装进车里就退场。
   *
   * **不留状态机**，每帧从模拟层现算：中途把桶放下箭头就自己飞回桶上，再扛起来又回车头。
   * 一个 latch 都不需要，软重开也不用清 —— resetRun 换掉 simulation 之后它自然接着新的一局。
   *
   * 退场判据是 `loaded >= 1`：第一桶进了车，这段引导就干完了。剩下五桶不再指 ——
   * 否则它就从"开局教一次"变成一个常驻任务标记，正是 buildTruckBeacon 拆光柱时否掉的东西。
   * 退场只关 visible 不 dispose：软重开复用同一个渲染器，下一局还要用它。
   */
  private syncGuideArrow(delta: number): void {
    const arrow = this.guideArrow;
    const fuel = this.simulation.getFuelProgress();
    if (fuel.loaded >= 1) {
      arrow.visible = false;
      return;
    }

    if (fuel.carrying) {
      // 车头顶上。cab 在 buildTruck 里是 local (1.9, 1.95, 0)、高 1.5，顶面因此在 2.7，
      // 再留 0.35 的净空。localToWorld 会自己把 truckGroup 的世界矩阵更到最新。
      this.guideAnchor.set(1.9, 3.05, 0);
      this.truckGroup.localToWorld(this.guideAnchor);
    } else {
      /*
       * 第一桶 = createWorld 最后压进去的那一桶（出生点 2.2 米外那桶，见 placeBarrels
       * 末尾）。按下标取而不是记 id：软重开会换一整套 world，下标每局都对，记下来的 id 不一定。
       */
      const barrels = this.simulation.barrels;
      const first = barrels[barrels.length - 1];
      if (!first || first.placement !== "ground") {
        arrow.visible = false;
        return;
      }
      // 桶身 1.18 高、中心抬到地面 +0.62，顶盖到 +1.31；再留 0.24 净空。
      this.guideAnchor.set(first.x, this.worldHeight(first.x, first.z) + 1.55, first.z);
    }

    this.guidePhase += delta;
    arrow.visible = true;
    arrow.position.set(
      this.guideAnchor.x,
      this.guideAnchor.y + Math.sin(this.guidePhase * 2.6) * 0.19,
      this.guideAnchor.z,
    );
    // 固定朝向的等距相机不跟人转，所以慢转一圈就能保证四个面轮流对着玩家。
    arrow.rotation.y = this.guidePhase * 1.15;
  }

  private buildBarrels(): void {
    for (const barrel of this.simulation.barrels) {
      const view = createBarrelView();
      this.applyLowPowerShadowPolicy(view);
      // 桶身、桶箍、桶盖之间不动；syncBarrels 只改整只桶的 visible / position / rotation。
      // 必须排在 applyLowPowerShadowPolicy 之后 —— castShadow 是分桶键的一部分。
      mergeStaticGroup(view);
      view.rotation.y = barrel.rotation;
      this.scene.add(view);
      this.barrelViews.set(barrel.id, view);
    }
  }

  /** 地上的油桶跟着地形贴地；被扛走或装了车的那些直接隐藏。 */
  private syncBarrels(delta: number): void {
    for (const barrel of this.simulation.barrels) {
      const view = this.barrelViews.get(barrel.id);
      if (!view) continue;
      view.visible = barrel.placement === "ground";
      if (!view.visible) continue;
      view.position.set(barrel.x, this.worldHeight(barrel.x, barrel.z) + 0.62, barrel.z);
      view.rotation.y = barrel.rotation;
    }
    const truck = this.simulation.truck;
    this.truckGroup.position.set(truck.x, this.worldHeight(truck.x, truck.z), truck.z);
    this.truckGroup.rotation.y = -truck.rotation;
    const feedbackDuration = 0.52;
    const feedbackActive = this.fuelLoadFeedbackTime > 0;
    const feedbackProgress = feedbackActive
      ? clamp(1 - this.fuelLoadFeedbackTime / feedbackDuration, 0, 1)
      : 1;
    this.truckLoadViews.forEach((slot, index) => {
      slot.visible = index < truck.loaded;
      slot.position.y = 1.5;
      slot.rotation.x = 0;
      slot.rotation.z = 0;
      slot.scale.setScalar(0.82);
      if (!slot.visible || !feedbackActive || index !== this.fuelLoadFeedbackIndex) return;

      // 前 72% 快速落下，后 28% 只做很小的压缩回弹；重量感来自“快落、短停”，
      // 不是让油桶像果冻一样弹很久。
      const fallProgress = clamp(feedbackProgress / 0.72, 0, 1);
      const fall = 1 - (1 - fallProgress) ** 3;
      const settleProgress = clamp((feedbackProgress - 0.62) / 0.38, 0, 1);
      const settle = Math.sin(settleProgress * Math.PI);
      slot.position.y += (1 - fall) * 0.78 - settle * 0.055;
      slot.rotation.x = (1 - fall) * -0.18;
      slot.rotation.z = (1 - fall) * 0.24;
      slot.scale.set(0.82 * (1 + settle * 0.08), 0.82 * (1 - settle * 0.07), 0.82 * (1 + settle * 0.08));
    });
    /*
     * 标记随进度收敛：油装得越满，光柱越淡 —— 它的职责是"把人引过来"，
     * 装满之后引导已经完成，再亮着只会挡视野。装满时环改为常亮不闪，
     * 表示"可以走了"。
     */
    const fuel = this.simulation.getFuelProgress();
    // 没装满时环轻微呼吸，装满后常亮 —— "可以走了"。
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 2.2);
    if (this.truckRing) {
      const material = this.truckRing.material as THREE.MeshBasicMaterial;
      const full = fuel.loaded >= fuel.required;
      const loadFlash = feedbackActive ? this.fuelLoadFeedbackTime / feedbackDuration : 0;
      material.opacity = Math.min(0.62, (full ? 0.5 : 0.22 + 0.16 * pulse) + loadFlash * 0.24);
      this.truckRing.scale.setScalar(1 + loadFlash * 0.12);
      this.truckRing.visible = !this.simulation.isDeparting();
    }
    this.fuelLoadFeedbackTime = Math.max(0, this.fuelLoadFeedbackTime - delta);
    // 驶离时玩家在车里。模拟层把人的坐标锁在车心，所以直接把人藏掉 ——
    // 否则最后 5 秒会看到一个人站在车斗中央被拖出地图。
    this.playerGroup.visible = !this.simulation.isDeparting();
  }

  /**
   * 铁矿脉：一丛**立起来的**深色棱柱 + 亮橙的矿脉。
   *
   * 改之前它和地上的可搬石头几乎分不出来 —— 两个都是压扁的十二面体，
   * 差别只有色调，加三颗半径 0.24 的小疙瘩。而相机拉近之后角色才占屏高 13%，
   * 那三颗疙瘩在实际尺寸下等于不存在。
   *
   * 所以这一版把差别做在**剪影**上，不做在颜色上：
   *
   *   可搬石头   压扁的圆卵石   高 ~0.9   横向铺开（scale 2.15 × 1.32 × 1.7）
   *   铁矿脉     竖起的尖棱柱   高 ~2.0   向上收拢，四根朝外倾斜
   *
   * 一个趴着、一个立着，一眼就分得开，不用凑近看颜色。矿脉本身也放大到 0.34
   * 并调高自发光 —— 它是"这块能挖"的唯一记号，得在十几米外读得出来。
   */
  private buildIronNodes(): void {
    const rockMaterial = makeMaterial(0x4a4038, 1);
    const oreMaterial = new THREE.MeshStandardMaterial({
      color: 0xd08a4a,
      emissive: 0x6b2f10,
      emissiveIntensity: 0.9,
      roughness: 0.62,
      flatShading: true,
    });
    for (const node of this.simulation.ironNodes) {
      const group = new THREE.Group();
      group.position.set(node.x, this.worldHeight(node.x, node.z), node.z);
      group.rotation.y = node.rotation;

      // 底座压得很扁，只是让棱柱有个"从地里长出来"的根，不参与剪影。
      const base = new THREE.Mesh(new THREE.DodecahedronGeometry(0.72, 0), rockMaterial);
      base.position.y = 0.22;
      base.scale.set(1.15, 0.42, 1.05);
      base.castShadow = true;
      group.add(base);

      // 四根高矮不一的尖棱柱，向外倾斜 —— 参差和倾角是"矿脉"读感的全部来源，
      // 四根一样高一样直的话就变成一座塔了。
      for (const [index, [angle, radius, height, tilt]] of IRON_SHARDS.entries()) {
        const shard = new THREE.Mesh(IRON_SHARD_GEOMETRIES[index], rockMaterial);
        shard.position.set(Math.cos(angle) * radius, 0.3 + height / 2, Math.sin(angle) * radius);
        shard.rotation.z = Math.cos(angle) * tilt;
        shard.rotation.x = -Math.sin(angle) * tilt;
        shard.castShadow = true;
        group.add(shard);
      }

      // 矿脉：贴在棱柱根部朝外的一圈，三颗，比原先大四成、自发光更强。
      for (let index = 0; index < 3; index += 1) {
        const angle = 0.7 + index * 2.1;
        const ore = new THREE.Mesh(IRON_ORE_GEOMETRY, oreMaterial);
        ore.position.set(Math.cos(angle) * 0.52, 0.5 + (index % 2) * 0.42, Math.sin(angle) * 0.52);
        ore.rotation.set(index * 0.7, index * 1.1, index * 0.4);
        group.add(ore);
      }

      /*
       * 整座矿脉合成两块（岩体一块、矿石一块）。它虽然会**整体**缩放和显隐
       *（syncIronNodes 按储量 setScalar、挖空了隐藏），但那都是写在 group 上的；
       * 底座、四根棱柱、三颗矿石彼此之间从建好起一动不动。
       */
      mergeStaticGroup(group);
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

      // 水珠要逐颗显隐、还要各自上下浮，留着；井沿、井口、两根柱子和横木可以合。
      mergeStaticGroup(group, new Set<THREE.Object3D>(pips));
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
      // 火苗和地光每帧都在缩放 / 改透明度，必须原样留着；营地其余那几十块
      //（火圈石、柴、洞口、旗杆、石堆、木箱、斜棚、断栅）建好就再也不动。
      mergeStaticGroup(group, new Set<THREE.Object3D>([flame, glow]));
      this.scene.add(group);
      this.campViews.set(camp.id, { flame, glow });
    }
  }

  /** 仙人掌：柱状主干 + 两条手臂 + 顶花，是荒漠里唯一稳定的水源。 */
  /**
   * 仙人掌：五个 InstancedMesh 装下全场。
   *
   * 摆放参数（主干高、两条手臂高、整株朝向）和原来逐个 Mesh 的版本**逐字一致**，
   * 连 mulberry32(4127) 的取数顺序都没动 —— 主干、手臂 0、手臂 1、朝向。
   * 换掉的只是"这些参数最后落在哪儿"：以前是 Group 里九个子节点的局部变换，
   * 现在预乘成九个世界矩阵直接写进实例。仙人掌不会动，所以只算这一次。
   */
  private buildCacti(): void {
    const patches = this.simulation.cacti;
    if (patches.length === 0) return;
    const fleshMaterial = makeMaterial(0x4f7a48, 0.95);
    const flowerMaterial = new THREE.MeshStandardMaterial({ color: 0xe0567a, roughness: 0.6, emissive: 0x3a0a18 });
    const spineMaterial = makeMaterial(0xd8cba4, 0.8);
    const batch = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      perPatch: number,
      castShadow: boolean,
    ): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geometry, material, patches.length * perPatch);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // 主干和手臂是仅有的两个够大、值得进阴影图的部件；肘、花、刺原先也不投影。
      mesh.castShadow = castShadow;
      return mesh;
    };
    const trunks = batch(CACTUS_TRUNK_GEOMETRY, fleshMaterial, 1, true);
    const arms = batch(CACTUS_ARM_GEOMETRY, fleshMaterial, 2, true);
    const elbows = batch(CACTUS_ELBOW_GEOMETRY, fleshMaterial, 2, false);
    const flowers = batch(CACTUS_FLOWER_GEOMETRY, flowerMaterial, 1, false);
    const spines = batch(CACTUS_SPINE_GEOMETRY, spineMaterial, 3, false);
    const batches: CactusBatches = {
      trunks, arms, elbows, flowers, spines,
      all: [trunks, arms, elbows, flowers, spines],
    };

    const random = mulberry32(4127);
    // 局部变换 → 世界矩阵。整株的朝向和落点先转成一对四元数 / 位移，再逐部件预乘。
    const spin = new THREE.Quaternion();
    const origin = new THREE.Vector3();
    const localPosition = new THREE.Vector3();
    const localRotation = new THREE.Quaternion();
    const localEuler = new THREE.Euler();
    const worldPosition = new THREE.Vector3();
    const worldRotation = new THREE.Quaternion();
    const worldScale = new THREE.Vector3(1, 1, 1);
    const place = (): THREE.Matrix4 => new THREE.Matrix4().compose(
      worldPosition.copy(localPosition).applyQuaternion(spin).add(origin),
      worldRotation.multiplyQuaternions(spin, localRotation),
      worldScale,
    );

    patches.forEach((patch, slot) => {
      const trunkHeight = 1.6 + random() * 0.9;
      const armHeights = [0.55 + random() * 0.4, 0.55 + random() * 0.4];
      // 朝向要排在两条手臂之后取，否则整片仙人掌林的随机序列就和原来对不上了。
      spin.setFromAxisAngle(ITEM_UP, random() * Math.PI * 2);
      origin.set(patch.x, this.worldHeight(patch.x, patch.z), patch.z);

      localRotation.identity();
      // 胶囊总高 = height + 2×radius，缩放比按总高算，中心位置因此和原版分毫不差。
      const trunkBase = CACTUS_TRUNK_BASE_HEIGHT + CACTUS_TRUNK_RADIUS * 2;
      worldScale.set(1, (trunkHeight + CACTUS_TRUNK_RADIUS * 2) / trunkBase, 1);
      localPosition.set(0, trunkHeight / 2 + 0.3, 0);
      const trunk = place();

      // 两条手臂朝相反方向伸出，高度略有差异，避免看起来太对称。
      const armMatrices: THREE.Matrix4[] = [];
      const elbowMatrices: THREE.Matrix4[] = [];
      const armBase = CACTUS_ARM_BASE_HEIGHT + CACTUS_ARM_RADIUS * 2;
      for (let side = 0; side < 2; side += 1) {
        const dir = side === 0 ? 1 : -1;
        const armHeight = armHeights[side];
        worldScale.set(1, (armHeight + CACTUS_ARM_RADIUS * 2) / armBase, 1);
        localPosition.set(dir * 0.42, 0.75 + side * 0.42 + armHeight / 2, 0);
        armMatrices.push(place());

        worldScale.set(1, 1, 1);
        localRotation.setFromEuler(localEuler.set(0, 0, Math.PI / 2));
        localPosition.set(dir * 0.24, 0.75 + side * 0.42, 0);
        elbowMatrices.push(place());
        localRotation.identity();
      }

      worldScale.set(1, 1, 1);
      localPosition.set(0, trunkHeight + 0.42, 0);
      const flower = place();

      const spineMatrices: THREE.Matrix4[] = [];
      for (let index = 0; index < 3; index += 1) {
        const angle = (index / 3) * Math.PI * 2;
        localPosition.set(Math.cos(angle) * 0.31, 0.6 + index * 0.42, Math.sin(angle) * 0.31);
        // 原来写的是 rotation.z / rotation.x 两个分量，默认 XYZ 序，这里照搬。
        localRotation.setFromEuler(localEuler.set(Math.sin(angle) * 1.2, 0, -Math.cos(angle) * 1.2));
        spineMatrices.push(place());
      }
      localRotation.identity();

      this.cactusSlots.set(patch.id, slot);
      this.cactusPlacements.set(patch.id, {
        trunk, arms: armMatrices, elbows: elbowMatrices, flower, spines: spineMatrices,
      });
      this.cactusVisible.set(patch.id, true);
      this.writeCactus(patch.id, true, batches);
    });

    for (const mesh of batches.all) {
      mesh.instanceMatrix.needsUpdate = true;
      // 包围球只在这里算一次：矩阵此后只在"隐藏 / 显示"之间切，不会长出界。
      mesh.computeBoundingSphere();
    }
    this.cactusBatches = batches;
    this.scene.add(trunks, arms, elbows, flowers, spines);
  }

  /** 把一株仙人掌的九个部件写进实例；visible 为 false 时写零矩阵（同 HIDDEN_ITEM_MATRIX）。 */
  private writeCactus(id: number, visible: boolean, batches: CactusBatches | null = this.cactusBatches): void {
    const slot = this.cactusSlots.get(id);
    const placement = this.cactusPlacements.get(id);
    if (!batches || slot === undefined || !placement) return;
    batches.trunks.setMatrixAt(slot, visible ? placement.trunk : HIDDEN_ITEM_MATRIX);
    batches.flowers.setMatrixAt(slot, visible ? placement.flower : HIDDEN_ITEM_MATRIX);
    for (let index = 0; index < 2; index += 1) {
      batches.arms.setMatrixAt(slot * 2 + index, visible ? placement.arms[index] : HIDDEN_ITEM_MATRIX);
      batches.elbows.setMatrixAt(slot * 2 + index, visible ? placement.elbows[index] : HIDDEN_ITEM_MATRIX);
    }
    for (let index = 0; index < 3; index += 1) {
      batches.spines.setMatrixAt(slot * 3 + index, visible ? placement.spines[index] : HIDDEN_ITEM_MATRIX);
    }
  }

  private buildPlayer(): {
    group: THREE.Group;
    fallback: THREE.Group;
    carriedWood: THREE.Object3D;
    carriedStone: THREE.Object3D;
    carriedStake: THREE.Object3D;
    carriedFuel: THREE.Object3D;
    weaponMount: THREE.Group;
    blades: Map<WeaponKind, THREE.Group>;
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

    // 七把武器各建一个 view 挂在同一个 mount 上，靠 visible 切换。
    // 全部是程序化的低面数几何（一个柄 + 一个挤出的刃），一次性建完比按需创建简单，
    // 也避免换武器时出现一帧空手。
    const blades = new Map<WeaponKind, THREE.Group>();
    for (const [kind, spec] of Object.entries(WEAPON_VISUALS) as Array<[WeaponKind, BladeVisual]>) {
      const view = this.createBladeView(spec);
      view.visible = kind === "survival-knife";
      weaponMount.add(view);
      blades.set(kind, view);
    }

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
    const carriedStake = this.createStakeView();
    carriedStake.position.set(-0.1, 1.05, 0.75);
    carriedStake.rotation.z = Math.PI / 2;
    carriedStake.scale.setScalar(0.75);
    carriedStake.visible = false;
    group.add(carriedStake);
    const carriedFuel = createBarrelView();
    this.applyLowPowerShadowPolicy(carriedFuel);
    carriedFuel.position.set(-0.1, 1.5, 0.8);
    carriedFuel.scale.setScalar(0.85);
    carriedFuel.visible = false;
    group.add(carriedFuel);
    return { group, fallback, carriedWood, carriedStone, carriedStake, carriedFuel, weaponMount, blades, coat };
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
  private createBladeView(spec: BladeVisual): THREE.Group {
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
      if (object instanceof THREE.Mesh) object.castShadow = !this.lowPower;
    });
    return group;
  }

  /**
   * KayKit 的人物和动画分开发布，但都使用 Rig_Medium。
   * 动画轨道会按骨骼名绑定到人物，武器则挂到官方预留的 handslot.r。
   */
  /**
   * 人物模型与动画加载完毕的承诺。
   * 加载失败或还没完成都不影响开玩（有程序化替身），但开场进度条要等它 ——
   * 否则玩家刚进场就看见一个方块人，几秒后突然变成另一个人。
   */
  whenPlayerAssetReady(): Promise<void> {
    return this.playerAssetReady;
  }

  /**
   * 进入游戏画面后再并行下载动物资源。
   *
   * 每个资源独立成功、独立启用：鹿先到就只生成猎物，狼先到就只生成狼群。
   * 加载失败时不回退到程序化动物，也不通知模拟层生成对应实体，避免隐形攻击。
   *
   * ## 为什么要重试
   *
   * 这两个回调是**整局唯一**的启用入口：`onReady("deer")` 不来，模拟层的
   * `crittersEnabled` 就一直是 false，于是 `seedCritters()` 没跑过、
   * `updateCritters()` 被短路（连每 6 秒补一只的 `replenishCritters()` 也不跑），
   * 全图零猎物直到这一局结束。原先这里 catch 完只打一行 warn 就完了 ——
   * 一次网络抖动 = 这一局再也不会有任何猎物，而且没有任何补救路径。
   *
   * 三次尝试、退避 0.7s / 1.8s。不重试更多次是因为 404 这类确定性失败重试也没用，
   * 而移动网络的瞬时抖动一两次退避就够了；整个过程在后台，玩家看不见。
   */
  loadDeferredAnimalAssets(onReady: (kind: "wolf" | "deer") => void): void {
    if (this.animalAssetLoadingStarted) return;
    this.animalAssetLoadingStarted = true;

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const assetRoot = `${import.meta.env.BASE_URL}assets/animals`;
    const load = async (name: string, kind: "wolf" | "deer", assign: (asset: AnimalAsset) => void): Promise<void> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          assign(await loadAnimal(loader, `${assetRoot}/${name}`));
          onReady(kind);
          return;
        } catch (error) {
          const backoff = ANIMAL_ASSET_RETRY_BACKOFF[attempt];
          if (backoff === undefined) {
            console.warn(`${name} failed after ${attempt + 1} attempts; ${kind} population will stay disabled.`, error);
            return;
          }
          console.warn(`${name} attempt ${attempt + 1} failed; retrying in ${backoff}ms.`, error);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    };

    void Promise.all([
      load("Wolf.glb", "wolf", (asset) => { this.wolfAsset = asset; }),
      load("Deer.glb", "deer", (asset) => { this.deerAsset = asset; }),
    ]);
  }

  private async loadPlayerAsset(): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    // GitHub Pages serves the game from a project subdirectory. Resolve assets
    // from Vite's configured base instead of the site root so the model does
    // not 404 and fall back to the procedural player in production.
    const assetRoot = `${import.meta.env.BASE_URL}assets/characters/kaykit`;
    // 按"完成几个文件"报进度而不是按字节：GitHub Pages 带 Content-Encoding 时
    // ProgressEvent.total 常常是 0，字节进度会一直显示 0%。
    const files = [
      "Rogue_Hooded.glb",
      "Rig_Medium_MovementBasic.glb",
      "Rig_Medium_General.glb",
      "Rig_Medium_CombatMelee.glb",
    ];
    const totalFiles = files.length;
    let loaded = 0;
    this.onAssetProgress?.(0, totalFiles);
    const step = (): void => {
      loaded += 1;
      this.onAssetProgress?.(loaded, totalFiles);
    };

    try {
      const [character, movement, general, combat] = await Promise.all(
        files.map(async (name) => {
          const gltf = await loader.loadAsync(`${assetRoot}/${name}`);
          step();
          return gltf;
        }),
      );

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
        // 低功耗档改用贴地圆斑，见 createBlobShadowTexture 那段。
        object.castShadow = !this.lowPower;
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
    } finally {
      // 进度条不能因为资源 404 就永远停在那儿 —— 直接报满，让开场流程继续走完。
      this.onAssetProgress?.(totalFiles, totalFiles);
    }
  }

  private attachPlayerWeapons(model: THREE.Object3D): void {
    // GLTFLoader sanitizes dots out of node names so animation tracks can bind:
    // `handslot.r` becomes `handslotr` and `hand.r` becomes `handr` at runtime.
    // Keep the authored names as fallbacks for loaders that preserve punctuation.
    const rightHandSlot = model.getObjectByName("handslotr")
      ?? model.getObjectByName("handslot.r")
      ?? model.getObjectByName("handr")
      ?? model.getObjectByName("hand.r");
    if (!rightHandSlot) {
      console.warn("KayKit right-hand weapon slot was not found; weapon will remain on the fallback mount.");
      return;
    }

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
      // 全线共用劈砍：武器已经统一成刀与剑，没有长柄了，突刺无处可用。
      // 原先是 `weapon === "iron-spear" ? Stab : Chop`，第 3 阶的 fang-spear
      // 会掉进 else 分支，拿着重矛播匕首的动作 —— 和 WEAPON_STATS 那处
      // 已经修过的三元判断是同一类漏网。恒定之后这个分支问题不复存在。
      const attackName = "Melee_1H_Attack_Chop";
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
    // 贴地阴影按脚下位置画，不跟着休息下沉和呼吸浮动走。
    this.pushBlobShadow(player.x, player.z, 0.42);
    const angle = -Math.atan2(player.facing.z, player.facing.x);
    this.playerGroup.rotation.y = angle;
    const attackProgress = player.attackFlash > 0 ? 1 - player.attackFlash / 0.22 : 0;
    for (const [kind, view] of this.blades) view.visible = kind === player.weapon;
    // 剑线的连击层数写在刃身的自发光上。玩家打架时盯的是狼不是 HUD，
    // 所以最重要的战斗状态必须出现在世界里 —— HUD 上那道弧只是用来确认。
    const combo = this.simulation.getComboState();
    const activeBlade = this.blades.get(player.weapon);
    if (activeBlade && combo.max > 0) {
      const glow = combo.max > 0 ? (combo.stacks / combo.max) * 0.6 : 0;
      activeBlade.traverse((object) => {
        if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
          object.material.emissive.setHex(WEAPON_VISUALS[player.weapon].comboGlow ?? 0xffffff);
          object.material.emissiveIntensity = glow;
        }
      });
    }
    if (!this.playerModel) {
      this.weaponMount.rotation.z = -0.35 - Math.sin(attackProgress * Math.PI) * 1.7;
    }
    // 枯木已改为背包物品，手上不再显示；carriedWood 保留给放置物预览复用。
    this.carriedWood.visible = false;
    this.carriedStone.visible = player.carrying === "stone";
    this.carriedStake.visible = player.carrying === "stake";
    this.carriedFuel.visible = player.carrying === "fuel";
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

  /** 路障被啃了一口 —— 记一次闪光。id 为负表示是放置物（见模拟层的编码）。 */
  barrierHit(itemId: number): void {
    if (itemId >= 0) this.barrierFlash.set(itemId, 0.22);
  }

  private createStaticItemInstances(geometry: THREE.BufferGeometry, color: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, makeMaterial(color, 1), this.itemInstanceCapacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = !this.lowPower;
    // InstancedMesh 的初始矩阵是单位矩阵。第一帧同步前先全部压成零，避免未来调整
    // 启动顺序时在世界原点短暂堆出一百件物品。
    for (let index = 0; index < this.itemInstanceCapacity; index += 1) {
      mesh.setMatrixAt(index, HIDDEN_ITEM_MATRIX);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  /**
   * 天然物品写进实例批次。玩家放下的路障不走这里，因为它需要独立耐久色和受击发光。
   * 返回 false 只可能发生在运行时追加了超出初始容量的新物品；那种情况退回独立 Mesh。
   */
  private writeStaticItemInstance(item: GroundItem, visible: boolean): boolean {
    if (item.id < 0 || item.id >= this.itemInstanceCapacity) return false;
    this.staticWoodItems.setMatrixAt(item.id, HIDDEN_ITEM_MATRIX);
    this.staticStoneItems.setMatrixAt(item.id, HIDDEN_ITEM_MATRIX);
    if (!visible) return true;

    this.itemPosition.set(
      item.x,
      this.worldHeight(item.x, item.z) + (item.kind === "wood" ? 0.35 : 0.48),
      item.z,
    );
    this.itemRotation.setFromAxisAngle(ITEM_UP, item.rotation);
    this.itemScale.set(1, 1, 1);
    this.itemMatrix.compose(this.itemPosition, this.itemRotation, this.itemScale);
    const target = item.kind === "wood" ? this.staticWoodItems : this.staticStoneItems;
    target.setMatrixAt(item.id, this.itemMatrix);
    return true;
  }

  private removeItemView(id: number): void {
    const view = this.itemViews.get(id);
    if (!view) return;
    this.scene.remove(view);
    view.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material.dispose();
    });
    this.itemViews.delete(id);
  }

  private syncItems(delta: number): void {
    for (const [id, remaining] of this.barrierFlash) {
      const next = remaining - delta;
      if (next <= 0) this.barrierFlash.delete(id);
      else this.barrierFlash.set(id, next);
    }
    this.liveItemIds.clear();
    let woodInstancesChanged = false;
    let stoneInstancesChanged = false;
    for (const item of this.simulation.items) {
      this.liveItemIds.add(item.id);
      const flash = this.barrierFlash.get(item.id) ?? 0;
      let state = this.itemRenderStates.get(item.id);
      const changed = !state
        || state.kind !== item.kind
        || state.active !== item.active
        || state.placed !== item.placed
        || state.x !== item.x
        || state.z !== item.z
        || state.hp !== item.hp
        || state.rotation !== item.rotation
        || state.flash !== flash;
      if (!changed) continue;

      if (!state) {
        state = {
          kind: item.kind,
          active: item.active,
          placed: item.placed,
          x: item.x,
          z: item.z,
          hp: item.hp,
          rotation: item.rotation,
          flash,
        };
        this.itemRenderStates.set(item.id, state);
      } else {
        state.kind = item.kind;
        state.active = item.active;
        state.placed = item.placed;
        state.x = item.x;
        state.z = item.z;
        state.hp = item.hp;
        state.rotation = item.rotation;
        state.flash = flash;
      }

      const instanced = !item.placed && item.id < this.itemInstanceCapacity;
      if (instanced) {
        this.removeItemView(item.id);
        this.writeStaticItemInstance(item, item.active);
        woodInstancesChanged = true;
        stoneInstancesChanged = true;
        continue;
      }

      // 独立 Mesh 与两个实例批次互斥。容量外的新物品也会安全地落到这条后备路径。
      if (item.id < this.itemInstanceCapacity) {
        this.writeStaticItemInstance(item, false);
        woodInstancesChanged = true;
        stoneInstancesChanged = true;
      }
      let view = this.itemViews.get(item.id);
      if (view && view.userData.kind !== item.kind) {
        this.removeItemView(item.id);
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
      // 除数取真实上限：石头 1500、枯木 70。原先石头写死 220，
      // 于是它掉到最后 15% 血才开始变色，前面 85% 挨打毫无反馈。
      const health = clamp(item.hp / BARRIER_STATS[item.kind].hp, 0, 1);
      const isBarrier = item.kind === "stone" || item.placed;
      view.scale.setScalar(isBarrier ? 0.55 + health * 0.45 : 1);
      // 缩放在小屏上读不出来（看着像透视），颜色才是能读的信号：
      // 越残破越暗越发红，挨打的瞬间还会亮一下。
      if (isBarrier) {
        const base = view.userData.baseColor as number;
        view.traverse((child) => {
          const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (!material || !material.isMeshStandardMaterial) return;
          /*
           * 从**本色**往破损色插值，不能直接 setRGB 出一个绝对颜色。
           *
           * 原先写的是 `setRGB(0.28 + health*0.72, …)`，满血时算出来正好是纯白 ——
           * 石头本色 0x748084 是灰蓝、枯木是褐色，一放下就全变白。
           * 天然石头和玩家放下的路障都要走这段，否则天然石头挨咬时没有任何反馈、
           * 直到耐久归零才突然消失。
           */
          material.color.setHex(base).lerp(BARRIER_DAMAGE_TINT, 1 - health);
          material.emissive.setRGB(flash * 3.2, flash * 1.1, flash * 0.6);
        });
      }
    }

    // 正常游戏里物品槽只会停用和复用，不会删除；这段为软重启和未来内容变更兜底。
    for (const id of this.itemRenderStates.keys()) {
      if (this.liveItemIds.has(id)) continue;
      if (id < this.itemInstanceCapacity) {
        this.staticWoodItems.setMatrixAt(id, HIDDEN_ITEM_MATRIX);
        this.staticStoneItems.setMatrixAt(id, HIDDEN_ITEM_MATRIX);
        woodInstancesChanged = true;
        stoneInstancesChanged = true;
      }
      this.removeItemView(id);
      this.itemRenderStates.delete(id);
    }
    if (woodInstancesChanged) {
      this.staticWoodItems.instanceMatrix.needsUpdate = true;
      this.staticWoodItems.computeBoundingSphere();
    }
    if (stoneInstancesChanged) {
      this.staticStoneItems.instanceMatrix.needsUpdate = true;
      this.staticStoneItems.computeBoundingSphere();
    }
  }

  private createItemView(item: GroundItem): THREE.Object3D {
    const geometry = item.kind === "wood" ? WOOD_ITEM_GEOMETRY : STONE_ITEM_GEOMETRY;
    const color = item.kind === "wood" ? WOOD_COLOR : STONE_COLOR;
    const view = new THREE.Mesh(geometry, makeMaterial(color, 1));
    // 低功耗档：地上的枯木与石头不投影。它们贴地、影子只有一小片；
    // 天然物品已经批成实例，玩家放下的少量独立路障也沿用同一画质规则。
    view.castShadow = !this.lowPower;
    view.userData.kind = item.kind;
    // 记下本色，破损染色要从它出发插值（见 syncItems）。
    view.userData.baseColor = item.kind === "wood" ? WOOD_COLOR : STONE_COLOR;
    return view;
  }

  private syncCacti(): void {
    const batches = this.cactusBatches;
    if (!batches) return;
    let changed = false;
    for (const patch of this.simulation.cacti) {
      // 割光的仙人掌整株隐藏，等它自己长回来。
      const visible = patch.juice > 0;
      if (this.cactusVisible.get(patch.id) === visible) continue;
      this.cactusVisible.set(patch.id, visible);
      this.writeCactus(patch.id, visible, batches);
      changed = true;
    }
    if (!changed) return;
    for (const mesh of batches.all) mesh.instanceMatrix.needsUpdate = true;
    // 主干和手臂在阴影图里，割光/长回要立刻重画 —— 同 syncTrees，等不到 30 帧兜底。
    this.markShadowDirty();
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

  /** 放置物按需建视图 —— 它们是运行时才出现的，不能像地形那样一次性建完。 */
  private syncStructures(): void {
    for (const structure of this.simulation.structures) {
      let view = this.structureViews.get(structure.id);
      if (!view) {
        view = this.createStakeView();
        this.applyLowPowerShadowPolicy(view);
        this.scene.add(view);
        this.structureViews.set(structure.id, view);
      }
      // 树桩可以被搬走，已有视图也必须持续同步位置与朝向。
      view.position.set(structure.x, this.worldHeight(structure.x, structure.z), structure.z);
      view.rotation.y = structure.rotation;
      view.visible = structure.active;
      // 被啃过的树桩矮下去一截，远处也能看出防线快破了。
      view.scale.y = 0.55 + (structure.hp / structure.maxHp) * 0.45;
    }
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
    const liveIds = this.liveCritterIds;
    liveIds.clear();
    for (const critter of this.simulation.critters) {
      liveIds.add(critter.id);
      let view = this.critterViews.get(critter.id);
      if (!view) {
        view = this.createCritterView(critter);
        this.critterViews.set(critter.id, view);
        this.scene.add(view.group);
      }
      if (this.lowPower) {
        const far = Math.hypot(critter.x - this.simulation.player.x, critter.z - this.simulation.player.z)
          > GameRenderer.LOW_POWER_DRAW_DISTANCE;
        view.group.visible = !far;
        if (far) continue;
      }
      const spec = CRITTER_SPECS[critter.kind];
      const terrainY = this.worldHeight(critter.x, critter.z);
      view.animal?.mixer.update(delta);
      view.group.position.set(critter.x, terrainY, critter.z);
      // 剑羚是唯一大到能看清的猎物，影子也给得大一档；其余七种半米上下。
      if (critter.mode !== "dead") this.pushBlobShadow(critter.x, critter.z, critter.kind === "oryx" ? 0.5 : 0.22);
      // 朝向走**最短弧**插值，不能直接赋值也不能对角度做朴素 lerp：
      // 后者在 ±π 交界处会绕远路转一整圈，正好发生在猎物调头的那一刻。
      // 模拟层已经限了转向速率（CritterSpec.turnRate），这里是第二层保险，
      // 专治地形推挤造成的单帧抖动。
      view.group.rotation.y = dampAngle(
        view.group.rotation.y, -Math.atan2(critter.facing.z, critter.facing.x), 14, delta,
      );
      const fade = critter.mode === "dead" ? clamp(critter.deathTimer / 0.7, 0, 1) : 1;
      view.group.scale.setScalar((view.animal ? ORYX_HEIGHT : spec.scale) * fade);
      if (critter.mode === "dead") {
        // 有 Death 片段的就让片段自己演；程序化几何没有动画，只能靠侧翻表达倒地。
        // 两者都保留"缩小消失"，那是尸体退场的统一语言。
        if (view.animal) view.animal.play("Death", { loop: false, fade: 0.08 });
        else view.group.rotation.z = lerp(view.group.rotation.z, Math.PI / 2, delta * 8);
      } else {
        view.group.rotation.z = 0;
        if (view.animal) {
          // 逃跑用 Gallop、吃草用 Walk。播放速度跟着实际移速走 ——
          // 长角羚吃草 1.4、逃跑 10.5，同一个 Walk 拿来两用会像开了快进。
          view.animal.play(critter.mode === "flee" ? "Gallop" : "Walk", {
            timeScale: clamp(critter.mode === "flee" ? spec.fleeSpeed / 7 : spec.grazeSpeed / 1.1, 0.6, 1.9),
          });
        } else {
          // 使用连续的落脚曲线，避免 abs(sin) 在触地瞬间形成尖角，看起来像模型发抖。
          const bounce = critter.mode === "flee" ? 0.07 : 0.012;
          const rate = critter.mode === "flee" ? 10 : 2.5;
          const stride = (1 - Math.cos(this.time * rate + critter.id * 0.83)) * 0.5;
          view.group.position.y = terrainY + stride * bounce;
        }
      }
      // 顶点色是被 material.color 乘上去的，所以程序化猎物平时保持纯白；
      // 鹿没有顶点色，平时要保持它自己的沙褐主色。
      view.bodyMaterial.color.setHex(critter.hurtFlash > 0 ? 0xff5a55 : view.baseColor);
    }
    for (const [id, view] of this.critterViews) {
      if (liveIds.has(id)) continue;
      this.disposeCritterView(view);
      this.critterViews.delete(id);
    }
  }

  private createCritterView(critter: CritterState): CritterView {
    // 几何按种类共享（见 CritterModels 的缓存），材质每只一份 ——
    // 受击闪红是逐只的，共享材质会让同种猎物一起变红。
    const group = new THREE.Group();
    // 长角羚是唯一一个**玩家会专门去追**的猎物（90 血 / 肉 + 皮 + 水），
    // 也是唯一大到能看清动作的 —— 所以只有它值得一份带骨骼的素材。
    // 其余七种都在半米上下，从等距视角看就是几个色块，程序化几何足够。
    if (critter.kind === "oryx" && this.deerAsset) {
      const animal = instantiateAnimal(this.deerAsset);
      group.add(animal.root);
      // 剑羚的配色：沙褐身子 + 近白的腹面 + 近黑的面部与腿纹。
      // 素材自带的三个色槽正好对上，不用改一个顶点。
      const main = animal.materials.get("Main");
      const light = animal.materials.get("Main_Light");
      const dark = animal.materials.get("Main_Dark");
      if (main) main.color.setHex(ORYX_COAT);
      if (light) light.color.setHex(0xefe3cd);
      if (dark) dark.color.setHex(0x2e2620);
      this.applyLowPowerShadowPolicy(group);
      return { group, bodyMaterial: main ?? makeMaterial(ORYX_COAT, 0.95), animal, baseColor: ORYX_COAT };
    }
    const { mesh, material } = createCritterMesh(critter.kind);
    group.add(mesh);
    this.applyLowPowerShadowPolicy(group);
    return { group, bodyMaterial: material, animal: null, baseColor: 0xffffff };
  }

  private syncWolves(delta: number): void {
    const liveIds = this.liveWolfIds;
    liveIds.clear();
    for (const wolf of this.simulation.wolves) {
      liveIds.add(wolf.id);
      let view = this.wolfViews.get(wolf.id);
      if (!view) {
        view = this.createWolfView(wolf);
        this.wolfViews.set(wolf.id, view);
        this.scene.add(view.group);
        this.scene.add(view.bar);
      }
      if (this.lowPower) {
        const far = Math.hypot(wolf.x - this.simulation.player.x, wolf.z - this.simulation.player.z)
          > GameRenderer.LOW_POWER_DRAW_DISTANCE;
        // 远处的狗跳过全部同步：动画混合器、朝向插值、血条、材质染色都不用算。
        // 近处的血条交回 syncWolfBar 决定（它只在受伤后亮 2.6 秒）。
        view.group.visible = !far;
        if (far) { view.bar.visible = false; continue; }
      }
      this.syncWolfBar(wolf, view, delta);
      const movedX = wolf.x - view.lastPosition.x;
      const movedZ = wolf.z - view.lastPosition.y;
      const movedDistance = Math.hypot(movedX, movedZ);
      // 只让真正的位移改变显示朝向。寻路会在障碍前左右试探 facing；狼没有移动时
      // 跟着它转，会表现成站在原地高频甩身。
      const movingNow = wolf.mode !== "dead" && movedDistance > Math.max(0.003, delta * 0.12);
      if (movingNow && wolf.hurtFlash <= 0) {
        const inverseDistance = 1 / movedDistance;
        const directionBlend = 1 - Math.exp(-delta * 10);
        view.travelDirection.x = lerp(view.travelDirection.x, movedX * inverseDistance, directionBlend);
        view.travelDirection.y = lerp(view.travelDirection.y, movedZ * inverseDistance, directionBlend);
        if (view.travelDirection.lengthSq() > 0.01) view.travelDirection.normalize();
        const travelHeading = -Math.atan2(view.travelDirection.y, view.travelDirection.x);
        const turnSpeed = wolf.mode === "chase" || wolf.mode === "retreating" ? 11 : 7;
        view.visualHeading = dampAngle(view.visualHeading, travelHeading, turnSpeed, delta);
      }
      const actualSpeed = delta > 0 ? movedDistance / delta : 0;
      const targetMoveAmount = movingNow ? clamp(actualSpeed / Math.max(wolf.speed, 0.1), 0, 1) : 0;
      const movementBlend = 1 - Math.exp(-delta * (movingNow ? 18 : 14));
      view.moveAmount = lerp(view.moveAmount, targetMoveAmount, movementBlend);
      view.lastPosition.set(wolf.x, wolf.z);
      view.group.position.set(wolf.x, this.worldHeight(wolf.x, wolf.z) + (wolf.mode === "dead" ? 0.2 : 0), wolf.z);
      // 尸体不画影子：它平躺在地上，圆斑压在身下只会看着脏。
      if (wolf.mode !== "dead") this.pushBlobShadow(wolf.x, wolf.z, 0.46 * wolfBarScale(wolf));
      view.group.rotation.y = view.visualHeading;
      view.group.scale.setScalar(wolfScale(wolf));
      view.animal?.mixer.update(delta);
      if (view.animal) {
        // 手工摆骨头那一整套（迈腿、点头、张嘴、翘尾、倒地侧翻）全删了 ——
        // 现在由素材自带的片段承担。侧翻尤其不能留：Death 片段本身就是倒地，
        // 再叠一个 90° 侧滚会把狗翻到肚皮朝天。
        view.group.rotation.z = 0;
        this.syncWolfAnimation(wolf, view);
      } else if (wolf.mode === "dead") {
        view.group.rotation.z = lerp(view.group.rotation.z, Math.PI / 2, delta * 8);
      } else {
        view.group.rotation.z = 0;
      }
      const bodyColor = wolf.hurtFlash > 0 ? 0xe04a46
        : wolf.mode === "retreating" ? 0x7d9094
          : wolfBodyColor(wolf);
      const bellyColor = wolf.hurtFlash > 0 ? 0xe04a46
        : wolf.mode === "retreating" ? 0x9fb0b4
          : wolfBellyColor(wolf);
      view.tinted.forEach((material, index) => {
        material.color.setHex(index === 0 ? bodyColor : bellyColor);
        material.emissive.setHex(wolf.mode === "chase" ? 0x160000 : 0x000000);
      });
    }
    for (const [id, view] of this.wolfViews) {
      if (liveIds.has(id)) continue;
      this.disposeWolfView(view);
      this.wolfViews.delete(id);
    }
  }

  /**
   * 头顶血条的显示规则。
   *
   * 不常驻：夜里地图上有几十只狼，全挂血条就是一片红。只在**这一刻挨了打**之后
   * 亮 2.6 秒，够看清掉了多少血、够判断还要几刀。所有狼统一遵守这条规则，
   * 精英狼也不再占用一条常驻 BOSS 血槽。
   */
  private syncWolfBar(wolf: WolfState, view: WolfView, delta: number): void {
    if (wolf.health < view.lastHealth) view.barTimer = WOLF_BAR_SECONDS;
    view.lastHealth = wolf.health;
    view.barTimer = Math.max(0, view.barTimer - delta);

    const visible = wolf.mode !== "dead" && view.barTimer > 0;
    view.bar.visible = visible;
    if (!visible) return;

    const barScale = wolfBarScale(wolf);
    const ratio = clamp(wolf.health / wolf.maxHealth, 0, 1);
    // 精灵缩放以中心为基准，所以填充条要一边缩一边往左挪，左端才钉得住。
    const width = WOLF_BAR_WIDTH * barScale;
    view.barFill.scale.set(width * ratio, WOLF_BAR_HEIGHT * barScale, 1);
    view.barFill.position.x = -width * (1 - ratio) * 0.5;
    // wolfScale 就是这只狗的世界高度，所以血条直接挂在"头顶再抬 0.45"。
    view.bar.position.set(
      wolf.x,
      this.worldHeight(wolf.x, wolf.z) + wolfScale(wolf) + 0.45,
      wolf.z,
    );
    // 最后 0.5 秒淡出，避免"啪"地消失。
    const opacity = clamp(view.barTimer / 0.5, 0, 1);
    view.barFill.material.opacity = opacity;
    (view.bar.children[0] as THREE.Sprite).material.opacity = opacity * 0.72;
  }

  private syncDrops(): void {
    const liveIds = this.liveDropIds;
    liveIds.clear();
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
      const hide = new THREE.Mesh(DROP_HIDE_GEOMETRY, this.dropHideMaterial);
      hide.rotation.x = -Math.PI / 2;
      hide.scale.set(1.25, 0.82, 1);
      // 兽皮是一张贴地的圆片，影子和它自己基本重合 —— 低功耗档不投影，看不出来。
      hide.castShadow = !this.lowPower;
      return hide;
    }
    const group = new THREE.Group();
    const meat = new THREE.Mesh(DROP_MEAT_GEOMETRY, this.dropMeatMaterial);
    meat.scale.set(1.25, 0.65, 0.9);
    // 夜里一场仗能掉几十份肉皮牙，全在玩家脚边 —— 正好落在阴影相机里。
    meat.castShadow = !this.lowPower;
    group.add(meat);
    const bone = new THREE.Mesh(DROP_BONE_GEOMETRY, this.dropBoneMaterial);
    bone.rotation.z = Math.PI / 2;
    bone.position.y = 0.08;
    group.add(bone);
    return group;
  }

  private disposeWolfView(view: WolfView): void {
    this.scene.remove(view.group);
    this.scene.remove(view.bar);
    view.animal?.dispose();
    for (const material of view.tinted) material.dispose();
    for (const child of view.bar.children) (child as THREE.Sprite).material.dispose();
  }

  private disposeCritterView(view: CritterView): void {
    this.scene.remove(view.group);
    view.animal?.dispose();
    view.bodyMaterial.dispose();
  }

  private createWolfView(wolf: WolfState): WolfView {
    const group = new THREE.Group();
    const animal = this.wolfAsset ? instantiateAnimal(this.wolfAsset) : null;
    const tinted: THREE.MeshStandardMaterial[] = [];
    if (animal) {
      group.add(animal.root);
      // 只染毛色与腹面：鼻头和眼睛留素材原样，不然整只狗糊成一个色块。
      const main = animal.materials.get("Main");
      const light = animal.materials.get("Main_Light");
      if (main) { main.color.setHex(wolfBodyColor(wolf)); tinted.push(main); }
      if (light) { light.color.setHex(wolfBellyColor(wolf)); tinted.push(light); }
    } else {
      const fallback = createFallbackDog(wolfBodyColor(wolf));
      group.add(fallback.mesh);
      tinted.push(fallback.material);
    }
    this.applyLowPowerShadowPolicy(group);
    const { bar, fill } = createWolfBar(wolf);
    return {
      group,
      animal,
      tinted,
      lastPosition: new THREE.Vector2(wolf.x, wolf.z),
      visualHeading: -Math.atan2(wolf.facing.z, wolf.facing.x),
      travelDirection: new THREE.Vector2(wolf.facing.x, wolf.facing.z).normalize(),
      moveAmount: 0,
      bar,
      barFill: fill,
      barTimer: 0,
      lastHealth: wolf.health,
    };
  }

  /**
   * 狗该播哪个片段。
   *
   * 驱动量用的是 `view.moveAmount`（真实位移 / 名义移速）而不是 `wolf.mode` ——
   * 那是主线为了修"原地甩身"引进来的量，正好也是动画最该跟的量：
   * 被地形卡住的狗 moveAmount 会掉到 0，于是它站着喘气而不是原地滑步。
   */
  private syncWolfAnimation(wolf: WolfState, view: WolfView): void {
    const animal = view.animal;
    if (!animal) return;
    if (wolf.mode === "dead") {
      animal.play("Death", { loop: false, fade: 0.08 });
      return;
    }
    // 咬击：AI 咬完把冷却重置到 1.15 秒。取前 0.53 秒当扑咬窗口，配 2.5 倍速 ——
    // Attack 片段本身 1.33 秒，正好在窗口里播完一遍。窗口再短就只能看到片段的
    // 前三分之一，那看着不像咬，像抽搐。
    if (wolf.mode === "chase" && wolf.attackCooldown > 0.62) {
      animal.play("Attack", { loop: false, fade: 0.05, timeScale: 2.5 });
      return;
    }
    if (view.moveAmount <= 0.035) {
      animal.play("Idle");
      return;
    }
    // 跑的播放速度跟着这只狗的实际移速走 —— 每夜 +4% 移速的成长曲线，
    // 玩家因此能从"腿倒得更快"上看出来，而不只是数值上快了。
    const pace = wolf.speed * view.moveAmount;
    if (wolf.mode === "chase" || wolf.mode === "raid" || wolf.mode === "retreating") {
      animal.play("Gallop", { timeScale: clamp(pace / 3.4, 0.7, 1.8) });
      return;
    }
    animal.play("Walk", { timeScale: clamp(pace / 3.0, 0.6, 1.5) });
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
    /*
     * 沙漠昼夜温差极大，配色也走两个极端：
     * 白天是被尘霾漂白的暖黄，夜晚是冷到发青的深蓝 —— 视觉上直接对应体温轴的两端。
     *
     * ## 白天这一半重调过一次：冷暖分离
     *
     * 原来白天四盏光**全是暖的**（天空 d8bf8d / 半球天 ffeec4 / 半球地 8a6a44 /
     * 太阳 fff0cc），于是整张画面的明度全挤在 55%~85% 之间、色相只有一个 ——
     * 沙丘的体积读不出来，远近也分不开，看上去像一块糊掉的黄板。
     * （夜晚那一半没有这个毛病，它本来就是冷的，所以一个数没动。）
     *
     * 现在只改**填充光**，不动主光：太阳仍然是暖的（沙漠正午就该这样），
     * 但天空/半球两盏填充光转成带尘的冷调 —— 现实里晴天的阴影本来就是天光染蓝的，
     * 这既是物理上对的，也正是低多边形风格"看起来贵"的那条分界线。
     * 三个数配合着改，缺一个都不成立：
     *
     *   DAY_SKY        d8bf8d → c9c3b4   天边不再和沙子同色，雾一拉开就有了纵深
     *   DAY_HEMI_SKY   ffeec4 → cdd8e6   朝上的面吃冷光，朝向太阳的面吃暖光 = 冷暖分离
     *   DAY_HEMI_ANGLE 2.2    → 1.15     环境光越强阴影越浅；砍一半，沙丘才有背光面
     *
     * 半球光砍掉的亮度由太阳补回去（3.2 → 4.1），整体曝光不变，变的只有**对比**。
     */
    const sky = this.dayNightSky.lerpColors(NIGHT_SKY, DAY_SKY, daylight);
    this.scene.background = sky;
    if (this.scene.fog) this.scene.fog.color.copy(sky);
    this.hemisphere.color.lerpColors(NIGHT_HEMI_SKY, DAY_HEMI_SKY, daylight);
    this.hemisphere.groundColor.lerpColors(NIGHT_HEMI_GROUND, DAY_HEMI_GROUND, daylight);
    // 夜晚半球光强度从 1.34 提到 1.85，让地形细节可见
    /*
     * 教学期间把环境光压到四成。
     *
     * 压的是**环境光**而不是画面：曝光和天空色都跟着走，于是画面看起来像
     * 一片被云遮住的沙漠，而那盏聚光灯下面还是亮的 —— 这正是"很低的灯光 +
     * 一束聚光"该有的样子，而且它整个发生在画布里，录像抓得到。
     *
     * 不压到零：全黑的话玩家看不见自己要走去的方向，教学第一步就废了。
     * 四成是实测下来"明显暗了但仍然认得出地形"的位置。
     */
    const dim = lerp(1, 0.4, this.tutorialLight);
    this.hemisphere.intensity = lerp(1.85, DAY_HEMI_INTENSITY, daylight) * dim;
    this.sun.color.lerpColors(NIGHT_SUN, DAY_SUN, daylight);
    // 夜晚太阳（当作月光）强度从 0.82 提到 1.45，地面不再糊成一片
    this.sun.intensity = lerp(1.45, DAY_SUN_INTENSITY, daylight) * dim;
    // 夜晚曝光略提，让篝火光圈外也能辨识
    this.renderer.toneMappingExposure = lerp(1.12, 1.05, daylight) * lerp(1, 0.82, this.tutorialLight);
    if (this.tutorialLight > 0.01 && this.scene.background instanceof THREE.Color) {
      // 天空也要跟着暗，否则地面压下去了、天边还亮着，像贴了张纸。
      this.scene.background.multiplyScalar(lerp(1, 0.45, this.tutorialLight));
      this.scene.fog?.color.copy(this.scene.background);
    }
  }

  private updateCamera(delta: number): void {
    const player = this.simulation.player;
    const smoothing = 1 - Math.exp(-delta * 5.5);
    /*
     * 相机想看的那个点。平时就是玩家，过场期间在玩家和过场目标之间插值。
     *
     * 两段插值叠在一起：这里按 1.35 / 1.0 秒把**目标点**推过去，
     * 下面那三行再用原有的指数平滑追这个目标 —— 于是推镜是软起软停的，
     * 不需要单独写缓动曲线。去程慢于回程：推出去要有分量，收回来要利落。
     */
    const wantsPan = this.cameraPanTarget !== null;
    this.cameraPan = clamp(this.cameraPan + delta / (wantsPan ? 1.35 : -1.0), 0, 1);
    const anchor = this.cameraPan > 0 ? this.cameraPanAnchor : null;
    const goalX = anchor ? lerp(player.x, anchor.x, this.cameraPan) : player.x;
    const goalZ = anchor ? lerp(player.z, anchor.z, this.cameraPan) : player.z;
    this.cameraFocus.x = lerp(this.cameraFocus.x, goalX, smoothing);
    this.cameraFocus.z = lerp(this.cameraFocus.z, goalZ, smoothing);
    this.cameraFocus.y = lerp(this.cameraFocus.y, this.worldHeight(goalX, goalZ), smoothing);
    /*
     * 竖屏（小屏且高大于宽）比横屏拉得远：那个比例下横向只剩一条窄缝，不拉远看不到两侧。
     *
     * 这两档是**分开调的**：竖屏那个数是为了补视野，横屏那个数是为了补可读性，
     * 合成一个系数的话动一个必然弄坏另一个。
     *
     * 两档往近走过几轮（横屏 0.80 → 0.70 → 0.64 → 0.58，竖屏 1.18 → 1.08 → 0.98），
     * 1.0.30 停在**较远**的那一档：竖屏 1.08、横屏 0.64。按 47° FOV 算的旧表：
     *
     *   横屏 844×390   距离 28.8 → 23.1   横向可见 54.2m → 43.4m   角色占屏高 10.4% → 13.0%
     *   竖屏 390×844   距离 42.5 → 38.9   横向可见 17.1m → 15.6m   角色占屏高  7.0% →  7.7%
     *
     * 当前值的**实测**可见半径：在真实视口里按方位角逐个二分，找地面点还在画面内的最远距离。
     * 这比"横向可见"有用得多 —— 等距视角下可见范围**极不对称**，朝镜头那一侧和背镜头
     * 那一侧差着八倍，而所有"什么时候该出现/该消失"的判断（守卫仇恨、剔除距离）
     * 吃的都是这两个极值，不是那个平均意义上的横向宽度：
     *
     *                    最小可见半径   最大可见半径      （括号内是 0.98/0.58 那一档）
     *   竖屏 375×812         9.4m          80.2m          (8.5m / 74.8m)
     *   横屏 844×390        11.0m          52.1m          (9.9m / 48.0m)
     *
     * 距离系数是**纯相似变换**（方向 (19,24,19) 归一化后与系数无关，FOV 也不动），
     * 所以上面每个数都随系数线性缩放，改系数不需要重新实测一遍。
     *
     * ## 为什么停在较远这一档 —— 这是判断，不是数据
     *
     * 两档都跑过 Poki Player Fit Test，**结果分不出来**。噪音底是同一个包跨时段的差：
     *
     *   1.0.28   22 Aug 12:04 CEST   3m30s   28 fps
     *   1.0.28   23 Aug 17:25 CEST   3m12s   31 fps   ← 代码完全相同，差 20 秒
     *
     * 而版本间的差全落在这 20 秒以内。所以**别再用平均时长给这两个数做 A/B**，
     * 那把尺子的刻度比这个改动的效应大一个数量级。曾经有人（我）在一个 2 秒的差上
     * 反推出"5m+ 那格人均从 11.1 掉到 9.8 分钟、是拉近害了远途导航"——那是过度解读，
     * 同时实测过几何侧：两档下 draw call 与三角数**逐个相同**（45 / 118,265）。
     *
     * 选较远这一档的理由是两条可验证的余量，跟指标无关：
     *   1. 野外六桶按到卡车的距离分档 30~55m / 55~85m / 85~125m，最后一两桶要走远门，
     *      可见范围多 9% 直接作用在这段路上；
     *   2. 守巢犬仇恨半径 8 米要求"醒的那一刻它在画面里"，而下限是最小可见半径 ——
     *      这一档是 9.4m（余 1.4m），拉近那一档只有 8.5m（余 0.5m）。见 WolfDirector。
     *
     * 想调就按可读性调，用眼睛判断，别拿 Fit Test 当依据。
     *
     * 还剩多少视野是这条的下限：开场斥候在 27 米、教学猎物在 5.5~7 米，都还在画面里。
     */
    const portrait = window.innerWidth < 760 && window.innerWidth < window.innerHeight;
    const distanceScale = portrait ? PORTRAIT_CAMERA_SCALE : LANDSCAPE_CAMERA_SCALE;
    const shakeX = (Math.random() - 0.5) * this.cameraShake;
    const shakeZ = (Math.random() - 0.5) * this.cameraShake;
    this.camera.position.set(
      this.cameraFocus.x + 19 * distanceScale + shakeX,
      this.cameraFocus.y + 24 * distanceScale,
      this.cameraFocus.z + 19 * distanceScale + shakeZ,
    );
    this.camera.lookAt(this.cameraFocus.x, this.cameraFocus.y + 0.8, this.cameraFocus.z);
    this.cameraShake = Math.max(0, this.cameraShake - delta * 0.8);
    /*
     * 低功耗档的太阳交给 scheduleShadowUpdate 管：那边只在重锚那一帧挪，
     * 挪灯必须和重画阴影图同一帧发生，否则灯和贴图对不上。
     */
    if (!this.lowPower) {
      this.sun.position.set(this.cameraFocus.x - 35, this.cameraFocus.y + 55, this.cameraFocus.z + 25);
      this.sun.target.position.set(this.cameraFocus.x, this.cameraFocus.y, this.cameraFocus.z);
      this.sun.target.updateMatrixWorld();
    }
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
  private buildWarmthAura(): { group: THREE.Group; ring: THREE.Mesh; motes: THREE.Points } {
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

  private updateWarmthAura(delta: number): void {
    const player = this.simulation.player;
    // 白天也在火边，但白天烤火只会把人推向中暑 —— 那不是"取暖"，不该给正反馈。
    const warming = this.simulation.phase === "night" && this.simulation.isWarmedByFire();
    // 0.55 秒淡入、0.85 秒淡出：走出火圈时留一点余韵，免得在边界上反复闪。
    this.warmthAmount = clamp(this.warmthAmount + delta / (warming ? 0.55 : -0.85), 0, 1);
    this.warmthAura.visible = this.warmthAmount > 0.01;
    if (!this.warmthAura.visible) return;

    this.warmthAura.position.set(player.x, this.worldHeight(player.x, player.z), player.z);
    // 呼吸感全部来自这一条：环在 0.86~1.06 之间缓慢起伏，人站着不动时画面也没死。
    const breathe = 0.96 + Math.sin(this.time * 2.1) * 0.1;
    this.warmthRing.scale.setScalar(breathe);
    (this.warmthRing.material as THREE.MeshBasicMaterial).opacity = this.warmthAmount * 0.34;

    const attribute = this.warmthMotes.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    for (let index = 1; index < array.length; index += 3) {
      array[index] += delta * (0.75 + (index % 7) * 0.09);
      if (array[index] > 2.3) array[index] = 0;
    }
    attribute.needsUpdate = true;
    (this.warmthMotes.material as THREE.PointsMaterial).opacity = this.warmthAmount * 0.85;
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
