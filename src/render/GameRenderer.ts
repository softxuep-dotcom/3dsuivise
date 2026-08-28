import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { GameSimulation } from "../game/simulation/GameSimulation";
import { clamp, lerp, mulberry32, normalize } from "../game/simulation/geometry";
import type { CampDefinition, GroundItem, Vec2, WeaponKind, WorldDefinition } from "../game/simulation/types";
import { BARRIER_STATS, FUEL_REQUIRED } from "../game/simulation/types";
import { distanceToCampApproach, terrainHeightAt, terrainMoistureAt, terrainSaltAt, terrainSlopeAt } from "../game/terrain/TerrainModel";
import { loadAnimal, type AnimalAsset } from "./AnimalModels";
import { CreatureViews } from "./entities/CreatureViews";
import { mergeStaticMeshes } from "./visuals/mergeStatic";
import { QualityGuard } from "./QualityGuard";
import type { QualityTier } from "./QualityGuard";
import {
  BARRIER_DAMAGE_TINT, CACTUS_ELBOW_GEOMETRY, CACTUS_FLOWER_GEOMETRY, CACTUS_SPINE_GEOMETRY, IRON_ORE_GEOMETRY, IRON_SHARDS, IRON_SHARD_GEOMETRIES, STONE_COLOR, WEAPON_VISUALS, WOOD_COLOR, createBarrelView, createFuelPipTexture, createGuideArrowView, makeMaterial,
} from "./visuals/models";
import type { BladeVisual } from "./visuals/models";
import {
  DAY_HEMI_GROUND, DAY_HEMI_INTENSITY, DAY_HEMI_SKY, DAY_SKY, DAY_SUN, DAY_SUN_INTENSITY, NIGHT_HEMI_GROUND, NIGHT_HEMI_SKY, NIGHT_SKY, NIGHT_SUN, smoothTerrainBlend, 
} from "./visuals/palette";


interface CampView {
  flame: THREE.Group;
  glow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
}

/**
 * 血条自己的尺度，**不复用 wolfScale**。
 *
 * wolfScale 的含义已经从"几何倍率"改成"世界高度"（1.15 / 1.7 / 2.7），
 * 直接拿去乘血条，头犬的血条会跟着长到近三倍宽、飘到头顶两米以上。
 * 这里保留接近原来的那组倍率，只留下"越大的狗血条越宽"这一点。
 */
/** 相机距离系数。竖屏拉远补视野，横屏拉近补可读性 —— 见 updateCamera。 */
/**
 * 三档画质。档位怎么定、什么时候降，见 render/QualityGuard.ts。
 *
 *              pixelRatio          雾    扬沙   剔除半径
 *   一档默认   移动 1.0 / 桌面 1.6  有    有     45 米
 *   二档       1.0                 无    无     45 米
 *   三档       0.8                 无    无     35 米
 *
 * ## 一档为什么分设备，二三档为什么不分
 *
 * 一档是**起点**，得贴着设备本来的能力：桌面一直是 1.6，没有理由因为加了梯子
 * 就白掉一截（视网膜屏那批机器根本不是跟不上的那批）。
 *
 * ## 移动端一档 1.3 → 1.0：**起点必须是已知安全值**
 *
 * 抬到 1.3 的理由是对的（旗舰 dpr 2.5~3.5，1.0 等于按原生 1/9 渲染再拉满屏，
 * 好手机确实被压得太狠）。但**方向反了**，而且 1.1.35 的 800 局把代价量出来了：
 *
 *   r1/t15  撑过 15 秒   83% → 76%   （−7pt）
 *   r1/enter Left        4.8% → 7.7% （加载完连一步都没迈）
 *
 * 后面每一格跟着掉 6~11 点，全是这 7 个点顺着漏斗滚下去的回声。而**饿死在
 * 第 95 秒，够不到第 15 秒** —— 同一个包里的平衡改动排除掉了，回归只能来自
 * 开局那几秒。
 *
 * 机制就写在这个文件的降档逻辑里：WARMUP_MS 3000 + FIRST_WINDOW_MS 2000，
 * 而且要等 isPlaying() 为真才开始计。也就是说弱机**最快也要玩满 5 秒**
 * （还不算迈步之前的整个开场页）才降得下来，在此之前一直顶着比原来重 69%
 * 的像素 —— 正好压在最敏感的那一段。QualityGuard 自己的注释预判过这件事。
 *
 * 所以起点回到 1.0：**没有任何机器比加梯子之前更差。** 降档机制照留，
 * 它本来就是为第一夜那三十几只狼建的，不是为开局建的。
 *
 * 好手机的富余要拿回来，正确做法是把 main 那套「达标就上调」合进来，
 * 让快的机器**升**上去 —— 而不是让慢的先受罚五秒再爬回来。那套目前不在这条分支上。
 *
 * 二三档是**终点**，问的是"这台机器还剩多少"，那跟它是手机还是电脑没关系了。
 * 一台跟不上的弱笔记本和一台跟不上的手机，需要的是同一个数。
 *
 * 全部还要过 min(devicePixelRatio, …)：dpr 1.0 的普通显示器本来就到不了 1.3。
 */
const TIER_PIXEL_RATIO: Record<QualityTier, number> = { 1: 1.6, 2: 1.0, 3: 0.8 };
/** 移动档的一档单独一个数，理由见上。 */
const TIER1_MOBILE_PIXEL_RATIO = 1.0;

/*
 * 狼和猎物在多远之外停止绘制。
 *
 * 45 米是改造前就有的移动档数字，依据是雾：FogExp2 密度 0.0075 在这个距离已经
 * 把东西压得接近背景色，剔掉肉眼看不出来 —— 那是一次纯赚的省。
 *
 * 35 米是三档的数字，而三档的雾已经关了，所以这一刀是**看得出来的**：
 * 远处的狗会真的消失。它只在机器已经跟不上时才生效，那时候这个交换划算。
 */
const DEFAULT_CULL_DISTANCE = 45;
const TIER3_CULL_DISTANCE = 35;

const PORTRAIT_CAMERA_SCALE = 1.08;
const LANDSCAPE_CAMERA_SCALE = 0.64;

/** 动物素材下载的重试退避（毫秒）。长度 = 重试次数，所以一共尝试 3 次。 */
const ANIMAL_ASSET_RETRY_BACKOFF: readonly number[] = [700, 1800];
export class GameRenderer {
  readonly canvas: HTMLCanvasElement;

  /** 软重启会换掉这两个引用，见 resetRun()。 */
  private simulation: GameSimulation;
  private world: WorldDefinition;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(47, 1, 0.1, 320);

  /** 触屏 / 窄屏走低功耗档：无 AA、pixelRatio 1、无实时阴影、远处实体剔除。 */
  private readonly lowPower: boolean;
  /**
   * 当前画质档。**单向**，只会从 1 往 3 走。
   *
   * 渲染循环读它跳过扬沙，CreatureViews 通过 cullDistance 读它。
   * 什么时候降、降几档全在 QualityGuard 里，这里只落地。
   */
  private tier: QualityTier = 1;
  private readonly quality = new QualityGuard({
    // 暂停、开场页、结算页都不算在玩：那时候场上没有狼没有猎物，量出来是假数。
    isPlaying: () => this.simulation.running,
    onTier: (tier) => this.applyTier(tier),
  });
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
  private truckRing: THREE.Mesh | null = null;
  /** 车斗上那一排已装的油桶，按 loaded 逐个点亮。 */
  private readonly truckLoadViews: THREE.Object3D[] = [];
  /** 车顶常显的六格装油进度：空格暗着，装一桶亮一格。 */
  private readonly truckFuelPips: THREE.Sprite[] = [];
  /** 新装油桶的落位反馈；只属于渲染层，不参与装车判定。 */
  private fuelLoadFeedbackTime = 0;
  private fuelLoadFeedbackIndex = -1;
  private readonly barrelViews = new Map<number, THREE.Object3D>();
  /** 开局第一桶油 → 车头的浮动指路箭头；第一桶装车后退场。 */
  private readonly guideArrow = createGuideArrowView();
  private readonly guideAnchor = new THREE.Vector3();
  private guidePhase = 0;
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
  private treeTrunks: THREE.InstancedMesh | null = null;
  private treeBranches: THREE.InstancedMesh | null = null;
  /** 已经变成树桩的树。只记 id，用来避免每帧重写矩阵。 */
  private readonly felledTrees = new Set<number>();
  /** 路障挨打后的闪光余量（秒），按物品 id 记。 */
  private readonly barrierFlash = new Map<number, number>();
  private readonly cactusViews = new Map<number, THREE.Object3D>();
  private readonly ironViews = new Map<number, THREE.Object3D>();
  private readonly wellViews = new Map<number, THREE.Object3D>();
  private readonly wellPips = new Map<number, THREE.Object3D[]>();
  private readonly structureViews = new Map<number, THREE.Object3D>();
  /** 井顶水珠的浮动相位。 */
  private wellBob = 0;
  /**
   * 会动的三类（狼、猎物、掉落物）的视图池。
   *
   * 端口用**适配器对象**而不是直接把 this 传进去，这样渲染器的字段一个都不用公开。
   * 里面用 getter 是必需的：simulation 会被 resetRun 换掉，time 每帧在变。
   */
  private readonly creatures = this.createCreatureViews();

  private createCreatureViews(): CreatureViews {
    const renderer = this;
    return new CreatureViews({
      get scene() { return renderer.scene; },
      get simulation() { return renderer.simulation; },
      get time() { return renderer.time; },
      get lowPower() { return renderer.lowPower; },
      get cullDistance() { return renderer.cullDistance(); },
      get wolfAsset() { return renderer.wolfAsset; },
      get deerAsset() { return renderer.deerAsset; },
      get dropHideMaterial() { return renderer.dropHideMaterial; },
      get dropMeatMaterial() { return renderer.dropMeatMaterial; },
      get dropBoneMaterial() { return renderer.dropBoneMaterial; },
      worldHeight: (x, z) => renderer.worldHeight(x, z),
    });
  }
  /* 材质跟随渲染器实例共享；软重开不会为每份掉落物再造一套。 */
  private readonly dropHideMaterial = makeMaterial(0x7a4931, 1);
  private readonly dropMeatMaterial = makeMaterial(0x9e3f3d, 0.9);
  private readonly dropBoneMaterial = makeMaterial(0xd7c8ad, 1);
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
    this.renderer.setPixelRatio(this.pixelRatioFor(1));
    this.renderer.shadowMap.enabled = true;
    /*
     * 低功耗档也保留 PCF，不降级成 BasicShadowMap。
     *
     * 阴影图在这一档同时缩到 512²（见下），块状边缘正需要 PCF 那几次采样糊开；
     * 换成 Basic 省下的是主 pass 每个受光片元的几次纹理采样，但换来的硬边
     * 配上 512² 会直接暴露成阶梯。省错地方了。
     */
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    this.sun.shadow.mapSize.set(this.lowPower ? 512 : 1024, this.lowPower ? 512 : 1024);
    this.sun.shadow.camera.left = -32;
    this.sun.shadow.camera.right = 32;
    this.sun.shadow.camera.top = 32;
    this.sun.shadow.camera.bottom = -32;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = this.lowPower ? 110 : 130;
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
    this.scene.add(this.guideArrow);
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
    /*
     * `?quality=2` / `?quality=3` 直接跳到那一档，不等判定。
     *
     * 这一档的判据只能在**真机**上验证，而手上没有弱机 —— 这也正是 main 那套
     * 「一次性上调」当初拒绝做降级梯子的理由。开关补上了另一半：
     * 判据仍然验不了，但**每一档长什么样**在任何机器上都看得见，
     * 而"降完之后画面还能不能看"恰恰是唯一需要人眼判断的部分。
     *
     * 只在 DEV 下认，生产包里这段会被摇掉。
     */
    if (import.meta.env.DEV) {
      const forced = Number(new URLSearchParams(window.location.search).get("quality"));
      if (forced === 2 || forced === 3) this.quality.jumpTo(forced);
    }
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
    const frameStart = performance.now();
    const delta = Math.min(deltaSeconds, 0.05);
    this.time += delta;
    this.syncPlayer(delta);
    this.syncItems(delta);
    this.syncBarrels(delta);
    this.syncGuideArrow(delta);
    this.syncCacti();
    this.syncIronNodes();
    this.syncTrees();
    this.syncWells(delta);
    this.syncStructures();
    
    this.creatures.sync(delta);
    
    this.syncFires();
    // 排在 syncDayNight 之前：那一步要按这一步算出的 tutorialLight 去压环境光。
    this.updateTutorialLight(delta);
    this.syncDayNight();
    this.updateCamera(delta);
    // 二档起扬沙整个停掉：既不画也不再每帧改 240 个顶点。
    if (this.tier < 2) this.updateSand(delta);
    this.updateWarmthAura(delta);
    this.renderer.render(this.scene, this.camera);
    // 排在最后：要量的是这一帧渲染的全部耗时。降过档之后这一句直接 return。
    this.quality.sample(frameStart);
  }

  /** 这一档该用多大的 pixelRatio。一档分设备，二三档不分，见 TIER_PIXEL_RATIO。 */
  private pixelRatioFor(tier: QualityTier): number {
    const wanted = tier === 1 && this.lowPower ? TIER1_MOBILE_PIXEL_RATIO : TIER_PIXEL_RATIO[tier];
    return Math.min(window.devicePixelRatio, wanted);
  }

  /**
   * 狼和猎物在多远之外停止绘制。null = 不剔除。
   *
   * **两个条件各自都能触发剔除**：移动档一直剔（45 米，改造前就有），
   * 而三档不管什么设备都剔（35 米）。早先这一块只挂在 lowPower 上，
   * 于是降档在桌面端是空转的 —— 而一台弱笔记本走到三档时 lowPower 正好是 false，
   * 四项里最省的那一项直接不生效。浏览器实测撞到过。
   */
  cullDistance(): number | null {
    if (this.tier >= 3) return TIER3_CULL_DISTANCE;
    return this.lowPower ? DEFAULT_CULL_DISTANCE : null;
  }

  /**
   * 落地某一档。QualityGuard 只在**真的换档**时调，所以这里不必判重。
   *
   * 一档是构造时的起点，不会被调到；二三档各自加一样东西：
   *
   *   二档  关雾、停扬沙、pixelRatio 1.0
   *   三档  再把剔除半径从 45 收到 35、pixelRatio 0.8
   *
   * 雾和扬沙**不恢复** —— 档位是单向的，关了就一直关着，省掉一整套还原逻辑。
   */
  private applyTier(tier: QualityTier): void {
    this.tier = tier;
    if (tier >= 2) {
      this.scene.fog = null;
      this.sand.visible = false;
    }
    this.renderer.setPixelRatio(this.pixelRatioFor(tier));
    // setPixelRatio 之后要按新比例重新分配绘制缓冲，否则画布还是旧尺寸。
    this.resize();
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
    return this.screenToGround(clientX, clientY)?.point ?? null;
  }

  /**
   * 屏幕上这一点打到地面是哪里，以及**这条射线在地面上朝哪个方向走**。
   *
   * 方向那一半是给左击选中用的，而且是必需的 —— 玩家点的是一棵树**画出来的那几个
   * 像素**（离地一两米），射线穿过去打在树**后面**的地上。实测这个偏移是
   * 0.8~13.4 米，而且**垂直于视线的分量恰好是 0**：偏移百分之百沿着视线方向。
   *
   * 所以"点没点中"不能用"离命中点多远"来量（那会让点树经常无声地落空），
   * 要量的是**离这条射线的地面直线有多远**。把 forward 一并交出去，
   * 选中判定就能做这件事，而且完全不需要知道相机在哪。
   *
   * 命中点仍然照旧返回：点空地时走过去的目标就是它。
   */
  screenToGround(clientX: number, clientY: number): { point: Vec2; forward: Vec2 } | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh, false)[0];
    if (!hit) return null;
    this.worldPoint.copy(hit.point);
    const point = { x: this.worldPoint.x, z: this.worldPoint.z };
    // 射线的地面方向：相机 → 命中点，投到 xz 平面。透视相机每个像素方向不同，
    // 所以逐次现算，不用一个全屏共用的常量。
    const forward = normalize({
      x: point.x - this.camera.position.x,
      z: point.z - this.camera.position.z,
    });
    return { point, forward };
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
   * 而绝大多数视图**每帧都从 simulation 重新摆**（syncBarrels 连卡车带油桶一起摆，
   * syncItems 发现 kind 对不上会自己重建，狼/猎物/掉落各有清理循环），所以换掉引用
   * 它们下一帧就归位。真正需要手动收拾的只有下面这几样 —— 它们的共同点是
   * **只在事件发生的那一刻写一次，之后不再同步**。
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
    /*
     * 荒漠调色：明亮的沙丘 → 湿润洼地的暗砾石 → 踩实的土路 → 裸岩 → 盐碱壳
     *
     * 五个色**整体降饱和到原来的 58%**（色相和明度都不动）。
     *
     * 为什么动地面而不是去挨个提亮那 184 件可交互物：这张图上能交互的东西是
     * 不能交互的 11 倍（散物 97 + 树 26 + 仙人掌 32 + 铁矿 14 + 桶 10 + 井 5，
     * 对面只有 16 个地标）。真正的问题从来不是"装饰物太多"，是**所有东西都是
     * 同一族沙漠褐** —— 枯木的色相离沙地只有 16°，玩家没有任何规则可以用来
     * 分辨"这一类是给我的"。改一个地面材质，等于同时给全部交互物让路。
     *
     * 注意降饱和**不会**提高亮度对比（沙地反而变亮了一点，枯木对沙地是
     * 3.88:1 → 3.52:1）。它买到的是**饱和度通道**：地面压到 27%，
     * 可交互物推到 60% 以上，于是"鲜艳 = 能捡"成为一条一眼可学的规则。
     * 所以这一条必须和 WOOD_COLOR / STONE_COLOR 那两个一起改，单独上没有意义。
     */
    const sand = new THREE.Color(0xb5a27e);
    const gravel = new THREE.Color(0x8c7c62);
    const packedEarth = new THREE.Color(0x786247);
    const rock = new THREE.Color(0x817261);
    const salt = new THREE.Color(0xdddace);
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
      // 狗巢全静态，没有任何 sync 碰它的子网格。
      mergeStaticMeshes(group);
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
      // 枯木 / 残骸 / 石碑全静态，同狗巢。
      mergeStaticMeshes(group);
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
      slot.position.set(-2.45 + (index % 3) * 1.15, 1.5, index < 3 ? -0.6 : 0.62);
      slot.scale.setScalar(0.82);
      slot.visible = false;
      group.add(slot);
      this.truckLoadViews.push(slot);
    }

    // 和井顶水珠同一套场景语汇，但换成桶形图标；六个空格始终可见，直接表达“还差几桶”。
    const pipTexture = createFuelPipTexture();
    for (let index = 0; index < FUEL_REQUIRED; index += 1) {
      const pip = new THREE.Sprite(new THREE.SpriteMaterial({
        map: pipTexture,
        color: 0x34524f,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
      }));
      pip.position.set(-0.75 + (index - (FUEL_REQUIRED - 1) / 2) * 0.58, 4.05, 0);
      pip.scale.set(0.54, 0.54, 1);
      group.add(pip);
      this.truckFuelPips.push(pip);
    }

    this.buildTruckBeacon(group);
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

  private buildBarrels(): void {
    for (const barrel of this.simulation.barrels) {
      const view = createBarrelView();
      view.rotation.y = barrel.rotation;
      this.scene.add(view);
      // 桶身投影、两道箍与盖子不投影，合并后剩两个网格。
      mergeStaticMeshes(view);
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
    const departing = this.simulation.isDeparting();
    this.truckFuelPips.forEach((pip, index) => {
      const lit = index < truck.loaded;
      const flash = feedbackActive && index === this.fuelLoadFeedbackIndex
        ? Math.sin(feedbackProgress * Math.PI)
        : 0;
      pip.visible = !departing;
      pip.position.y = 4.05 + Math.sin(this.time * 1.8 + index * 0.5) * 0.045;
      pip.scale.setScalar(0.54 * (1 + flash * 0.24));
      pip.material.color.setHex(lit ? 0xff8a36 : 0x34524f);
      pip.material.opacity = lit ? 1 : 0.48;
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
      this.truckRing.visible = !departing;
    }
    this.fuelLoadFeedbackTime = Math.max(0, this.fuelLoadFeedbackTime - delta);
    // 驶离时玩家在车里。模拟层把人的坐标锁在车心，所以直接把人藏掉 ——
    // 否则最后 5 秒会看到一个人站在车斗中央被拖出地图。
    this.playerGroup.visible = !departing;
  }

  /**
   * 第一趟装车的浮动指示：未拿时指最后压入的出生桶，扛起后指车头，
   * 第一桶装车后退场。每帧从模拟状态现算，放下桶和软重启都无需额外状态机。
   */
  private syncGuideArrow(delta: number): void {
    const fuel = this.simulation.getFuelProgress();
    if (fuel.loaded >= 1) {
      this.guideArrow.visible = false;
      return;
    }

    if (fuel.carrying) {
      // buildTruck 的驾驶室顶面约在 local y=2.7，再留 0.35 米净空。
      this.guideAnchor.set(1.9, 3.05, 0);
      this.truckGroup.localToWorld(this.guideAnchor);
    } else {
      // createWorld 最后压入的桶就是出生点教学桶；软重启后下标仍成立。
      const first = this.simulation.barrels[this.simulation.barrels.length - 1];
      if (!first || first.placement !== "ground") {
        this.guideArrow.visible = false;
        return;
      }
      this.guideAnchor.set(first.x, this.worldHeight(first.x, first.z) + 1.55, first.z);
    }

    this.guidePhase += delta;
    this.guideArrow.visible = true;
    this.guideArrow.position.set(
      this.guideAnchor.x,
      this.guideAnchor.y + Math.sin(this.guidePhase * 2.6) * 0.19,
      this.guideAnchor.z,
    );
    this.guideArrow.rotation.y = this.guidePhase * 1.15;
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

      this.scene.add(group);
      // 每个矿点 8 个网格：石基与七块碎石同材质同投影，矿脉另一份材质。
      mergeStaticMeshes(group);
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
      /*
       * 井口那三个水位点必须留在外面：syncWells 按存量逐个显隐、逐个上下浮动。
       * 合并掉它们的话，井水多少就再也看不出来了。
       */
      mergeStaticMeshes(group, new Set(pips));
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
      /*
       * 火焰和地光必须留在外面：syncFires 按燃料逐帧改它们的缩放与透明度。
       * flame 是个组，它的两个子网格会被 keep 的祖先判定一并保住。
       */
      mergeStaticMeshes(group, new Set<THREE.Object3D>([flame, glow]));
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
        const elbow = new THREE.Mesh(CACTUS_ELBOW_GEOMETRY, fleshMaterial);
        elbow.rotation.z = Math.PI / 2;
        elbow.position.set(dir * 0.24, 0.75 + side * 0.42, 0);
        group.add(elbow);
      }
      const flower = new THREE.Mesh(CACTUS_FLOWER_GEOMETRY, flowerMaterial);
      flower.position.y = trunkHeight + 0.42;
      group.add(flower);
      for (let index = 0; index < 3; index += 1) {
        const spine = new THREE.Mesh(CACTUS_SPINE_GEOMETRY, spineMaterial);
        const angle = (index / 3) * Math.PI * 2;
        spine.position.set(Math.cos(angle) * 0.31, 0.6 + index * 0.42, Math.sin(angle) * 0.31);
        spine.rotation.z = -Math.cos(angle) * 1.2;
        spine.rotation.x = Math.sin(angle) * 1.2;
        group.add(spine);
      }
      group.rotation.y = random() * Math.PI * 2;
      group.position.set(patch.x, this.worldHeight(patch.x, patch.z), patch.z);
      // 每株 9 个网格 → 按材质与阴影分桶合并。syncCacti 只切 group.visible，不碰子网格。
      mergeStaticMeshes(group);
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

  /**
   * 地面枯木：两根横躺的圆木。
   *
   * 1.1.32 试过把能捡的那种改成 Λ 形立柴，想用剪影和装饰用的 deadwood 地标区分开
   * （实测第一个白天捡到柴的只有 9.6%）。**回退了，理由是难看** —— 立着的柴在
   * 沙地上像插进去的路标，不像躺在那儿等人捡的柴火。
   *
   * 区分这件事改由**颜色**承担（见 makeMaterial 那一族的色相分配）：可交互物统一
   * 推离沙漠褐，地形反过来降饱和。剪影这条路留在这里当记录 —— 它能解决问题，
   * 只是代价是美术观感，而这个游戏的沙漠质感本身也是留人的一部分。
   */
  private createItemView(item: GroundItem): THREE.Object3D {
    let view: THREE.Object3D;
    if (item.kind === "wood") {
      const group = new THREE.Group();
      const material = makeMaterial(WOOD_COLOR, 1);
      for (let index = 0; index < 2; index += 1) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 1.65, 7), material);
        log.rotation.z = Math.PI / 2;
        log.position.z = (index - 0.5) * 0.38;
        log.castShadow = !this.lowPower;
        group.add(log);
      }
      view = group;
    } else {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7, 0), makeMaterial(STONE_COLOR, 1));
      mesh.scale.set(2.15, 1.32, 1.7);
      // 低功耗档：地上的枯木与石头不投影。它们贴地、影子只有一小片，
      // 但场上有 97 件 —— 阴影相机 ±32 米内常驻十几二十个，每个都是深度 pass
      // 里的一次 draw call。这是"看不见的开销"里最容易砍的一笔。
      mesh.castShadow = !this.lowPower;
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
    const sky = new THREE.Color().lerpColors(NIGHT_SKY, DAY_SKY, daylight);
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
     * 两档都往近走过一轮（横屏 0.80 → 0.70 → 0.64，竖屏 1.18 → 1.08）。
     * 按 47° FOV 算：
     *
     *   横屏 844×390   距离 28.8 → 23.1   横向可见 54.2m → 43.4m   角色占屏高 10.4% → 13.0%
     *   竖屏 390×844   距离 42.5 → 38.9   横向可见 17.1m → 15.6m   角色占屏高  7.0% →  7.7%
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
    this.sun.position.set(this.cameraFocus.x - 35, this.cameraFocus.y + 55, this.cameraFocus.z + 25);
    this.sun.target.position.set(this.cameraFocus.x, this.cameraFocus.y, this.cameraFocus.z);
    this.sun.target.updateMatrixWorld();
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
