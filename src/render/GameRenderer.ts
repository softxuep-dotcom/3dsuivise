import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
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
const PORTRAIT_CAMERA_SCALE = 1.18;
const LANDSCAPE_CAMERA_SCALE = 0.92;

/** 可搬运物的本色，以及被啃到快碎时染向的暗红。 */
const STONE_COLOR = 0x748084;
const WOOD_COLOR = 0x65432d;
const BARRIER_DAMAGE_TINT = new THREE.Color(0x47231c);

/** 长角羚的沙褐主色。 */
const ORYX_COAT = 0xc19a63;
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
  private readonly carriedStake: THREE.Object3D;
  private readonly carriedFuel: THREE.Object3D;
  private readonly truckGroup: THREE.Group;
  /** 车斗上那一排已装的油桶，按 loaded 逐个点亮。 */
  private readonly truckLoadViews: THREE.Object3D[] = [];
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
  private readonly itemViews = new Map<number, THREE.Object3D>();
  /** 路障挨打后的闪光余量（秒），按物品 id 记。 */
  private readonly barrierFlash = new Map<number, number>();
  private readonly cactusViews = new Map<number, THREE.Object3D>();
  private readonly ironViews = new Map<number, THREE.Object3D>();
  private readonly wellViews = new Map<number, THREE.Object3D>();
  private readonly wellPips = new Map<number, THREE.Object3D[]>();
  private readonly structureViews = new Map<number, THREE.Object3D>();
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
  private readonly onAssetProgress?: (loaded: number, total: number) => void;
  private readonly playerAssetReady: Promise<void>;
  /** Quaternius 的狼与鹿；加载失败时保持 null，视图会退回程序化替身。 */
  private wolfAsset: AnimalAsset | null = null;
  private deerAsset: AnimalAsset | null = null;

  constructor(
    root: HTMLElement,
    world: WorldDefinition,
    simulation: GameSimulation,
    onAssetProgress?: (loaded: number, total: number) => void,
  ) {
    this.world = world;
    this.simulation = simulation;
    this.onAssetProgress = onAssetProgress;
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
    this.buildDens();
    this.buildCamps();
    this.buildCacti();
    this.buildIronNodes();
    this.buildWells();
    this.truckGroup = this.buildTruck();
    this.buildBarrels();
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
    this.syncItems(delta);
    this.syncBarrels();
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
      this.scene.add(group);
    }
  }

  /**
   * 卡车。用的是 wreck 地标那套零件的"完好版"—— 同一种视觉语言，
   * 但它是唯一一辆车斗完整、有驾驶室、有油箱口的车，玩家一眼能认出这台不一样。
   */
  private buildTruck(): THREE.Group {
    const group = new THREE.Group();
    const body = makeMaterial(0x8a6236, 1);
    const iron = makeMaterial(0x5e554a, 0.95);
    const glass = makeMaterial(0x3d5560, 0.4);

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
      const panel = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.9, sz), body);
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

    // 车斗里五个油桶位，装一桶亮一个。
    for (let index = 0; index < FUEL_REQUIRED; index += 1) {
      const slot = createBarrelView();
      slot.position.set(-2.45 + (index % 3) * 1.15, 1.5, index < 3 ? -0.6 : 0.62);
      slot.scale.setScalar(0.82);
      slot.visible = false;
      group.add(slot);
      this.truckLoadViews.push(slot);
    }

    this.scene.add(group);
    return group;
  }

  private buildBarrels(): void {
    for (const barrel of this.simulation.barrels) {
      const view = createBarrelView();
      view.rotation.y = barrel.rotation;
      this.scene.add(view);
      this.barrelViews.set(barrel.id, view);
    }
  }

  /** 地上的油桶跟着地形贴地；被扛走或装了车的那些直接隐藏。 */
  private syncBarrels(): void {
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
    this.truckLoadViews.forEach((slot, index) => {
      slot.visible = index < truck.loaded;
    });
    // 驶离时玩家在车里。模拟层把人的坐标锁在车心，所以直接把人藏掉 ——
    // 否则最后 5 秒会看到一个人站在车斗中央被拖出地图。
    this.playerGroup.visible = !this.simulation.isDeparting();
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
      if (object instanceof THREE.Mesh) object.castShadow = true;
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
    const animalRoot = `${import.meta.env.BASE_URL}assets/animals`;
    // 动物也算进同一条进度：它们和人物一样是"进场前就该到位"的东西 ——
    // 玩家不该看着一只方块狗在第 3 秒突然变成一只狼。
    const totalFiles = files.length + 2;
    let loaded = 0;
    this.onAssetProgress?.(0, totalFiles);
    const step = (): void => {
      loaded += 1;
      this.onAssetProgress?.(loaded, totalFiles);
    };

    // 每个动物各自 catch：狼加载不出来不该把鹿或人物一起拖下水。
    // 失败只是让对应的视图退回程序化替身，进度照样往前走。
    const animalsReady = ([
      ["Wolf.glb", (asset: AnimalAsset) => { this.wolfAsset = asset; }],
      ["Deer.glb", (asset: AnimalAsset) => { this.deerAsset = asset; }],
    ] as Array<[string, (asset: AnimalAsset) => void]>).map(async ([name, assign]) => {
      try {
        assign(await loadAnimal(loader, `${animalRoot}/${name}`));
        this.rebuildAnimalViews();
      } catch (error) {
        console.warn(`${name} failed to load; keeping the procedural fallback.`, error);
      }
      step();
    });

    try {
      const characters = Promise.all(
        files.map(async (name) => {
          const gltf = await loader.loadAsync(`${assetRoot}/${name}`);
          step();
          return gltf;
        }),
      );
      const [[character, movement, general, combat]] = await Promise.all([characters, ...animalsReady]);

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

  private syncItems(delta: number): void {
    for (const [id, remaining] of this.barrierFlash) {
      const next = remaining - delta;
      if (next <= 0) this.barrierFlash.delete(id);
      else this.barrierFlash.set(id, next);
    }
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
      // 除数取真实上限：石头 1500、枯木 70。原先石头写死 220，
      // 于是它掉到最后 15% 血才开始变色，前面 85% 挨打毫无反馈。
      const health = clamp(item.hp / BARRIER_STATS[item.kind].hp, 0, 1);
      const isBarrier = item.kind === "stone" || item.placed;
      view.scale.setScalar(isBarrier ? 0.55 + health * 0.45 : 1);
      // 缩放在小屏上读不出来（看着像透视），颜色才是能读的信号：
      // 越残破越暗越发红，挨打的瞬间还会亮一下。
      if (isBarrier) {
        const flash = this.barrierFlash.get(item.id) ?? 0;
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
  }

  private createItemView(item: GroundItem): THREE.Object3D {
    let view: THREE.Object3D;
    if (item.kind === "wood") {
      const group = new THREE.Group();
      const material = makeMaterial(WOOD_COLOR, 1);
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
      const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7, 0), makeMaterial(STONE_COLOR, 1));
      mesh.scale.set(2.15, 1.32, 1.7);
      mesh.castShadow = true;
      group.add(mesh);
      view = group;
    }
    view.userData.kind = item.kind;
    // 记下本色，破损染色要从它出发插值（见 syncItems）。
    view.userData.baseColor = item.kind === "wood" ? WOOD_COLOR : STONE_COLOR;
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

  /** 放置物按需建视图 —— 它们是运行时才出现的，不能像地形那样一次性建完。 */
  private syncStructures(): void {
    for (const structure of this.simulation.structures) {
      let view = this.structureViews.get(structure.id);
      if (!view) {
        view = this.createStakeView();
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
      view.animal?.mixer.update(delta);
      view.group.position.set(critter.x, terrainY, critter.z);
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
      return { group, bodyMaterial: main ?? makeMaterial(ORYX_COAT, 0.95), animal, baseColor: ORYX_COAT };
    }
    const { mesh, material } = createCritterMesh(critter.kind);
    group.add(mesh);
    return { group, bodyMaterial: material, animal: null, baseColor: 0xffffff };
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
        this.scene.add(view.bar);
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

  /**
   * 素材到位之后，把**已经用替身建好的视图**全部丢掉，下一帧自然会用真模型重建。
   *
   * 不做这一步的话，开局就存在的东西会永久停在替身上：`main.ts` 里有一次
   * 故意的着色器预热 `renderer.render(0)`，它跑在 `whenPlayerAssetReady()` **之前**，
   * 而那一刻模拟层里已经有 4 只长角羚（seedCritters）和 5 只守巢犬（seedDenGuards）——
   * 它们的视图就在那一帧被建好并缓存，之后再也不会重建。
   * 现象是"守油桶的狗是丑方块、羊还是老样子，而后面出生的狼都是对的"。
   */
  private rebuildAnimalViews(): void {
    for (const view of this.wolfViews.values()) this.disposeWolfView(view);
    this.wolfViews.clear();
    for (const view of this.critterViews.values()) this.disposeCritterView(view);
    this.critterViews.clear();
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
    /*
     * 竖屏（小屏且高大于宽）拉远到 1.18：那个比例下横向只剩一条窄缝，不拉远看不到两侧。
     * 其余一律是横屏 —— 拉近到 0.92，手机上物体原先偏小。
     *
     * 这两档是**分开调的**：竖屏的 1.18 是为了补视野，横屏的 0.92 是为了补可读性，
     * 合成一个系数的话动一个必然弄坏另一个。
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
