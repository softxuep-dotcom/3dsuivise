import {
  clamp,
  direction,
  distance,
  distanceSquared,
  dot,
  mulberry32,
  normalize,
  TAU,
} from "./geometry";
import { campGatePosition, campLocalToWorld, isTerrainWalkable } from "../terrain/TerrainModel";
import { NavigationGrid } from "./NavigationGrid";
import { ProjectileCarriedCombatSystem } from "./ProjectileCarriedCombatSystem";
import type { ProjectileCarriedCombatWorld } from "./ProjectileCarriedCombatSystem";
import { CritterDirector } from "./CritterDirector";
import type { CritterWorld } from "./CritterDirector";
import { WolfDirector } from "./WolfDirector";
import type { WolfWorld } from "./WolfDirector";
import type {
  CactusPatch,
  CritterKind,
  CritterState,
  CampDefinition,
  CampState,
  DeathCause,
  EquipLine,
  FuelBarrelState,
  GameEvent,
  LocalizedText,
  GroundItem,
  InteractionHint,
  ArmorKind,
  WeaponKind,
  IronNode,
  WellState,
  PlacedStructure,
  StructureKind,
  TreeState,
  InventoryItemKind,
  InventoryStack,
  Phase,
  PlayerState,
  SurvivalCondition,
  Vec2,
  WolfKind,
  WolfState,
  WorldDefinition,
  WorldDrop,
} from "./types";
import { PLAYER_RADIUS, STONE_COLLIDE_RADIUS, WOLF_RADIUS, BARRIER_STATS, CRITTER_SPECS, FUEL_REQUIRED, INVENTORY_CAPACITY, INVENTORY_STACK_LIMITS, STRUCTURE_SPECS } from "./types";
import type { Difficulty, DifficultyTuning } from "./difficulty";
import { DEFAULT_DIFFICULTY, tuningFor } from "./difficulty";
import {
  canStepToward,
  canTraverseTerrain,
  findSteppableDirection,
  getFlowFieldObstacles,
  getSteeredDirection,
  hasMeleeLine,
  isBlockingGroundItem,
  lineOfSightBlocked,
  moveEntity,
  stepCrossesCollision,
} from "./collision";
import {
  COOKED_HEALTH,
  COOKED_HUNGER,
  COOKED_WATER,
  COOL_ACTION_COOLDOWN,
  COOL_ACTION_WARMTH,
  DROP_LIFETIME,
  EXHAUSTED_DAMAGE_SCALE,
  FIRE_WARMTH_RADIUS,
  FIRST_DAY_DURATION,
  FIRST_NIGHT_DURATION,
  FUEL_PICKUP_REACH,
  ITEM_PICKUP_REACH,
  HEALTH_DECAY,
  HEALTH_PASSIVE_NEED,
  HEALTH_PASSIVE_REGEN,
  HUNGER_DECAY,
  JUICE_HUNGER,
  JUICE_WARMTH,
  JUICE_WATER,
  LATER_DAY_DURATION,
  LATER_NIGHT_DURATION,
  RAW_HEALTH,
  RAW_HUNGER,
  RAW_WATER,
  REST_IDLE_SECONDS,
  REVIVE_CLEAR_RADIUS,
  REVIVE_GRACE_SECONDS,
  SECOND_NIGHT_DURATION,
  STAMINA_ACTIVE_REGEN,
  STAMINA_COST_CACTUS,
  STAMINA_COST_CHOP,
  STAMINA_COST_DRAW,
  STAMINA_COST_MINE,
  STAMINA_COST_WOOD,
  STAMINA_IDLE_REGEN,
  STAMINA_MAX,
  STAMINA_REST_REGEN,
  STARTING_RATION,
  STRAIGHT_WALK_MAX,
  THERMAL_COMFORT_HIGH,
  THERMAL_COMFORT_LOW,
  TREE_REACH,
  TREE_WOOD,
  TRUCK_BOARD_REACH,
  TRUCK_DEPART_MAX_SECONDS,
  TRUCK_DEPART_SPEED,
  TRUCK_HORN_COOLDOWN,
  TRUCK_HORN_RADIUS,
  TRUCK_HORN_REACH,
  TRUCK_LOAD_REACH,
  TUTORIAL_WOOD_RADIUS,
  TUTORIAL_WOOD_SPREAD,
  WARMTH_COLD_ENTER,
  WARMTH_COLD_EXIT,
  WARMTH_DAY_BASE,
  WARMTH_DAY_FLOOR,
  WARMTH_FIRE_GAIN,
  WARMTH_HEAT_ENTER,
  WARMTH_HEAT_EXIT,
  WARMTH_INITIAL,
  WARMTH_MAX,
  WARMTH_MIN,
  WARMTH_NIGHT_CEILING,
  WARMTH_NIGHT_LOSS,
  WARM_ACTION_COOLDOWN,
  WARM_ACTION_WARMTH,
  WATER_DECAY,
  WATER_RESTORE,
  WATER_URGENT,
  WATER_WARMTH_COST,
  WELL_CHARGES_INITIAL,
  WELL_CHARGES_MAX,
  WELL_REACH,
  WELL_REFILL_SECONDS,
  WOOD_ATTACK_BONUS,
  WOOD_ATTACK_CAP,
} from "./balance";
import type { EquipTier, WeaponStat } from "./equipment";
import { ARMOR_STATS, ARMOR_TIERS, ATTACK_COOLDOWN, COMBO_WINDOW, WEAPON_STATS, WEAPON_TIERS } from "./equipment";

/**
 * 造一条待渲染文案。模拟层所有面向玩家的字符串都经这里出去 ——
 * 它不认识任何一门语言，只负责说清"这是哪一条、带什么参数"。
 */
const loc = (key: string, params?: LocalizedText["params"]): LocalizedText => (
  params ? { key, params } : { key }
);

/**
 * 从 `from` 看向 `to` 的**屏幕方位角**：0 = 屏幕正上方，顺时针为正。
 *
 * 不能直接用世界坐标的 atan2 —— 相机固定架在 (+19, +24, +19) 俯视原点，
 * 也就是整张图在屏幕上转了 45°：屏幕上方对应世界的 (−x, −z)，屏幕右方对应 (+x, −z)。
 * 玩家没有小地图、也没有别的方位参照，所以"北"只能定义成"屏幕朝上"，
 * 否则报出来的方位和他看到的画面差 45°，比不报还糟。
 */
function screenBearing(from: Vec2, to: Vec2): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const right = dx - dz;
  const up = -(dx + dz);
  return Math.atan2(right, up);
}

/** 卡车随装油进度逐级苏醒；规则状态与 Three.js 表现分开。 */
export interface TruckPowerState {
  loaded: number;
  electrics: boolean;
  headlights: boolean;
  horn: boolean;
  engine: boolean;
  ready: boolean;
  hornCooldown: number;
}

export class GameSimulation {
  readonly world: WorldDefinition;
  readonly camps: CampState[];
  readonly items: GroundItem[];
  readonly cacti: CactusPatch[];
  readonly ironNodes: IronNode[];
  /**
   * 可砍的树。
   *
   * 加这条是因为地图上柴火**不再生、而且分布极不均**：全图 56 根枯木看着够烧
   * 二十多夜，但除出生营地外每座营地方圆 30 米只有 2~3 根 —— 玩家一换营地就没燃料，
   * 而火是活过夜晚的唯一条件。18 棵树原先只有碰撞、零交互，长得却正是柴火本身。
   */
  readonly trees: TreeState[];
  readonly wells: WellState[];
  readonly structures: PlacedStructure[] = [];
  readonly player: PlayerState;
  private readonly wolfDirector!: WolfDirector;
  private readonly projectileCombat!: ProjectileCarriedCombatSystem;
  /** 狼群本体现在归 WolfDirector 管；这里保留同名入口，渲染层和 HUD 不用改。 */
  get wolves(): WolfState[] { return this.wolfDirector.wolves; }
  private readonly critterDirector: CritterDirector;
  /** 猎物种群现在归 CritterDirector 管；这里保留同名入口，渲染层和测试不用改。 */
  get critters(): CritterState[] { return this.critterDirector.critters; }
  readonly drops: WorldDrop[] = [];
  readonly barrels: FuelBarrelState[];
  /** 卡车。位置在驶离时会变，所以它是状态不是定义的引用。 */
  readonly truck: { x: number; z: number; rotation: number; loaded: number };

  phase: Phase = "day";
  day = 1;
  phaseTime = FIRST_DAY_DURATION;
  elapsed = 0;
  running = false;
  clockStarted = false;

  private readonly random = mulberry32(847331);
  private readonly events: GameEvent[] = [];
  private readonly navigation: NavigationGrid;
  private readonly retreatNavigations: NavigationGrid[];
  /**
   * 点击移动的寻路网格。
   *
   * 和 `navigation`（每 0.65 秒重建、目标恒为玩家，给狗用）是两回事：这张的目标是
   * **玩家点的那个点**，所以只在目标变化时重建 —— 一次 BFS 约 17 万次邻居访问，
   * 每帧跑不起，但一次点击跑一次完全无所谓。
   */
  /**
   * 懒构造：只有真的点了地面才建。
   *
   * NavigationGrid 的构造要跑 buildStaticObstacles —— 21609 个格子逐个验地形和墙，
   * 不是白送的。触屏玩家全程用摇杆，一次都不会点地图；测试里每个用例都新建一个
   * GameSimulation，急着建这张网格会让构造成本直接翻倍（实测把整套测试从 40 秒
   * 推到 60 秒以上、撞穿 vitest 的 5 秒单例上限）。
   */
  private clickRoute: NavigationGrid | null = null;
  private clickTarget: Vec2 | null = null;
  /**
   * 动物模型改为进场后下载。资源没准备好时模拟层也不能先生成实体，
   * 否则玩家会被尚未显示出来的狼攻击，或看见猎物稍后突然换模型。
   */
  private crittersEnabled = false;
  private wolvesEnabled = false;
  private dropId = 0;
  private navigationCountdown = 0;
  /** 剑线连击：当前层数、锁定的目标、以及还剩多久清零。 */
  private comboStacks = 0;
  private comboTargetKey: string | null = null;
  private comboTimer = 0;
  /** 挨打后的休息封锁倒计时，见 REST_COMBAT_LOCK。 */
  private combatTimer = 0;
  private structureId = 0;
  /** 正被玩家双手搬运的树桩；保留原对象才能避免搬运受损树桩时把生命值刷满。 */
  private carriedStructure: PlacedStructure | null = null;
  /** 生肉不回体力这条只在第一次生吞时说一遍，之后靠目标行常驻。 */
  private rawMeatHintSent = false;
  /** 体温调节动作的冷却（公开给 HUD 显示）。 */
  coolCooldown = 0;
  warmCooldown = 0;
  private objectiveStage = 0;
  /** 见 isEquipmentUnlocked。只置位、不复位。 */
  private equipmentUnlocked = false;
  private gameOverSent = false;
  private duskWarningSent = false;
  /** 胜利结算只跑一次。 */
  private victorySent = false;
  /** 渲染层保留原入口；飞行状态真正归 ProjectileCarriedCombatSystem 所有。 */
  get thrownStones() { return this.projectileCombat.thrownStones; }
  /** getLitFires 的复用数组，见那里的注释。 */
  private readonly litFireScratch: Vec2[] = [];
  /** >0 表示卡车正在驶离，玩家已经在车上，只剩结算动画。 */
  private departTimer = 0;
  private truckHornCooldown = 0;
  // 死因记录，供 UI 显示游戏结束文案
  deathCause: DeathCause | null = null;
  /** 真正补上致命一击的狼种；只有 deathCause === "killed" 时有值。 */
  deathKiller: WolfKind | null = null;
  /** 本帧最后一次体力伤害的来源。代谢先跑、狼攻击后跑，所以最后写入者就是致命来源。 */
  private healthDamageCause: "killed" | "exhausted" = "exhausted";
  private healthDamageAttacker: WolfKind | null = null;
  won = false;

  /** 本局的难度倍率。构造时定死，中途不重读 —— 见 difficulty.ts。 */
  private readonly tuning: DifficultyTuning;

  /**
   * 出生点与初始朝向，构造时定死。
   *
   * 教学甲虫要撒在**这里**，不能用 `this.player` 当锚点：seedCritters() 是等
   * Deer.glb 下载完才跑的，那一刻玩家早就走开了，按当前位置撒等于撒在半路上。
   */
  private readonly spawnAnchor: Vec2;
  private readonly spawnFacing: number;

  /**
   * 教学期间挂起世界时钟。
   *
   * 光靠 `clockStarted` 不够：`noteActivity()` 在**任何一次移动**时就把它置 true，
   * 而教学第一步教的正是移动 —— 玩家一推摇杆，40 秒白天就开始倒数，
   * 后面三步全在啃第一天的预算。这道闸挡在 noteActivity 前面，
   * 教学结束时由 setTutorialHold(false) 放开。
   */
  private tutorialHold = false;

  constructor(world: WorldDefinition, difficulty: Difficulty = DEFAULT_DIFFICULTY) {
    this.tuning = tuningFor(difficulty);
    this.world = world;
    this.navigation = new NavigationGrid(world);
    const retreatEdge = world.size / 2 - 0.7;
    this.retreatNavigations = [
      { x: -retreatEdge, z: 0 },
      { x: retreatEdge, z: 0 },
      { x: 0, z: -retreatEdge },
      { x: 0, z: retreatEdge },
    ].map((target) => {
      const navigation = new NavigationGrid(world);
      navigation.rebuild(target, world.initialItems
        .filter((item) => item.kind === "stone" && !item.placed)
        .map((item) => ({ x: item.x, z: item.z, radius: STONE_COLLIDE_RADIUS + WOLF_RADIUS })));
      return navigation;
    });
    const startCamp = world.camps[world.startCampId];
    this.camps = world.camps.map((camp) => ({ id: camp.id, fuel: 0 }));
    this.items = world.initialItems.map((item) => ({ ...item }));
    this.cacti = world.initialCacti.map((patch) => ({ ...patch }));
    this.ironNodes = world.ironNodes.map((node) => ({ ...node }));
    this.trees = world.trees.map((tree) => ({ id: tree.id, x: tree.x, z: tree.z, wood: TREE_WOOD }));
    this.wells = world.wells.map((well) => ({ id: well.id, charges: WELL_CHARGES_INITIAL, refillAt: 0 }));
    this.barrels = world.barrels.map((barrel) => ({
      id: barrel.id,
      x: barrel.x,
      z: barrel.z,
      rotation: barrel.rotation,
      placement: "ground" as const,
    }));
    this.truck = { x: world.truck.x, z: world.truck.z, rotation: world.truck.rotation, loaded: 0 };
    /*
     * 开局站在**坡底**（坡道末端），面朝卡车。
     *
     * 之前站在营地台面中心偏大门一侧 —— 那是 11.8 米高台地的正中央，四周坡度
     * 0.8~2.0（可走上限 0.78）。实测从那儿朝 16 个方向各走 3 秒，**只有 4 个
     * 方向走得到一半**，其余全在崖壁上磨。新玩家开局第一件事就是随便按个方向走，
     * 于是十有六七直接撞墙 —— 这大概率就是十几秒就退的那批人看到的东西。
     *
     * 同样的测法，坡底是 14/16、平均完成度 83%、脚下坡度 0.00。
     * 而且卡车的选址本来就是以坡底为锚点往外推的（见 createWorld.placeTruck），
     * 所以在坡底出生等于一睁眼车就在旁边，通关目标和出生点重合。
     * 营地在身后上方，天黑前爬上去点火 —— 那条循环反而更清楚了。
     */
    const rampWorld = startCamp.approach.map((local) => campLocalToWorld(startCamp, local));
    const startSpot = rampWorld[rampWorld.length - 1] ?? campGatePosition(startCamp);
    const startFacing = normalize({ x: world.truck.x - startSpot.x, z: world.truck.z - startSpot.z });
    this.spawnAnchor = { x: startSpot.x, z: startSpot.z };
    this.spawnFacing = Math.atan2(startFacing.z, startFacing.x);
    this.addTutorialWood();
    this.player = {
      x: startSpot.x,
      z: startSpot.z,
      facing: startFacing,
      health: 100,
      maxHealth: 100,
      warmth: WARMTH_INITIAL,
      // 各按原值的九成起步（饱食 82 → 74、水分 90 → 81）。
      // 见 WATER_DECAY / HUNGER_DECAY：0.42/s 下满值要 238 秒才见底，
      // 而第一个昼夜只有 140 秒 —— 满着开局的话这两条轴在第一个循环里
      // 根本不构成决策，五条轴里有两条是纯装饰。缩九成让它们在第二个循环开头就开始咬人。
      hunger: 74,
      water: 81,
      stamina: STAMINA_MAX,
      maxStamina: STAMINA_MAX,
      condition: "normal",
      inventory: Array.from({ length: INVENTORY_CAPACITY }, () => null),
      carrying: null,
      armor: "none",
      weapon: "survival-knife",
      resting: false,
      idleTime: 0,
      attackCooldown: 0,
      attackFlash: 0,
      hurtFlash: 0,
      kills: 0,
    };
    for (const [kind, count] of STARTING_RATION) this.addInventory(kind, count);
    this.navigation.rebuild(this.player, getFlowFieldObstacles(this));
    this.critterDirector = new CritterDirector(this.createCritterWorld());
    this.wolfDirector = new WolfDirector(this.createWolfWorld());
    this.projectileCombat = new ProjectileCarriedCombatSystem(this.createProjectileCombatWorld());
  }

  /** 鹿模型下载完成后一次性启用猎物种群；重复调用不会重复撒怪。 */
  enableCritters(): void {
    if (this.crittersEnabled) return;
    this.crittersEnabled = true;
    this.critterDirector.seed();
  }

  /** 狼模型下载完成后启用守巢犬、白天野狼和夜袭刷新。 */
  enableWolves(): void {
    if (this.wolvesEnabled) return;
    this.wolvesEnabled = true;
    this.wolfDirector.seedDenGuards();
    this.wolfDirector.seedOpeningScout();
    // 资源可能直到入夜后才下载完；此时要从本夜的完整配额重新开始。
    if (this.phase === "night") this.wolfDirector.beginNight();
    else this.wolfDirector.beginDay();
  }

  /** 猎物种群能看到的世界。口径同 createWolfWorld，见 CritterWorld 的注释。 */
  private createCritterWorld(): CritterWorld {
    const sim = this;
    return {
      get world() { return sim.world; },
      get items() { return sim.items; },
      get structures() { return sim.structures; },
      get player() { return sim.player; },
      get spawnAnchor() { return sim.spawnAnchor; },
      get spawnFacing() { return sim.spawnFacing; },
      random: () => sim.random(),
      emit: (event) => { sim.events.push(event); },
      createDrop: (position, kind, angleOffset, count) => sim.createDrop(position, kind, angleOffset, count),
      findNearestWalkablePoint: (origin) => sim.findNearestWalkablePoint(origin),
    };
  }

  /**
   * 狼群能看到的世界。
   *
   * 全部用 getter 而不是快照 —— 相位、时间、玩家状态每帧都在变，取值必须是实时的。
   * 这三十来项就是狼群和模拟层之间**全部**的耦合面：以前它们散在 3600 行里，
   * 现在集中成一张表，想继续解耦就从这张表往下削。
   */
  private createWolfWorld(): WolfWorld {
    const sim = this;
    return {
      get world() { return sim.world; },
      get player() { return sim.player; },
      get items() { return sim.items; },
      get structures() { return sim.structures; },
      get navigation() { return sim.navigation; },
      get retreatNavigations() { return sim.retreatNavigations; },
      get tuning() { return sim.tuning; },
      get phase() { return sim.phase; },
      get phaseTime() { return sim.phaseTime; },
      get day() { return sim.day; },
      get elapsed() { return sim.elapsed; },
      get reviveGrace() { return sim.reviveGrace; },
      random: () => sim.random(),
      emit: (event) => { sim.events.push(event); },
      damagePlayer: (amount, attacker) => {
        if (amount <= 0) return;
        sim.player.health -= amount;
        sim.healthDamageCause = "killed";
        sim.healthDamageAttacker = attacker.kind;
      },
      setCombatTimer: (seconds) => { sim.combatTimer = seconds; },
      noteActivity: () => sim.noteActivity(),
      getDefense: () => sim.getDefense(),
      getPhaseDuration: () => sim.getPhaseDuration(),
      getLitFires: () => sim.getLitFires(),
      getPlayerShelter: () => sim.getPlayerShelter(),
      getPlayerArmor: () => ARMOR_STATS[sim.player.armor],
      createDrop: (position, kind, angleOffset, count) => sim.createDrop(position, kind, angleOffset, count),
      moveEntity: (entity, dx, dz, radius, collideWithItems, terrainSlopeAllowance) =>
        moveEntity(sim, entity, dx, dz, radius, collideWithItems, terrainSlopeAllowance),
      canStepToward: (from, dir, radius, collideWithItems) => canStepToward(sim, from, dir, radius, collideWithItems),
      findSteppableDirection: (from, desired, collideWithItems) =>
        findSteppableDirection(sim, from, desired, collideWithItems),
      findNearestWalkablePoint: (origin) => sim.findNearestWalkablePoint(origin),
      lineOfSightBlocked: (start, end) => lineOfSightBlocked(sim, start, end),
      hasMeleeLine: (start, end) => hasMeleeLine(sim, start, end),
      distanceToWorldEdge: (point) => sim.distanceToWorldEdge(point),
      getSteeredDirection: (entity, desired) => getSteeredDirection(sim, entity, desired),
      getBarrierDamage: (wolf, armor) => sim.getBarrierDamage(wolf, armor),
      isBlockingGroundItem,
    };
  }

  /**
   * 投射/搬运战斗系统的全部依赖。
   *
   * 和 WolfWorld 一样，动态状态全部走 getter；模块可以杀狼、击退、落石，
   * 但看不到昼夜推进、装备树、胜利结算等无关规则。
   */
  private createProjectileCombatWorld(): ProjectileCarriedCombatWorld {
    const sim = this;
    return {
      get player() { return sim.player; },
      get wolves() { return sim.wolves; },
      get critters() { return sim.critters; },
      get barrels() { return sim.barrels; },
      get items() { return sim.items; },
      get camps() { return sim.camps; },
      get campDefinitions() { return sim.world.camps; },
      random: () => sim.random(),
      emit: (event) => { sim.events.push(event); },
      noteActivity: () => sim.noteActivity(),
      getConditionCooldownScale: () => sim.getConditionCooldownScale(),
      damagePlayer: (amount, attacker) => {
        if (amount <= 0) return;
        sim.player.health -= amount;
        sim.healthDamageCause = "killed";
        sim.healthDamageAttacker = attacker.kind;
      },
      killWolf: (wolf) => sim.wolfDirector.killWolf(wolf),
      knockbackWolf: (wolf, knockback, stun) => sim.wolfDirector.applyKnockback(wolf, {
        knockback,
        knockbackStun: stun,
      }),
      killCritter: (critter) => sim.critterDirector.kill(critter),
    };
  }

  start(): void {
    this.running = true;
    this.events.push({ type: "message", key: "msg.1" });
  }

  /**
   * 教学期间挂起世界时钟，结束时放开。**两段教学共用这一道闸**。
   *
   * 开场教学（第一天，时钟还没起表）：闸的作用是不让 `noteActivity()` 点亮
   * clockStarted。放开的那一刻**不**主动起表 —— 仍然等玩家的下一次移动。
   * 教学最后一步是"打开背包"，站着不动就能做完；放开就开始倒数的话，
   * 玩家还在看背包，第一天已经在流逝了。
   *
   * 第一夜教学（时钟早就在跑）：那时光挡 noteActivity 不够，闸必须直接把
   * update() 的时钟段整段跳掉 —— 五轴不掉、相位不走、火不烧、狗不动。
   * 这正是"入夜先停一下，把狼嚎和篝火讲清楚"所需要的暂停。
   *
   * 两种情形下**移动、攻击、拾取都仍然是活的**：它们排在时钟闸之前，
   * 教学要玩家真的动手，冻结的只是世界，不是玩家。
   */
  setTutorialHold(active: boolean): void {
    this.tutorialHold = active;
  }

  /** 教学期间时钟是否被挂起。渲染层用它决定要不要画昼夜推进。 */
  get tutorialHeld(): boolean {
    return this.tutorialHold;
  }

  update(deltaSeconds: number, movement: Vec2): void {
    if (!this.running) return;
    const delta = Math.min(deltaSeconds, 0.05);
    // 驶离期间整个模拟停摆：不掉水、不掉饿、狗追不上来，摇杆也不再有作用。
    // 让生存轴继续跑的话，最后这十秒会出现"通关动画里渴死"这种荒唐结局。
    if (this.departTimer > 0) {
      this.updateDeparture(delta);
      return;
    }
    this.player.attackCooldown = Math.max(0, this.player.attackCooldown - delta);
    this.player.attackFlash = Math.max(0, this.player.attackFlash - delta);
    this.player.hurtFlash = Math.max(0, this.player.hurtFlash - delta);
    const isMoving = Math.hypot(movement.x, movement.z) >= 0.08;
    this.updatePlayerMovement(delta, movement, isMoving);
    /*
     * 拾取在时钟闸**之前**结算。
     *
     * 掉落物是玩家自己动作的直接结果（砍死一只虫 → 掉肉 → 进包），这条反馈链
     * 不该受"时钟有没有开始"影响。原先它排在闸后面，于是教学冻结时钟时，
     * 肉会掉在地上一动不动 —— 第一次击杀的收尾断在最后一环，而那正是
     * 整个教学最该给足反馈的一步。
     *
     * 挪上来对正常游戏没有影响：闸打开之前玩家除了走动什么也做不了，
     * 地上本来就不会有掉落物。过期判定用的 this.elapsed 在闸后才累加，
     * 所以冻结期间掉落物也不会计时消失。
     */
    this.updateDrops();
    // 时钟闸。`tutorialHold` 在这里也要挡住 —— 第一夜教学起表之后才开始，
    // 光靠 clockStarted 拦不下它。见 setTutorialHold。
    if (!this.clockStarted || this.tutorialHold) return;

    this.elapsed += delta;
    this.phaseTime -= delta;
    this.combatTimer = Math.max(0, this.combatTimer - delta);
    this.reviveGrace = Math.max(0, this.reviveGrace - delta);
    this.coolCooldown = Math.max(0, this.coolCooldown - delta);
    this.warmCooldown = Math.max(0, this.warmCooldown - delta);
    this.truckHornCooldown = Math.max(0, this.truckHornCooldown - delta);
    if (!isMoving) this.player.idleTime += delta;
    this.navigationCountdown -= delta;
    if (this.navigationCountdown <= 0) {
      this.navigation.rebuild(this.player, getFlowFieldObstacles(this));
      this.navigationCountdown = 0.65;
    }

    this.updateNeeds(delta);
    this.updateFires(delta);
    this.updateCacti();
    this.updateWells();
    this.updateStructures(delta);
    this.projectileCombat.update(delta);
    if (this.crittersEnabled) this.critterDirector.update(delta);
    if (this.wolvesEnabled) this.wolfDirector.updateWolves(delta);
    this.updateRest(delta);
    this.updateObjectives();

    if (this.phaseTime <= 0) this.advancePhase();

    // 游戏结束判定：水分或饥饿归零立即死亡，生命归零为战斗/衰竭死。
    // 体温越界不再致死，只施加中暑/失温的瘫痪状态，见 updateCondition()。
    if (!this.gameOverSent) {
      if (this.player.water <= 0) {
        this.player.water = 0;
        this.endGame("dehydrated");
      } else if (this.player.hunger <= 0) {
        this.player.hunger = 0;
        this.endGame("starved");
      } else if (this.player.health <= 0) {
        this.player.health = 0;
        // 血归零有两条完全不同的路：被狼咬死，或者体力恒定流失把你耗干。
        // 不能拿 combatTimer 猜 —— 它会在挨咬后继续亮 6 秒，这期间若被自然流失
        // 补掉最后一点血，旧逻辑仍会误报“被狼咬死”。伤害入口现在逐次记最后来源。
        this.endGame(this.healthDamageCause);
      }
    }
  }

  /** 死亡瞬间的瘫痪状态，供结算文案指出真正的死因链。 */
  deathCondition: SurvivalCondition = "normal";

  /** 复活后的无敌剩余秒数。见 revive()。 */
  private reviveGrace = 0;
  /** 本次交互开始前的静止时长；劳力不足导致交互落空时用它还原，见 spendStamina()。 */
  private idleTimeBeforeAction = 0;

  private endGame(cause: DeathCause): void {
    this.deathCondition = this.player.condition;
    this.deathKiller = cause === "killed" ? this.healthDamageAttacker : null;
    this.setResting(false);
    this.running = false;
    this.gameOverSent = true;
    this.deathCause = cause;
    this.events.push({
      type: "game-over",
      cause,
      condition: this.deathCondition,
      killer: this.deathKiller,
    });
  }

  /**
   * 原地复活。给激励视频用 —— 玩家看完广告，从倒下的地方接着打。
   *
   * 三条设计约束：
   *
   * 1. **不是满血复活。** 五轴各回到 45 上下就够站起来走，但离舒服还远 ——
   *    复活是"再给你一次机会"，不是"这一局重来"。给满的话玩家会把广告当补给站，
   *    水与食物那两条轴在他眼里就不再是威胁。
   * 2. **必须把狗推开。** 死在犬群中间的话，复活的下一帧就会被咬回去，
   *    那次广告等于白看 —— 这是所有"原地续命"最容易翻车的地方。
   * 3. **给一段无敌时间。** 推开还不够：夜里几十只狗，推开 8 米也就两秒的事。
   *
   * 返回 false 表示这局不是"死了"的状态（已通关、或压根没死），调用方不该发奖励。
   */
  revive(): boolean {
    if (this.running || this.victorySent || !this.gameOverSent) return false;
    this.gameOverSent = false;
    this.deathCause = null;
    this.deathKiller = null;
    this.deathCondition = "normal";
    this.healthDamageCause = "exhausted";
    this.healthDamageAttacker = null;
    this.running = true;
    this.player.health = Math.max(this.player.health, 45);
    this.player.water = Math.max(this.player.water, 45);
    this.player.hunger = Math.max(this.player.hunger, 45);
    this.player.stamina = Math.max(this.player.stamina, this.player.maxStamina * 0.5);
    // 体温拉回舒适区中段：中暑/失温本身不致死，但带着 −75% 移速站起来
    // 等于没复活。
    this.player.warmth = clamp(this.player.warmth, 35, 65);
    this.player.condition = "normal";
    this.player.hurtFlash = 0;
    this.combatTimer = 0;
    this.reviveGrace = REVIVE_GRACE_SECONDS;
    this.wolfDirector.pushWolvesAway(REVIVE_CLEAR_RADIUS);
    this.events.push({ type: "revive" });
    return true;
  }

  private endGameWithVictory(): void {
    if (this.victorySent) return;
    this.setResting(false);
    this.running = false;
    this.victorySent = true;
    this.won = true;
    this.events.push({ type: "victory" });
  }

  requestInteraction(): void {
    // 驶离期间整个操作面锁死：那十秒里玩家已经在车上了，按什么都不该有反应。
    if (!this.running || this.departTimer > 0) return;
    // 记下按之前的静止时长：这次点击如果因为劳力不够而什么都没做，
    // 它要被原样还回去，见 spendStamina()。
    this.idleTimeBeforeAction = this.player.idleTime;
    this.noteActivity();

    // 水分是"归零即死"的轴。一旦玩家站在枯木堆里，E 会一直被拾取抢走，
    // 人就会活活渴死 —— 所以水分告急时，够得着的水源要抢在拾取前面。
    // 与旧的挖沙不同，水源现在有位置，够不着就正常往下走别的交互。
    if (this.player.water < WATER_URGENT && !this.player.carrying) {
      const urgentCactus = this.findNearestCactus(2.7);
      if (urgentCactus) {
        this.harvestCactus(urgentCactus);
        return;
      }
      const urgentWell = this.findNearestWell(WELL_REACH);
      if (urgentWell) {
        this.beginWaterDraw(urgentWell);
        return;
      }
    }

    // 扛着油桶站在车尾 —— 这一按是装车而不是放地上。装车不可逆，
    // 所以判定半径（4.5）比拾取半径（2.6）宽：对着车找角度不该是玩法的一部分。
    if (this.player.carrying === "fuel" && this.projectileCombat.hasCarriedBarrel
      && distance(this.player, this.truck) <= TRUCK_LOAD_REACH) {
      this.loadCarriedBarrel();
      return;
    }

    if (this.player.carrying) {
      this.dropCarriedItem();
      return;
    }

    /*
     * 抓狼。排在发车**之后**、拾取之前：加满油站在车边时那一下必须是走人，
     * 旁边躺着只晕狼也不能抢；但除此之外，一只此刻动不了的狼比脚边任何东西都值钱。
     */
    const grabbable = this.truck.loaded >= FUEL_REQUIRED
      && distance(this.player, this.truck) <= TRUCK_BOARD_REACH
      ? null : this.findGrabbableWolf();
    if (grabbable) {
      this.projectileCombat.grabWolf(grabbable);
      return;
    }

    // 空手站在加满油的车边 = 发车。放在拾取之前，否则车边掉了根柴就永远上不了车。
    if (this.truck.loaded >= FUEL_REQUIRED && distance(this.player, this.truck) <= TRUCK_BOARD_REACH) {
      this.departWithTruck();
      return;
    }

    // 三桶油之后，卡车第一次从“目标”变成一件能救场的工具。
    // 只有附近确实有普通狼时才占 E，冷却期间则继续让出交互键。
    if (this.canUseTruckHorn()) {
      this.useTruckHorn();
      return;
    }

    // 添柴：从背包里取一根烧掉。木头进背包之后不必再扛着走，
    // 配合放大到 10 米的火焰半径，营地事务不用全挤在火堆脚下。
    //
    // 但 10 米几乎盖住整座营地，所以添柴只在**它比脚边的东西更近**时才抢 E ——
    // 否则站在营地里就永远捡不起第二根柴：捡完第一根，第二根旁边的 E 会直接烧掉它。
    if (this.getInventoryCount("wood") > 0) {
      const hearth = this.findNearestHearth(FIRE_WARMTH_RADIUS);
      if (hearth && !this.hasNearerTarget(hearth.distance)) {
        this.removeInventory("wood", 1);
        this.camps[hearth.campId].fuel = clamp(this.camps[hearth.campId].fuel + 95, 0, 300);
        this.events.push({ type: "feed-fire", campId: hearth.campId });
        return;
      }
    }

    const barrel = this.findNearestBarrel(FUEL_PICKUP_REACH);
    if (barrel) {
      this.projectileCombat.pickupBarrel(barrel);
      return;
    }

    const item = this.findNearestItem(ITEM_PICKUP_REACH);
    if (item) {
      if (item.kind === "wood") {
        if (!this.spendStamina(STAMINA_COST_WOOD, "labour.wood")) return;
        if (!this.addInventory("wood", 1)) {
          this.player.stamina = Math.min(this.player.maxStamina, this.player.stamina + STAMINA_COST_WOOD);
          this.events.push({ type: "message", key: "msg.2" });
          return;
        }
      } else {
        this.player.carrying = item.kind;
      }
      item.active = false;
      this.events.push({ type: "pickup", kind: item.kind });
      return;
    }

    const structure = this.findNearestStructure(2.7);
    if (structure) {
      structure.active = false;
      this.carriedStructure = structure;
      this.player.carrying = structure.kind;
      this.events.push({ type: "pickup", kind: structure.kind });
      return;
    }

    const cactusPatch = this.findNearestCactus(2.7);
    if (cactusPatch) {
      this.harvestCactus(cactusPatch);
      return;
    }

    const ironNode = this.findNearestIron(2.8);
    if (ironNode) {
      if (!this.spendStamina(STAMINA_COST_MINE, "labour.mine")) return;
      if (!this.addInventory("iron-ore", 1)) {
        this.events.push({ type: "message", key: "msg.3" });
        return;
      }
      ironNode.ore -= 1;
      this.events.push({ type: "pickup", kind: "iron-ore" });
      this.events.push({ type: "message", key: "msg.4", params: { v0: this.describeNextUpgrade("weapon") } });
      return;
    }

    const tree = this.findNearestTree(TREE_REACH);
    if (tree) {
      if (!this.spendStamina(STAMINA_COST_CHOP, "labour.chop")) return;
      if (!this.addInventory("wood", 1)) {
        // 劳力要退回去 —— 背包满时这一下什么也没发生，不该收钱。
        this.player.stamina = Math.min(this.player.maxStamina, this.player.stamina + STAMINA_COST_CHOP);
        this.events.push({ type: "message", key: "msg.2" });
        return;
      }
      tree.wood -= 1;
      this.events.push({ type: "pickup", kind: "wood" });
      return;
    }

    const well = this.findNearestWell(WELL_REACH);
    if (well) {
      this.beginWaterDraw(well);
      return;
    }
  }

  /** 地上（不是被扛着、也不是已装车的）离玩家最近的一桶油。 */
  private findNearestBarrel(maxDistance: number): FuelBarrelState | null {
    let best: FuelBarrelState | null = null;
    let bestDistance = maxDistance * maxDistance;
    for (const barrel of this.barrels) {
      if (barrel.placement !== "ground") continue;
      const value = distanceSquared(this.player, barrel);
      if (value >= bestDistance) continue;
      best = barrel;
      bestDistance = value;
    }
    return best;
  }

  /** 把手上这桶装进车斗。装满即可发车，但发车仍要玩家自己按一下。 */
  private loadCarriedBarrel(): void {
    const barrel = this.projectileCombat.takeCarriedBarrel();
    if (!barrel) return;
    barrel.placement = "loaded";
    this.truck.loaded += 1;
    this.events.push({ type: "fuel-loaded", loaded: this.truck.loaded, required: FUEL_REQUIRED });
    this.events.push({
      type: "message",
      key: this.truck.loaded >= FUEL_REQUIRED ? "msg.fuelFull" : "msg.fuelLoaded",
      params: { loaded: this.truck.loaded, required: FUEL_REQUIRED },
    });
  }

  getTruckPowerState(): TruckPowerState {
    const loaded = this.truck.loaded;
    return {
      loaded,
      electrics: loaded >= 1,
      headlights: loaded >= 2,
      horn: loaded >= 3,
      engine: loaded >= 5,
      ready: loaded >= FUEL_REQUIRED,
      hornCooldown: this.truckHornCooldown,
    };
  }

  /** 喇叭只在真有普通狼可震退时占住行动键，不妨碍车边装油和拾取。 */
  private canUseTruckHorn(): boolean {
    if (!this.getTruckPowerState().horn || this.truckHornCooldown > 0 || this.player.carrying) return false;
    if (distance(this.player, this.truck) > TRUCK_HORN_REACH) return false;
    return this.wolves.some((wolf) => wolf.mode !== "dead" && wolf.mode !== "retreating"
      && wolf.mode !== "grabbed" && wolf.mode !== "airborne" && wolf.kind !== "elite"
      && distanceSquared(wolf, this.truck) < TRUCK_HORN_RADIUS * TRUCK_HORN_RADIUS);
  }

  private useTruckHorn(): void {
    if (!this.canUseTruckHorn()) return;
    const affected = this.wolfDirector.repelFrom(this.truck, TRUCK_HORN_RADIUS);
    this.truckHornCooldown = TRUCK_HORN_COOLDOWN;
    this.noteActivity();
    this.events.push({ type: "truck-horn", affected });
    this.events.push({ type: "message", key: "msg.truckHorn", params: { count: affected } });
  }

  /**
   * 发车。之后的十来秒是结算动画，不是玩法：
   * 玩家坐在车上、生存轴停摆、狗咬不到。把它做成可玩的驾驶段会引出一整套
   * 载具操作与地形碰撞，而它只服务这一局的最后 10 秒。
   */
  private departWithTruck(): void {
    if (this.departTimer > 0 || this.victorySent) return;
    this.departTimer = TRUCK_DEPART_MAX_SECONDS;
    this.setResting(false);
    this.player.carrying = null;
    this.events.push({ type: "truck-depart" });
    this.events.push({ type: "message", key: "msg.truckDepart" });
  }

  /** 卡车正在驶离：把车和车上的人一起往地图外推，出界即通关。 */
  private updateDeparture(delta: number): void {
    this.departTimer -= delta;
    const exit = this.world.truck.exit;
    this.truck.x += exit.x * TRUCK_DEPART_SPEED * delta;
    this.truck.z += exit.z * TRUCK_DEPART_SPEED * delta;
    this.player.x = this.truck.x;
    this.player.z = this.truck.z;
    this.player.facing = exit;
    if (this.departTimer <= 0 || this.distanceToWorldEdge(this.truck) <= 1) {
      this.endGameWithVictory();
    }
  }

  /** 复活无敌还剩多久；HUD 拿它提示"这几秒不会掉血"。 */
  getReviveGrace(): number {
    return this.reviveGrace;
  }

  isDeparting(): boolean {
    return this.departTimer > 0;
  }

  /**
   * 火塘之外还有没有更近的可交互目标。
   * 采集类目标的判定半径都在 3.2 米以内，火塘却有 10 米 —— 不比距离的话，
   * 营地范围内的拾取、割仙人掌、挖矿、提水会被添柴全部吃掉。
   */
  private hasNearerTarget(hearthDistance: number): boolean {
    const barrel = this.findNearestBarrel(FUEL_PICKUP_REACH);
    if (barrel && distance(this.player, barrel) < hearthDistance) return true;
    const item = this.findNearestItem(ITEM_PICKUP_REACH);
    if (item && distance(this.player, item) < hearthDistance) return true;
    const structure = this.findNearestStructure(2.7);
    if (structure && distance(this.player, structure) < hearthDistance) return true;
    const cactus = this.findNearestCactus(2.7);
    if (cactus && distance(this.player, cactus) < hearthDistance) return true;
    const iron = this.findNearestIron(2.8);
    if (iron && distance(this.player, iron) < hearthDistance) return true;
    const tree = this.findNearestTree(TREE_REACH);
    if (tree && distance(this.player, tree) < hearthDistance) return true;
    const well = this.findNearestWell(WELL_REACH);
    if (well && distance(this.player, this.world.wells[well.id]) < hearthDistance) return true;
    return false;
  }

  /** 返回射程内蓄着水的井；没有则 null。 */
  private findNearestWell(maxDistance: number): WellState | null {
    let best: WellState | null = null;
    let bestDistance = maxDistance * maxDistance;
    for (const well of this.wells) {
      if (well.charges <= 0) continue;
      const value = distanceSquared(this.player, this.world.wells[well.id]);
      if (value >= bestDistance) continue;
      best = well;
      bestDistance = value;
    }
    return best;
  }

  /**
   * 扣劳力；不足时给出提示并返回 false，调用方应中止该次采集。
   * 劳力是本作对"无限点击采集"的唯一约束 —— 采集要花钱，钱有上限。
   */
  private spendStamina(cost: number, labelKey: string): boolean {
    if (this.player.stamina < cost) {
      /*
       * 劳力不够 = **这次点击什么也没发生**，所以"站着不动"的计时不该被它清零。
       *
       * 原先 requestInteraction 一进来就 noteActivity()，于是脱力时狂点捡柴
       * 会把 idleTime 永远压在 0，人就再也进不了休息 —— 而休息正是劳力唯一的
       * 快速回复途径。玩家因此卡在"没劳力→点不动→不能休息→还是没劳力"里。
       * 提水、挖矿、割仙人掌、建造走的是同一个函数，一起修好。
       */
      this.player.idleTime = this.idleTimeBeforeAction;
      this.events.push({ type: "exhausted" });
      this.events.push({ type: "message", key: "msg.5", params: { v0: loc(labelKey), v1: cost } });
      return false;
    }
    this.player.stamina -= cost;
    return true;
  }

  /** 割仙人掌取汁：一刀即得，代价是劳力和"你得先找到它"。 */
  private harvestCactus(patch: CactusPatch): void {
    if (!this.spendStamina(STAMINA_COST_CACTUS, "labour.cactus")) return;
    if (!this.addInventory("cactus-juice", 1)) {
      this.events.push({ type: "message", key: "msg.6" });
      return;
    }
    patch.juice -= 1;
    if (patch.juice === 0) patch.regrowAt = this.elapsed + 180;
    this.events.push({ type: "pickup", kind: "cactus-juice" });
  }

  /**
   * 从井里提水：**一按即得**，和割仙人掌是同一种手感。
   *
   * 等待期从 2.6 秒 → 1.4 秒 → 直接删掉。中间那版还留了一条"走出井口就中断"的
   * 空间约束，实测仍然是纯粹的税：井边随时可能有狗，玩家因此养成"先清场再取水"
   * 的习惯，而那个习惯里没有任何决策，只有一段站着看进度条的时间。
   *
   * 稀缺性从来不靠这几秒撑着 —— 井有存量（3 格）、回蓄要 210 秒、还得走一趟，
   * 这三条一条没动。删掉的只是"按下去之后什么时候才生效"。
   */
  private beginWaterDraw(well: WellState): void {
    if (this.getInventoryCount("water") >= INVENTORY_STACK_LIMITS.water * 2) {
      this.events.push({ type: "message", key: "msg.7" });
      return;
    }
    if (well.charges <= 0) {
      this.events.push({ type: "message", key: "msg.8" });
      return;
    }
    if (!this.spendStamina(STAMINA_COST_DRAW, "labour.draw")) return;
    if (!this.addInventory("water", 1)) {
      this.events.push({ type: "message", key: "msg.9" });
      return;
    }
    this.events.push({ type: "draw-water" });
    well.charges -= 1;
    if (well.refillAt <= 0) well.refillAt = this.elapsed + WELL_REFILL_SECONDS;
    this.events.push({ type: "pickup", kind: "water" });
  }

  /** 井的回蓄：每 WELL_REFILL_SECONDS 补一格，补满后停表。 */
  private updateWells(): void {
    for (const well of this.wells) {
      // 开局就未满，所以没在计时的井要先把蓄水表打开。
      if (well.refillAt <= 0 && well.charges < WELL_CHARGES_MAX) {
        well.refillAt = this.elapsed + WELL_REFILL_SECONDS;
        continue;
      }
      if (well.refillAt <= 0 || this.elapsed < well.refillAt) continue;
      well.charges = Math.min(WELL_CHARGES_MAX, well.charges + 1);
      well.refillAt = well.charges >= WELL_CHARGES_MAX ? 0 : this.elapsed + WELL_REFILL_SECONDS;
    }
  }

  /** 够得着且已硬直/重伤的狼；判定与状态归投射战斗系统。 */
  findGrabbableWolf(): WolfState | null {
    return this.projectileCombat.findGrabbableWolf();
  }

  /**
   * 此刻按行动键会捡起哪件地上物（够不着返回 null）。只读，不产生任何副作用。
   *
   * 给自动机用：`getInteractionHint()` 只说"这一下是 pickup"，不说捡的是什么，
   * 而"要不要捡"恰恰取决于是什么 —— 扛起石头会让近战整个失效（见
   * hasAttackTargetInRange），在猎场里顺手捡一块的代价是那一趟猎白打。
   */
  getPickupCandidate(): GroundItem | null {
    return this.findNearestItem(ITEM_PICKUP_REACH);
  }

  /** 扛着的石头此刻扔不扔得中。见 hasAttackTargetInRange —— 那一条在扛东西时恒为假。 */
  hasThrowTargetInRange(): boolean {
    return this.projectileCombat.hasStoneTarget();
  }

  /** 面朝可爆破火源时的目标；预算耗尽后返回 null，HUD 不再承诺“爆破”。 */
  getBarrelBlastTarget(): CampDefinition | null {
    return this.projectileCombat.getBarrelBlastTarget();
  }

  /** 地图上仍可安全消耗的额外油桶数。 */
  getFuelBlastBudget(): number {
    return this.projectileCombat.getFuelBlastBudget();
  }
  requestAttack(): void {
    if (!this.running || this.departTimer > 0 || this.player.attackCooldown > 0) return;
    // 石头、活狼和油桶的投掷、飞行与命中都由独立系统结算。
    if (this.projectileCombat.tryAttack()) return;
    if (this.player.carrying) return;
    this.noteActivity();
    const stats = WEAPON_STATS[this.player.weapon];
    /*
     * **挥砍不再扣劳力。**
     *
     * 劳力从此只由采集与建造消耗，战斗不再和它抢预算 —— 原先夜里一边挨咬一边
     * 眼看劳力见底，而劳力见底又意味着白天采不动，一次守夜失败会连着毁掉第二天。
     *
     * `stats.stamina` 没有删，含义变成**挥满力所需的储备**：劳力低于这个数
     * 照样能砍，但伤害衰减到 60%。于是"把自己采空了再去打架"仍然有代价，
     * 只是代价不再是"打架本身让你更采不动"。
     */
    const exhausted = this.player.stamina < stats.stamina;
    if (exhausted) this.events.push({ type: "exhausted" });
    this.player.attackCooldown = ATTACK_COOLDOWN * this.getConditionCooldownScale();
    this.player.attackFlash = 0.22;
    this.events.push({ type: "attack" });
    let hit = false;

    const attackRange = stats.range;
    // 转向辅助优先锁狼：猎物不还手，被狼咬着还去追兔子才是真的要命。
    const inRange = <T extends Vec2>(list: T[], alive: (item: T) => boolean): T | undefined => list
      .filter((item) => alive(item) && distanceSquared(this.player, item) <= attackRange * attackRange)
      .sort((a, b) => distanceSquared(this.player, a) - distanceSquared(this.player, b))[0];
    const assistedTarget = inRange(this.wolves, (wolf) => wolf.mode !== "dead")
      ?? inRange(this.critters, (critter) => critter.mode !== "dead");
    if (assistedTarget) this.player.facing = direction(this.player, assistedTarget);

    // 连击在挥砍**之前**结算：本次的主目标（扇形里最近的那个）和上一次是不是同一个。
    // 主目标而不是"全部目标"，是因为刀线一刀扫好几个，"同一个目标"对它没有定义 ——
    // 而这正是设计要的：刀线结构上吃不到连击，永远停在 0 段。
    const comboMultiplier = this.advanceCombo(stats, assistedTarget);

    const inArc = (target: Vec2): boolean =>
      distanceSquared(this.player, target) <= attackRange * attackRange
      && dot(this.player.facing, direction(this.player, target)) >= stats.arcDot
      && hasMeleeLine(this, this.player, target);

    for (const wolf of this.wolves) {
      if (wolf.mode === "dead" || !inArc(wolf)) continue;
      const wasRetreating = wolf.mode === "retreating";
      const { damage } = this.rollDamage(stats, comboMultiplier, exhausted, wolf.defense);
      wolf.health -= damage;
      wolf.hurtFlash = 0.18;
      wolf.provoked = true;
      if (wolf.health <= 0) wolf.mode = "dead";
      else if (!wasRetreating) wolf.mode = "chase";
      wolf.lostTimer = 0;
      hit = true;
      this.events.push({ type: "wolf-hit", wolfId: wolf.id });
      if (wolf.health <= 0) this.wolfDirector.killWolf(wolf);
      else this.wolfDirector.applyKnockback(wolf, stats);
    }

    // 猎物：同一次挥砍也会打到，伤害算法和打狼一致（它们没有护甲）。
    for (const critter of this.critters) {
      if (critter.mode === "dead" || !inArc(critter)) continue;
      // 和打狼走同一条伤害管线（含随身枯木加成与重创），否则 HUD 上显示的攻击力
      // 在砍猎物时对不上账。
      critter.health -= this.rollDamage(stats, comboMultiplier, exhausted, 0).damage;
      critter.hurtFlash = 0.18;
      // 挨了一下必然受惊，冲刺条也回满 —— 第一刀没打死就得追。
      critter.mode = "flee";
      critter.sprint = CRITTER_SPECS[critter.kind].sprintSeconds;
      hit = true;
      this.events.push({ type: "critter-hit", critterId: critter.id });
      if (critter.health <= 0) this.critterDirector.kill(critter);
    }

    if (hit && stats.healthOnHit > 0) {
      this.player.health = clamp(
        this.player.health + stats.healthOnHit,
        0,
        this.player.maxHealth,
      );
    }

    if (this.phase === "night") {
      for (const wolf of this.wolves) {
        if (wolf.mode !== "dead" && distanceSquared(this.player, wolf) < 17 * 17) {
          wolf.mode = "chase";
          wolf.lostTimer = 0;
        }
      }
    }
    if (!hit && this.objectiveStage >= 3) this.events.push({ type: "message", key: "msg.10" });
  }

  /**
   * 一次命中的伤害。
   *
   * 顺序是刻意的：**重创与连击的倍率在减护甲之前结算**。
   * 先乘后减，倍率就对"打有甲目标"格外划算，"重击能破甲"这个直觉才成立；
   * 反过来先减后乘，重创会在小狼身上被放大、在精英狼身上被稀释，正好是反的。
   */
  private rollDamage(
    stats: WeaponStat,
    comboMultiplier: number,
    exhausted: boolean,
    targetDefense: number,
  ): { damage: number; crit: boolean } {
    const crit = stats.critChance > 0 && this.random() < stats.critChance;
    if (crit) this.events.push({ type: "crit" });
    const needsMultiplier = this.player.hunger < 15 || this.player.water < 15 ? 0.8 : 1;
    const staminaMultiplier = exhausted ? EXHAUSTED_DAMAGE_SCALE : 1;
    const raw = this.getAttackPower()
      * (crit ? stats.critMult : 1)
      * comboMultiplier
      * needsMultiplier
      * staminaMultiplier;
    const effectiveDefense = Math.max(0, targetDefense - stats.pierce);
    return { damage: Math.max(1, Math.round(raw) - effectiveDefense), crit };
  }

  /**
   * 剑线连击：连续命中同一个主目标，逐段加伤；换目标或超时清零。
   * 返回本次挥砍的伤害倍率。
   */
  private advanceCombo(stats: WeaponStat, primary: Vec2 | undefined): number {
    if (stats.comboMax <= 0) {
      // 刀线：不参与连击，也不应该保留上一把剑留下的层数。
      if (this.comboStacks !== 0) {
        this.comboStacks = 0;
        this.comboTargetKey = null;
        this.events.push({ type: "combo", stacks: 0 });
      }
      return 1;
    }
    const key = primary ? this.targetKey(primary) : null;
    if (key !== null && key === this.comboTargetKey) {
      this.comboStacks = Math.min(stats.comboMax, this.comboStacks + 1);
    } else {
      this.comboStacks = 0;
      this.comboTargetKey = key;
    }
    this.comboTimer = COMBO_WINDOW;
    this.events.push({ type: "combo", stacks: this.comboStacks });
    return 1 + this.comboStacks * stats.comboStep;
  }

  /** 狼和猎物的 id 是两个独立的数字空间，连击要认人就得先把它们分开。 */
  private targetKey(target: Vec2): string | null {
    const wolf = this.wolves.find((candidate) => candidate === target);
    if (wolf) return `w${wolf.id}`;;
    const critter = this.critters.find((candidate) => candidate === target);
    return critter ? `c${critter.id}` : null;
  }

  // 旧的饮食快捷方法已经删除：它们只服务于 HUD 快捷键和 R/F/C 热键。
  // 消耗现在一律走背包的物品格（开背包会暂停游戏）。
  useInventorySlot(index: number): void {
    if (!this.running) return;
    const stack = this.player.inventory[index];
    if (!stack) return;
    this.noteInPlaceAction();

    // 各分支自己去改五条轴，这里只在外面量一次前后差并报出去 ——
    // 好处是加一种新消耗品不用记得补一条事件，漏报是不可能的。
    const before = {
      health: this.player.health,
      water: this.player.water,
      hunger: this.player.hunger,
      warmth: this.player.warmth,
    };
    try {
      this.consumeSlot(index, stack);
    } finally {
      const delta = {
        health: Math.round(this.player.health - before.health),
        water: Math.round(this.player.water - before.water),
        hunger: Math.round(this.player.hunger - before.hunger),
        warmth: Math.round(this.player.warmth - before.warmth),
      };
      if (delta.health || delta.water || delta.hunger || delta.warmth) {
        this.events.push({ type: "nourish", ...delta });
      }
    }
  }

  private consumeSlot(index: number, stack: InventoryStack): void {

    // 每种消耗品同时喂多条轴，权重不同：
    // 肉主要补体力和饥饿，仙人掌汁偏水分，水是纯水分且都要付体温代价。
    // 仙人掌汁：补水为主、少量顶饿，并且和水一样降体温。
    if (stack.kind === "cactus-juice") {
      // 基准区间：水分 +8~16、饥饿 +1~5、体温 -5~-10（我们各自上调了一点）。
      // 所有消耗品都用随机区间而非固定值，所以每次采集的收益是有波动的。
      if (this.isNourishmentFull(JUICE_HUNGER[1], JUICE_WATER[1], 3)) return;
      this.removeFromSlot(index, 1);
      this.player.hunger = clamp(this.player.hunger + this.randomInt(...JUICE_HUNGER), 0, 100);
      this.player.water = clamp(this.player.water + this.randomInt(...JUICE_WATER), 0, 100);
      this.player.health = clamp(this.player.health + 3, 0, this.player.maxHealth);
      this.player.warmth = clamp(this.player.warmth - this.randomInt(...JUICE_WARMTH), WARMTH_MIN, WARMTH_MAX);
      this.updateCondition();
      this.events.push({ type: "eat", kind: "cactus-juice" });
      return;
    }
    if (stack.kind === "cooked-meat") {
      // 烤肉：回体力最多的食物（生肉的两倍），所以它值得为之走一趟火边。
      if (this.isNourishmentFull(COOKED_HUNGER[1], COOKED_WATER[1], COOKED_HEALTH)) return;
      this.removeFromSlot(index, 1);
      this.player.hunger = clamp(this.player.hunger + this.randomInt(...COOKED_HUNGER), 0, 100);
      this.player.water = clamp(this.player.water + this.randomInt(...COOKED_WATER), 0, 100);
      this.player.health = clamp(this.player.health + COOKED_HEALTH, 0, this.player.maxHealth);
      this.events.push({ type: "eat", kind: "cooked-meat" });
      return;
    }
    if (stack.kind === "water") {
      if (this.player.water >= 99) {
        this.events.push({ type: "message", key: "msg.11" });
        return;
      }
      this.removeFromSlot(index, 1);
      this.player.water = clamp(this.player.water + WATER_RESTORE, 0, 100);
      this.player.warmth = clamp(this.player.warmth - WATER_WARMTH_COST, WARMTH_MIN, WARMTH_MAX);
      this.updateCondition();
      this.events.push({ type: "drink" });
      if (this.phase === "night" && this.player.warmth < 32) {
        this.events.push({ type: "message", key: "msg.12" });
      }
      return;
    }
    if (stack.kind === "raw-meat") {
      // 生肉直接就能吃，烤肉是另一个更好的独立物品，从来不是吃肉的前置。
      // 生肉回**一半**体力（见 RAW_HEALTH），烤肉回满 —— 走一趟火边把收益翻倍，
      // "现在生吞垫一口，还是留到火边烤了再吃"因此仍然是个真实取舍。
      if (this.isNourishmentFull(RAW_HUNGER[1], RAW_WATER[1], RAW_HEALTH)) return;
      this.removeFromSlot(index, 1);
      this.player.hunger = clamp(this.player.hunger + this.randomInt(...RAW_HUNGER), 0, 100);
      this.player.water = clamp(this.player.water + this.randomInt(...RAW_WATER), 0, 100);
      this.player.health = clamp(this.player.health + RAW_HEALTH, 0, this.player.maxHealth);
      this.events.push({ type: "eat", kind: "cooked-meat" });
      // 火就在旁边却生吞 —— 这是提示烤肉最有说服力的一刻：机会正在被浪费。
      // 报的是**差额**（烤了能多回多少），不是熟肉的总量。
      if (this.findNearestLitFire(FIRE_WARMTH_RADIUS)) {
        this.events.push({
          type: "message", key: "msg.13", params: { v0: COOKED_HEALTH - RAW_HEALTH },
        });
      } else if (!this.rawMeatHintSent) {
        this.rawMeatHintSent = true;
        this.events.push({ type: "message", key: "msg.14" });
      }
      return;
    }
    // 材料格的提示按**当前线**动态生成。写死"3块铁矿可制作粗铁矛"的话，
    // 走剑线的玩家点开背包会被劝去造一件他这条线上根本没有的东西。
    this.events.push({ ...this.describeNextUpgrade(stack.kind === "iron-ore" ? "weapon" : "armor"), type: "message" });
  }

  /**
   * 把配方清单摊成一条可渲染的文案。
   * 参数占位只吃字符串/数字/单条 LocalizedText，所以数组必须在这里先合成一条。
   */
  private describeCost(cost: Array<[InventoryItemKind, number]>): LocalizedText {
    return cost
      .map(([kind, count]) => loc("sim.costPart", { name: loc(`item.${kind}.name`), count }))
      .reduce((left, right) => loc("sim.costJoin", { left, right }));
  }

  /** 某个槽位接下来能做什么，一句话。分叉未定时列出两条线让玩家挑。 */
  private describeNextUpgrade(slot: "weapon" | "armor"): LocalizedText {
    const options = this.getUpgradeOptions(slot);
    const noun = loc(slot === "weapon" ? "slot.weapon" : "slot.armor");
    if (options.length === 0) return loc("sim.1", { v0: noun, v1: loc(`equip.${this.getEquipped(slot).id}.name`) });
    if (options.length === 1) return loc("sim.2", { v0: loc(`equip.${options[0].id}.name`), v1: loc(`equip.${options[0].id}.blurb`) });
    return loc("sim.3", { v0: noun, v1: loc(options.length === 2 ? "sim.lineChoice" : "sim.lineChoiceOne", { a: loc(`equip.${options[0].id}.name`), b: loc(`equip.${options[options.length - 1].id}.name`) }) });
  }

  /** 闭区间随机整数。 */
  private randomInt(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  /** 三条轴都已经满到吃了也不回血的程度时，别浪费这份food。 */
  private isNourishmentFull(hunger: number, water: number, health: number): boolean {
    if (hunger > 0 && this.player.hunger < 99) return false;
    if (water > 0 && this.player.water < 99) return false;
    if (health > 0 && this.player.health < this.player.maxHealth) return false;
    return true;
  }

  /**
   * 装备升级：四条线（刀 / 剑 / 铁甲 / 皮甲），每条三阶，**从一阶就分叉**。
   *
   * 三阶而不是两阶，是因为狼群数量按 40+(d-1)×15 一路涨到 90，而旧的两件装备
   * 第 2 天就拿全了 —— 威胁曲线继续爬、玩家曲线却平掉，后期就变成一堵墙而不是高潮。
   *
   * 分叉而不是直线，是因为直线升级不产生决策，只产生待办事项：材料够了就点。
   * 分叉之后每个槽位的第一次升级都是一次承诺 —— 它决定接下来四天你去挖矿还是去捡柴。
   *
   * 这两个无参方法保留给键盘快捷键与旧调用点：默认走**当前线**的下一阶；
   * 还在阶 0 时无从选择，直接返回 false，由 UI 的分叉卡负责让玩家挑。
   */
  craftWeapon(): boolean {
    const options = this.getUpgradeOptions("weapon");
    if (options.length !== 1) return false;
    return this.craftEquip("weapon", options[0].id);
  }

  craftArmor(): boolean {
    const options = this.getUpgradeOptions("armor");
    if (options.length !== 1) return false;
    return this.craftEquip("armor", options[0].id);
  }

  /** 当前装着的那一件。 */
  getEquipped(slot: "weapon" | "armor"): EquipTier {
    const tiers = slot === "weapon" ? WEAPON_TIERS : ARMOR_TIERS;
    const current = slot === "weapon" ? this.player.weapon : this.player.armor;
    return tiers.find((tier) => tier.id === current) ?? tiers[0];
  }

  /**
   * 某个槽位现在能造哪些东西。**这是升级 UI 的唯一接口** —— 三种界面状态都能
   * 从返回值的长度推出来：
   *
   *   长度 2  阶 0，两条线的一阶同时可造 → 渲染分叉卡
   *   长度 1  已分叉未满级，只能升同线的下一阶 → 渲染升级卡
   *   长度 0  已满级 → 渲染属性总览
   *
   * **返回值不表达"还没解锁"** —— 那是 isEquipmentUnlocked() 的事。
   * 长度 0 已经被"已满级"占了，用空数组兼表未解锁会让开局显示满级卡。
   *
   * 换线不在这里 —— 它走 craftEquip(id) 直接指定另一条线的一阶。
   * **一阶换线全额退材料，二阶起才不返还**（见 craftEquip 里那段）。
   * 之所以是软锁而不是硬锁：单局最长 5 天，硬锁会让第一次玩的玩家在信息不足时
   * 做出不可逆的错误选择。真正的硬约束在材料池里 —— 双铁线要吃掉全图一半到
   * 四分之三的铁矿，你根本没有余量在同一局里再爬一遍另一条铁线。
   */
  getUpgradeOptions(slot: "weapon" | "armor"): EquipTier[] {
    const tiers = slot === "weapon" ? WEAPON_TIERS : ARMOR_TIERS;
    const current = this.getEquipped(slot);
    if (current.line === "none") return tiers.filter((tier) => tier.tier === 1);
    return tiers.filter((tier) => tier.line === current.line && tier.tier === current.tier + 1);
  }

  /**
   * 装备制作是否已解锁 —— 拿到过第一张兽皮或第一块铁矿之后为真。
   *
   * 四条一阶全都要兽皮或铁矿（sword 1皮+2木 / saber 3铁+1皮 / hide 4皮 / scale 2铁+2皮），
   * 而这两样开局都是 0、只能白天打猎或挖矿拿到。所以在此之前那两张分叉卡
   * **在逻辑上必然全部不可造** —— 不是"看着有点乱"，是可证明的死 UI。
   * 而它们顶着的是「选一条线，然后跟着它过四天」，全局最重的一句话，
   * 却出现在玩家还没挥过任何一把武器、背包 1/8 的时候。
   *
   * 第一分钟该做的事根本不在背包里（把枯木搬到火边按互动键），
   * 所以这里只是把装备树收起来，**不动搭树桩和烤肉** —— 尤其不能把搭树桩往前推：
   * 第一根枯木进树桩而不进火堆，当晚就没燃料了。
   *
   * 只置位不复位：造完装备材料花光了，树也不该再消失。
   */
  isEquipmentUnlocked(): boolean {
    return this.equipmentUnlocked;
  }

  /** 某条线的三阶终点。分叉卡用它告诉玩家"这条路通向哪"。 */
  getLineFinale(slot: "weapon" | "armor", line: EquipLine): EquipTier | null {
    const tiers = slot === "weapon" ? WEAPON_TIERS : ARMOR_TIERS;
    return tiers.find((tier) => tier.line === line && tier.tier === 3) ?? null;
  }

  /** 另一条线的一阶。已经在某条线上时用于渲染"改走另一条线"的入口。 */
  getSwitchOptions(slot: "weapon" | "armor"): EquipTier[] {
    const tiers = slot === "weapon" ? WEAPON_TIERS : ARMOR_TIERS;
    const current = this.getEquipped(slot);
    if (current.line === "none") return [];
    return tiers.filter((tier) => tier.tier === 1 && tier.line !== current.line);
  }

  /** 按 id 制作某件装备。UI 从 getUpgradeOptions / getSwitchOptions 里取 id。 */
  craftEquip(slot: "weapon" | "armor", id: string): boolean {
    const tiers = slot === "weapon" ? WEAPON_TIERS : ARMOR_TIERS;
    const next = tiers.find((tier) => tier.id === id);
    if (!next) return false;
    const allowed = [...this.getUpgradeOptions(slot), ...this.getSwitchOptions(slot)];
    if (!allowed.some((tier) => tier.id === id)) {
      this.events.push({ type: "message", key: "msg.15", params: { v0: loc(`equip.${next.id}.name`) } });
      return false;
    }
    /*
     * 一阶换线全额退材料，二阶起才真正锁定。
     *
     * 四条线的手感差得很远（剑单体连击 / 刀 220~280° 横扫 / 皮甲闪避加回复 /
     * 铁甲高防反伤减速），可玩家要在**挥过任何一把之前**，凭 line.*.personality
     * 那两行字做一个跟四天的不可逆选择。选错的人不会回头攒材料重来，他会关标签页。
     *
     * 退了材料之后，"跟着一条线走四天"的设定一点没松 —— 只是把承诺点从"选之前"
     * 挪到"用过之后"。真正的硬约束一直在材料池里（双铁线要吃掉全图一半以上的铁矿），
     * 那条没动。
     */
    const current = this.getEquipped(slot);
    const isTier1Sidegrade = current.tier === 1 && next.tier === 1 && next.line !== current.line;
    return this.craftUpgrade(next, (tier) => {
      if (slot === "weapon") {
        this.player.weapon = tier.id as WeaponKind;
        // 换了武器，上一把剑攒的连击层数不该跟着走。
        this.comboStacks = 0;
        this.comboTargetKey = null;
        this.events.push({ type: "combo", stacks: 0 });
        this.events.push({ type: "craft-weapon" });
      } else {
        this.player.armor = tier.id as ArmorKind;
        this.events.push({ type: "craft-coat" });
      }
    }, isTier1Sidegrade ? current.cost : []);
  }

  /**
   * @param refund 退还的材料（一阶换线时是被替换掉那件的造价，见 craftEquip）。
   *
   * 退款和造价先**轧差**再验价，而不是"先退再收" —— 否则想试第二条线就得攒两份材料，
   * "一阶随便换"就名存实亡了。轧完差先扣正项、后补负项：扣掉的那部分先腾出格子，
   * 补回来的东西才装得下。
   */
  private craftUpgrade(next: EquipTier, apply: (tier: EquipTier) => void, refund: EquipTier["cost"] = []): boolean {
    if (!this.running) return false;
    // 判定半径与取暖、烤肉统一走 FIRE_WARMTH_RADIUS：原先这里单独写死 5.2，
    // 于是"站在营地里就算烤着火"对升级装备这一条不成立。
    if (next.needsFire && !this.findNearestLitFire(FIRE_WARMTH_RADIUS)) {
      this.events.push({ type: "message", key: "msg.16", params: { v0: loc(`equip.${next.id}.name`) } });
      return false;
    }
    const net = new Map<InventoryItemKind, number>();
    for (const [kind, count] of next.cost) net.set(kind, (net.get(kind) ?? 0) + count);
    for (const [kind, count] of refund) net.set(kind, (net.get(kind) ?? 0) - count);

    const missing = [...net].filter(([kind, count]) => count > 0 && this.getInventoryCount(kind) < count);
    if (missing.length > 0) {
      const need = this.describeCost(next.cost);
      this.events.push({ type: "message", key: "msg.17", params: { v0: loc(`equip.${next.id}.name`), v1: need } });
      return false;
    }
    this.noteInPlaceAction();
    for (const [kind, count] of net) if (count > 0) this.removeInventory(kind, count);
    for (const [kind, count] of net) {
      // 背包塞不下退款时不静默吞掉 —— 和捡东西满包一样给一句提示。
      if (count < 0 && !this.addInventory(kind, -count)) this.events.push({ type: "message", key: "msg.3" });
    }
    apply(next);
    this.events.push({ type: "message", key: "msg.18", params: { v0: loc(`equip.${next.id}.name`), v1: loc(`equip.${next.id}.blurb`) } });
    return true;
  }

  /** 烤肉：生肉 1 份在燃烧的篝火旁烤成熟肉。这是篝火除了取暖之外的第二个用途。 */
  craftCookedMeat(): boolean {
    if (!this.running) return false;
    if (this.getInventoryCount("raw-meat") < 1) {
      this.events.push({ type: "message", key: "msg.19" });
      return false;
    }
    if (!this.findNearestLitFire(FIRE_WARMTH_RADIUS)) {
      this.events.push({ type: "message", key: "msg.20" });
      return false;
    }
    this.noteInPlaceAction();
    this.removeInventory("raw-meat", 1);
    if (!this.addInventory("cooked-meat", 1)) {
      // 生肉必须放回去 —— 刚腾出来的位置一定装得下，否则这一步等于凭空烧掉一块肉。
      this.addInventory("raw-meat", 1);
      this.events.push({ type: "message", key: "msg.21" });
      return false;
    }
    this.events.push({ type: "cook" });
    this.events.push({ type: "message", key: "msg.22" });
    return true;
  }

  /**
   * 建造。放在**玩家正前方两米**，不做自由光标预览 —— 移动端没有鼠标，
   * "走到你想建的位置再按"本身就是位置选择，而且和其余交互是同一套语汇。
   * 放不下时明说原因，不能只是没反应。
   */
  build(kind: StructureKind): boolean {
    if (!this.running) return false;
    const spec = STRUCTURE_SPECS[kind];
    const missing = spec.cost.filter(([item, count]) => this.getInventoryCount(item) < count);
    if (missing.length > 0) {
      const need = this.describeCost(spec.cost);
      this.events.push({ type: "message", key: "msg.23", params: { v0: loc(`structure.${kind}.name`), v1: need } });
      return false;
    }
    const spot = {
      x: this.player.x + this.player.facing.x * 2.0,
      z: this.player.z + this.player.facing.z * 2.0,
    };
    const reason = this.getBuildBlocker(kind, spot);
    if (reason) {
      this.events.push({ type: "message", key: "msg.24", params: { v0: loc(`structure.${kind}.name`), v1: reason } });
      return false;
    }
    if (!this.spendStamina(spec.stamina, `structure.${kind}.build`)) return false;

    this.noteInPlaceAction();
    for (const [item, count] of spec.cost) this.removeInventory(item, count);
    this.structures.push({
      id: this.structureId++,
      kind,
      x: spot.x,
      z: spot.z,
      hp: spec.maxHp,
      maxHp: spec.maxHp,
      rotation: Math.atan2(this.player.facing.z, this.player.facing.x),
      active: true,
    });
    this.events.push({ type: "build", kind });
    this.events.push({ type: "message", key: "msg.25", params: { v0: loc(`structure.${kind}.name`), v1: loc(`structure.${kind}.blurb`) } });
    return true;
  }

  /** 放不下的原因；能放返回 null。 */
  private getBuildBlocker(kind: StructureKind, spot: Vec2): LocalizedText | null {
    if (!isTerrainWalkable(this.world, spot)) return loc("sim.4");
    const spec = STRUCTURE_SPECS[kind];
    for (const other of this.structures) {
      if (!other.active) continue;
      const gap = spec.radius + STRUCTURE_SPECS[other.kind].radius + 0.4;
      if (distanceSquared(spot, other) < gap * gap) return loc("sim.5", { v0: loc(`structure.${other.kind}.name`) });
    }
    for (const wall of this.world.walls) {
      if (distanceSquared(spot, wall) < (wall.radius + spec.radius) ** 2) return loc("sim.6");
    }
    return null;
  }

  getInventoryCount(kind: InventoryItemKind): number {
    return this.player.inventory.reduce((total, stack) => total + (stack?.kind === kind ? stack.count : 0), 0);
  }

  /**
   * 攻击距离内有没有能打的东西（活猎物或活狗）。
   *
   * 给 HUD 的"攻击键搏动"用：这颗键**从来没有上下文反馈** —— 行动键走近可交互物
   * 会换图标、还会冒出提示文字，攻击键则不管眼前有没有东西都长一个样。
   * 触屏玩家面对的是四颗没有键名的圆键（key-hint 角标只在 pointer: fine 显示），
   * 于是"哪颗是攻击"只能靠试。
   *
   * 判据用**距离**不用扇形：扇形要求玩家已经对准，而这条提示的意义正是
   * 告诉还没上手的人"现在按这颗有用"。扛着桶时打不了架，那时不提示。
   */
  hasAttackTargetInRange(): boolean {
    if (this.player.carrying) return false;
    const range = WEAPON_STATS[this.player.weapon].range;
    const rangeSq = range * range;
    return this.wolves.some((wolf) => wolf.mode !== "dead" && distanceSquared(this.player, wolf) <= rangeSq)
      || this.critters.some((critter) => critter.mode !== "dead" && distanceSquared(this.player, critter) <= rangeSq);
  }

  getInteractionHint(): InteractionHint {
    if (this.departTimer > 0) return { action: "none", text: loc("hint.none") };
    // 与 requestInteraction 保持一致：水分告急时，仙人掌优先、其次找井。
    if (this.player.water < WATER_URGENT && !this.player.carrying) {
      if (this.findNearestCactus(2.7)) return { action: "cactus", text: loc("hint.urgentCactus", { cost: STAMINA_COST_CACTUS }) };
      const urgentWell = this.findNearestWell(WELL_REACH);
      if (urgentWell) return { action: "well", text: loc("hint.urgentWell", { cost: STAMINA_COST_DRAW }) };
    }
    if (this.player.carrying === "fuel") {
      return distance(this.player, this.truck) <= TRUCK_LOAD_REACH
        ? { action: "load", text: loc("hint.loadFuel", { loaded: this.truck.loaded, required: FUEL_REQUIRED }) }
        : { action: "drop", text: loc("hint.dropFuel") };
    }
    if (this.player.carrying === "beast") {
      return { action: "drop", text: loc("hint.dropBeast") };
    }
    if (this.player.carrying) {
      return this.player.carrying === "stake"
        ? { action: "drop", text: loc("hint.dropStake") }
        : { action: "drop", text: loc("hint.dropStone") };
    }
    if (this.truck.loaded >= FUEL_REQUIRED && distance(this.player, this.truck) <= TRUCK_BOARD_REACH) {
      return { action: "board", text: loc("hint.board") };
    }
    // 和 requestInteraction 同序：发车之后、拾取之前。
    if (this.findGrabbableWolf()) return { action: "grab", text: loc("hint.grabWolf") };
    if (this.canUseTruckHorn()) return { action: "horn", text: loc("hint.horn") };
    // 与 requestInteraction 同一套优先级：火塘只在比脚边的东西更近时才占住 E。
    if (this.getInventoryCount("wood") > 0) {
      const hearth = this.findNearestHearth(FIRE_WARMTH_RADIUS);
      if (hearth && !this.hasNearerTarget(hearth.distance)) {
        return {
          action: this.camps[hearth.campId].fuel > 0 ? "feed" : "ignite",
          text: loc("hint.feed", { left: this.getInventoryCount("wood") }),
        };
      }
    }
    if (this.findNearestBarrel(FUEL_PICKUP_REACH)) {
      return { action: "pickup", text: loc("hint.liftFuel", { loaded: this.truck.loaded, required: FUEL_REQUIRED }) };
    }
    const item = this.findNearestItem(ITEM_PICKUP_REACH);
    if (item) {
      return item.kind === "wood"
        ? { action: "pickup", text: loc("hint.takeWood", { cost: STAMINA_COST_WOOD }) }
        : { action: "pickup", text: loc("hint.liftStone") };
    }
    const structure = this.findNearestStructure(2.7);
    if (structure) return { action: "pickup", text: loc("hint.liftStake") };
    if (this.findNearestCactus(2.7)) return { action: "cactus", text: loc("hint.cactus", { cost: STAMINA_COST_CACTUS }) };
    if (this.findNearestIron(2.8)) return { action: "mine", text: loc("hint.mine", { cost: STAMINA_COST_MINE }) };
    if (this.findNearestTree(TREE_REACH)) {
      return { action: "chop", text: loc("hint.chop", { cost: STAMINA_COST_CHOP }) };
    }
    const well = this.findNearestWell(WELL_REACH);
    if (well) return { action: "well", text: loc("hint.well", { cost: STAMINA_COST_DRAW, left: well.charges }) };
    return { action: "none", text: loc("hint.none") };
  }

  drainEvents(): GameEvent[] {
    return this.events.splice(0, this.events.length);
  }

  getPhaseDuration(): number {
    if (this.phase === "day") return this.day === 1 ? FIRST_DAY_DURATION : LATER_DAY_DURATION;
    if (this.day === 1) return FIRST_NIGHT_DURATION;
    if (this.day === 2) return SECOND_NIGHT_DURATION;
    return LATER_NIGHT_DURATION;
  }

  getDaylight(): number {
    const duration = this.getPhaseDuration();
    const elapsedInPhase = duration - this.phaseTime;
    const fade = 10;
    if (this.phase === "day") {
      if (this.day === 1) return Math.min(1, this.phaseTime / fade);
      return Math.min(1, this.phaseTime / fade, elapsedInPhase / fade);
    }
    return 1 - Math.min(1, this.phaseTime / fade);
  }

  /**
   * 燃着的热源里最近的一个。
   * 取暖、烤肉、二阶以上装备合成全部走这一个查询，半径统一为 FIRE_WARMTH_RADIUS ——
   * 只要"待在营地里"就算烤着火，营地事务不必再挤在火堆脚下办。
   */
  findNearestLitFire(maxDistance: number): { x: number; z: number; fuel: number } | null {
    let best: { x: number; z: number; fuel: number } | null = null;
    let bestDistance = maxDistance * maxDistance;
    for (const camp of this.world.camps) {
      const fuel = this.camps[camp.id].fuel;
      if (fuel <= 0) continue;
      const value = distanceSquared(this.player, camp);
      if (value >= bestDistance) continue;
      best = { x: camp.x, z: camp.z, fuel };
      bestDistance = value;
    }
    return best;
  }

  /**
   * 此刻还燃着的火源，给狼群做排斥用（见 WolfDirector 的 FIRE_FEAR_RADIUS）。
   *
   * 每帧每只狼都会问一次，所以数组是**复用**的：清空再填，不新建。
   * 夜里三十只狗 × 60 帧 = 每秒一千八百次调用，这里 new 一个数组就是每秒一千八百个垃圾。
   */
  getLitFires(): ReadonlyArray<Vec2> {
    this.litFireScratch.length = 0;
    for (const camp of this.world.camps) {
      if (this.camps[camp.id].fuel <= 0) continue;
      this.litFireScratch.push(camp);
    }
    return this.litFireScratch;
  }

  /**
   * 玩家此刻是否正被篝火烤着。
   *
   * 火焰半径（10 米）几乎盖住整座营地，肉眼**看不出**自己在不在圈里 ——
   * 而"在不在圈里"决定夜里体温是 +2.11/s 还是 −1.05/s，是夜间最重要的一条状态。
   * 渲染层拿它画脚下的暖环，第一夜教学拿它判定"学会烤火了"，两处同一个判据。
   */
  isWarmedByFire(): boolean {
    return this.findNearestLitFire(FIRE_WARMTH_RADIUS) !== null;
  }

  /**
   * 最近的**火塘**，不论燃着没燃 —— 添柴要能重新点燃已经烧空的营火，
   * 所以这里不能复用只找"燃着的火"的 findNearestLitFire。
   */
  private findNearestHearth(maxDistance: number): { campId: number; distance: number } | null {
    let best: { campId: number; distance: number } | null = null;
    let bestDistance = maxDistance * maxDistance;
    for (const camp of this.world.camps) {
      const value = distanceSquared(this.player, camp);
      if (value >= bestDistance) continue;
      best = { campId: camp.id, distance: Math.sqrt(value) };
      bestDistance = value;
    }
    return best;
  }

  getNearestLitCamp(): { camp: CampDefinition; fuel: number; distance: number } | null {
    let closest: { camp: CampDefinition; fuel: number; distance: number } | null = null;
    for (const camp of this.world.camps) {
      const fuel = this.camps[camp.id].fuel;
      if (fuel <= 0) continue;
      const campDistance = distance(this.player, camp);
      if (!closest || campDistance < closest.distance) closest = { camp, fuel, distance: campDistance };
    }
    return closest;
  }

  getCurrentLocationLabel(): LocalizedText {
    const camp = this.findNearestCamp(14);
    return loc(camp ? `camp.${camp.kind}` : "camp.unnamed");
  }

  // getNearestThreat() 已删除：它服务的是那块常驻在屏幕中央的"最近敌人"面板。
  // 夜里地图上几十只狼，24 米内永远有一只顶上来，那块面板等于常年糊在视野正中。
  // 狼的血量统一走头顶跟随血条（受伤才亮 2.6 秒），不再有唯一 BOSS 血条。

  /**
   * 通关进度：车里几桶、还差几桶、手上有没有扛着一桶，以及最近一桶还没捡的油在哪。
   *
   * `nearest` 存在的理由：全图九桶散在 220×220 上，而我们**没有小地图**
   * （矮屏上它本来就 display:none）。不给方位的话，"猥琐找油"这条路线
   * 会退化成地毯式搜索。给一个粗方位 + 距离，它才是"规划一趟出门"。
   */
  getFuelProgress(): {
    loaded: number;
    required: number;
    carrying: boolean;
    truckDistance: number;
    nearest: { distance: number; bearing: number; guarded: boolean } | null;
  } {
    let nearest: { distance: number; bearing: number; guarded: boolean } | null = null;
    if (!this.projectileCombat.hasCarriedBarrel) {
      for (const barrel of this.barrels) {
        if (barrel.placement !== "ground") continue;
        const value = distance(this.player, barrel);
        if (nearest && value >= nearest.distance) continue;
        nearest = {
          distance: value,
          bearing: screenBearing(this.player, barrel),
          // 「有没有狗看着」按**现场还活着的守卫**算，不是按出生时的标记 ——
          // 打完之后这条提示要自己变干净，否则玩家不知道自己已经把路打开了。
          guarded: this.wolves.some((wolf) => wolf.role === "guard" && wolf.mode !== "dead"
            && distanceSquared(wolf, barrel) < 14 * 14),
        };
      }
    }
    return {
      loaded: this.truck.loaded,
      required: FUEL_REQUIRED,
      carrying: this.projectileCombat.hasCarriedBarrel,
      truckDistance: distance(this.player, this.truck),
      nearest,
    };
  }

  /** 把 {@link screenBearing} 的角度换成八个方位之一：0 = 正上方 = 北，顺时针数。 */
  private bearingKey(bearing: number): string {
    const sector = Math.round(((bearing % TAU) + TAU) % TAU / (TAU / 8)) % 8;
    return ["compass.n", "compass.ne", "compass.e", "compass.se",
      "compass.s", "compass.sw", "compass.w", "compass.nw"][sector];
  }

  /**
   * 点击地面移动：给出这一帧该往哪走。
   *
   * 直线冲是不行的 —— 实测 400 次随机点击，**只有 43% 能走到**，70 米以上只有 37%，
   * 剩下的全部顶在山脊或崖壁上原地推，而 moveTarget 只在走到 0.65 米内才清除，
   * 于是玩家一直卡着直到自己接管。桌面端最常用的就是点地图走。
   *
   * 但**只走流场也不行**，而且坏得更难看：流场每次只答"下一格的格心在哪"，
   * 格子 1.5 米、BFS 又是八邻域等权的，于是空旷地面上首步方向的中位偏差有 31°、
   * 七成的点击超过 20°（探针实测）。玩家点屏幕偏下的一点，角色先朝上走两步再拐回来 ——
   * 明明一马平川，路却是折的。
   *
   * 所以是两条腿：
   *
   *   直线走得通（且在 STRAIGHT_WALK_MAX 内） →  直着走，偏差 0°
   *   走不通                                  →  交给流场，它认得绕路
   *
   * 关键是那句"走得通"必须**验到终点**（canWalkStraight 逐段验坡度、爬升与碰撞），
   * 不能只验前面十几米。验一段就走的写法试过，是错的：前 14 米一马平川、
   * 终点却在山那边，人会照直走进山脚的死胡同，再被流场捞回来，来回拉锯 ——
   * 到达率从 94% 掉到 82%。验到终点则是"验过就一定走得完"，
   * 实测到达率反而升到 96%，而首步中位偏差降到 0°。
   */
  directionToClickTarget(target: Vec2): Vec2 | null {
    if (distance(this.player, target) < 0.65) return null;
    if (!this.clickRoute) this.clickRoute = new NavigationGrid(this.world);
    if (!this.clickTarget || distanceSquared(this.clickTarget, target) > 0.6 * 0.6) {
      this.clickTarget = { x: target.x, z: target.z };
      this.clickRoute.rebuild(target, getFlowFieldObstacles(this));
    }
    if (distance(this.player, target) < STRAIGHT_WALK_MAX && this.canWalkStraight(this.player, target)) {
      return direction(this.player, target);
    }
    return this.clickRoute.directionFrom(this.player);
  }

  /**
   * 从 a 直着走到 b，这一路踏得住吗。
   *
   * 判据和真正走路的那条链**同源**：逐段 canTraverseTerrain（坡度与爬升）+
   * stepCrossesCollision（墙、石头、树桩）。
   *
   * 采样步长 0.35 米这个数是**试出来的，不能放宽**：canTraverseTerrain 判的是
   * rise/travel，而 travel 就是采样间距。间距取 1.1 米时，一道 0.5 米高的坎读出来
   * 只有 0.45 的爬升比（合格），玩家实际每帧只走 0.14 米、同一道坎读出来是 3.5（拒绝）——
   * 于是这个函数会对一条走不通的直线说"通"，人一头顶上去再也不回流场。
   * 实测到达率因此从 94% 掉到 85%。间距压到与真实步长同量级才不会说谎。
   */
  private canWalkStraight(from: Vec2, to: Vec2): boolean {
    const span = distance(from, to);
    if (span < 0.0001) return true;
    const steps = Math.max(1, Math.ceil(span / 0.35));
    let previous = from;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const point = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
      if (!isTerrainWalkable(this.world, point)) return false;
      /*
       * **分轴走，就要分轴问。**
       *
       * moveEntity 是 stepAxis 先走 x 再走 z 的，所以真实轨迹是一串小折线，
       * 不是这条弦。照弦去问 canTraverseTerrain 会在墙角和坡肩上答错 ——
       * 弦本身畅通，而拆成 x、z 两段之后其中一段撞角。那正是 canStepToward
       * 头注释里点名的坑（它选择"任一轴通就算通"，因为它问的是"迈不迈得动"；
       * 这里问的是"整条路走不走得完"，所以要反过来，两轴都得通）。
       */
      const corner = { x: point.x, z: previous.z };
      if (!canTraverseTerrain(this, previous, corner) || !canTraverseTerrain(this, corner, point)) return false;
      if (stepCrossesCollision(this, previous, corner, PLAYER_RADIUS, true)) return false;
      if (stepCrossesCollision(this, corner, point, PLAYER_RADIUS, true)) return false;
      previous = point;
    }
    return true;
  }

  /** 剑线连击的当前层数与上限，供 HUD 在攻击按钮上画进度弧。 */
  getComboState(): { stacks: number; max: number } {
    return { stacks: this.comboStacks, max: WEAPON_STATS[this.player.weapon].comboMax };
  }

  getObjective(): LocalizedText {
    if (this.departTimer > 0) return loc("sim.departing");
    /*
     * 开场第一句必须说清**为什么活着**，不是"先干个家务"。
     *
     * 原来写的是"移动或拿起枯木，开始第一天" —— 那是流程说明。而卡车（通关条件）
     * 就在出生点 34 米外、一抬头就看得见，玩家却完全不知道它是出路。
     * Poki 那批会话中位数只有 52 秒，绝大多数人从头到尾没被告知过目标是什么。
     * 现在第一句直接给：加满几桶、车在哪个方位、多远。
     */
    if (!this.clockStarted) {
      const opening = this.getFuelProgress();
      return loc("sim.7", {
        required: opening.required,
        metres: Math.round(opening.truckDistance),
        bearing: loc(this.bearingKey(screenBearing(this.player, this.truck))),
      });
    }

    // 致命轴优先：水分和饥饿归零是立即死亡，必须压过其它所有提示。
    if (this.player.water < 18) return loc("sim.9");
    if (this.player.hunger < 18) return loc("sim.10");
    // 其次是瘫痪状态。
    if (this.player.condition === "hypothermia") return loc("sim.11");
    if (this.player.condition === "heatstroke") return loc("sim.12");

    if (this.player.resting) return loc("sim.13");
    // 扛着桶的时候只说一件事：车在哪。扛桶期间打不了架、跑不快，
    // 别的提示这时全是噪音 —— 而且手上占着东西，E 只能放下或装车。
    const fuel = this.getFuelProgress();
    if (fuel.carrying) {
      return loc("sim.fuelCarrying", {
        metres: Math.round(fuel.truckDistance),
        bearing: loc(this.bearingKey(screenBearing(this.player, this.truck))),
      });
    }
    /*
     * 第一桶：**第一个白天里，目标行只说通关目标这一件事。**
     *
     * 平台数据（1.0.14，n=500）最高的一根柱子在 1~2 分钟，而录像显示大部分人
     * **没死就走了**。也就是说卡住他们的不是难度，是"这游戏要我干嘛"从头到尾没有答案：
     * 玩家一迈步，目标行就从「加满 6 桶油，开着卡车离开」跳成「走到篝火旁添柴」
     * （因为开局口粮里就有一根柴，下面那条 sim.14 恒真），t=26s 再跳成「用大石封门」。
     * 整个第一昼夜 190 秒里，通关进度一格都不动 —— 而囤柴封门这笔投资是为第 2 天付的，
     * 大部分人没有第 2 天。
     *
     * 所以这条排在捡柴生火链**之前**：出生点 8.5 米就有一桶（createWorld 末尾的教学桶），
     * 扛到 7.7 米外的车上，「汽油 1/6」当场跳格。第一桶进车之后这条自己消失，
     * 后面那条链原样接上，一个字没删。
     *
     * 三道闸：只在第 1 天、只在白天、只在还没装过任何一桶之前。
     * `phaseTime > 14` 是把最后 14 秒让给 sim.23 的入夜警告 ——
     * 8.5 米的桶如果 26 秒还没搬动，这条提示已经不起作用了，而天要黑是真的更急。
     */
    if (this.day === 1 && this.phase === "day" && this.phaseTime > 14
      && this.truck.loaded === 0 && fuel.nearest) {
      return loc("sim.fuelFirst", {
        required: fuel.required,
        metres: Math.round(fuel.nearest.distance),
        bearing: loc(this.bearingKey(fuel.nearest.bearing)),
      });
    }

    // 枯木现在进背包，所以指引从"往哪搬"变成"够不够、去哪烧"。
    // 同样要让过 requestInteraction 的优先级：手上占着东西、或者脚边有东西可捡时，
    // E 都不会去添柴，这里就不能喊"按互动键添柴"。
    if (this.getInventoryCount("wood") > 0 && !this.player.carrying) {
      const hearth = this.findNearestHearth(FIRE_WARMTH_RADIUS);
      if (hearth && !this.hasNearerTarget(hearth.distance)) return loc("sim.14");
    }
    if (fuel.loaded >= fuel.required) return loc("sim.fuelReady", { metres: Math.round(fuel.truckDistance) });

    if (this.phase === "night") {
      if (this.player.warmth < 30) return loc("sim.17");
      const lit = this.getNearestLitCamp();
      if (!lit) return loc("sim.18");
      if (lit.fuel < 25) return loc("sim.19", { v0: Math.round(lit.fuel) });
      if (this.day === 1 && this.phaseTime > 60) return loc("sim.20");
      // 夜里不指路去搬油 —— 巢口就在那三桶旁边，夜袭犬正从那里往外涌。
      return loc("sim.nightHold", { loaded: fuel.loaded, required: fuel.required });
    }

    if (this.phase === "day" && this.day === 1 && this.phaseTime <= 14) return loc("sim.23");
    if (this.player.warmth > 78) return loc("sim.24");
    if (this.objectiveStage === 0) return loc("sim.26", { v0: STAMINA_COST_WOOD });
    if (this.objectiveStage === 1) return loc("sim.27");
    if (this.objectiveStage === 2) return loc("sim.28");
    if (this.getInventoryCount("water") === 0 && this.getInventoryCount("cactus-juice") === 0) return loc("sim.29");
    //
    // 下面这一段的顺序改过一次，值得记一笔。
    //
    // 通关目标（去搬油）原先排在**所有**装备提示之后，而那些提示的条件宽到几乎常真：
    // "没穿甲 + 地图上有野狗" 在前三天里一直成立。实测跑到第 2 天白天，目标行说的是
    // "沙海上有 5 只野狗 · 兽皮只从野狗和长角羚身上来" —— 玩家**从头到尾看不到自己在为什么活着**。
    //
    // 现在只有"现在就能做完的一步"能排在通关目标前面：手上已经有皮了（走两步就能穿上）、
    // 或者卡在三阶的最后一样材料上。其余的提示要么收紧到"真的还没入门"，要么删掉。
    if (this.getEquipped("armor").line === "none" && this.getInventoryCount("hide") > 0) return loc("sim.30");
    // 三阶卡在狼牙上，而狼牙只有白天的大狼掉 —— 这条线索不给的话玩家找不到。
    if (this.getEquipped("weapon").tier === 2 && this.getInventoryCount("wolf-fang") < 3) {
      return loc("sim.32", { v0: this.getInventoryCount("wolf-fang") });
    }
    // 「沙海上有 N 只野狗 · 兽皮只从野狗和长角羚身上来」这一条删掉了。
    // 它的触发条件是"没穿甲 + 地图上有野狗"，前两三天一直成立，等于常年占着目标行；
    // 而它说的事已经有三个地方在说：开场卡的玩法三条、拿到第一张皮后的 sim.30、
    // 以及通关目标里"最近一桶有大狼守着"那半句。
    // 体力是恒定流失的轴，而烤肉是唯一的大额补给。身上有生肉却在掉血时，
    // 目标行直接把这条路指出来 —— 比等玩家自己翻背包发现要快得多。
    if (this.player.health < 62 && this.getInventoryCount("cooked-meat") === 0
      && this.getInventoryCount("raw-meat") > 0) {
      const lit = this.getNearestLitCamp();
      return lit
        ? loc("sim.cookNearby", { metres: Math.round(lit.distance), health: COOKED_HEALTH })
        : loc("sim.cookAnywhere");
    }
    // "缺肉"这条只在真的开始饿的时候压过通关目标。肚子还有一半就喊缺肉，
    // 会把整个白天都占成采集提示，玩家永远看不到自己到底在为什么活着。
    if (this.player.hunger < 50
      && this.getInventoryCount("raw-meat") === 0 && this.getInventoryCount("cooked-meat") === 0) {
      const oryx = this.critters.find((critter) => critter.kind === "oryx" && critter.mode !== "dead");
      if (oryx) return loc("sim.33", {
        meat: CRITTER_SPECS.oryx.meat,
        water: CRITTER_SPECS.oryx.water,
      });
      return loc("sim.34");
    }
    return this.describeFuelHunt(fuel);
  }

  /** 白天的常驻目标：还差几桶、最近一桶在哪个方向多远。 */
  private describeFuelHunt(fuel: ReturnType<GameSimulation["getFuelProgress"]>): LocalizedText {
    if (!fuel.nearest) return loc("sim.fuelNone", { loaded: fuel.loaded, required: fuel.required });
    // 最近的一桶往往就是巢边那三桶（离起点营地 41 米，比任何野外桶都近）。
    // 只报距离等于把拿着匕首的第 2 天玩家一头指进五只大狼里 —— 得说清那儿有狗看着，
    // 打还是绕才是玩家自己的选择。
    return loc(fuel.nearest.guarded ? "sim.fuelHuntGuarded" : "sim.fuelHunt", {
      left: fuel.required - fuel.loaded,
      metres: Math.round(fuel.nearest.distance),
      bearing: loc(this.bearingKey(fuel.nearest.bearing)),
    });
  }

  private updatePlayerMovement(delta: number, rawMovement: Vec2, isMoving: boolean): void {
    if (!isMoving) return;
    this.noteActivity();
    const movement = normalize(rawMovement);
    this.player.facing = movement;
    const carryingPenalty = this.player.carrying ? 0.54 : 1;
    const needsPenalty = this.player.hunger < 12 || this.player.water < 12 ? 0.84 : 1;
    // 武器与护甲的移速系数相乘。全重装（砍刀Ⅲ + 铁甲Ⅲ）是 0.92 × 0.88 = 0.810
    // → 6.64，全轻装是 1.06 × 1.09 = 1.155 → 9.47，差 43%。
    // 守油大狼发现玩家后会短程冲刺；全重装不能再无伤拉着它们绕地形，
    // 轻装仍能靠机动脱离，装备选择因此有明确取舍。
    const gearScale = WEAPON_STATS[this.player.weapon].moveScale * ARMOR_STATS[this.player.armor].moveScale;
    const speed = 8.2 * carryingPenalty * needsPenalty * gearScale * this.getConditionSpeedScale();
    moveEntity(this, this.player, movement.x * speed * delta, movement.z * speed * delta, PLAYER_RADIUS, true);
  }

  private updateNeeds(delta: number): void {
    // --- 代谢：水分与饥饿独立衰减，任一归零立即死亡 ---
    this.player.water = clamp(this.player.water - delta * WATER_DECAY * this.tuning.waterDecay, 0, 100);
    this.player.hunger = clamp(this.player.hunger - delta * HUNGER_DECAY * this.tuning.hungerDecay, 0, 100);

    // --- 体力恒定流失：把"吃饭"从可拖延的提示变成硬心跳（基准 -0.7/600HP）---
    this.player.health -= delta * HEALTH_DECAY * this.tuning.healthDecay;
    // updateNeeds 先于狼 AI。若同一帧随后被狼咬，damagePlayer 会把来源覆盖成 killed；
    // 没被咬则保留 exhausted，正好对应真正补掉最后一点体力的来源。
    this.healthDamageCause = "exhausted";
    this.healthDamageAttacker = null;
    /*
     * 吃饱喝足时把流失抵掉（净 +0.06/s，回不了血）—— 见 HEALTH_PASSIVE_REGEN。
     *
     * `health > 0` 这道闸是后加的，它挡的是一条很窄但真实存在的缝：
     * 这段回复跑在 update 末尾的死亡判定**之前**，所以血正好落在 0 的那一帧
     * 会被抬到 +0.018，`health <= 0` 于是不成立，玩家顶着 0 血继续玩。
     *
     * 实战里够不着（狼一口 18~20，血只会越过 0 掉到负数），但"回复能把人从
     * 死亡线上拽回来"本身就是错的顺序 —— 一旦以后有小额伤害（毒、灼烧、
     * 每秒掉 1 点那类），这条缝会立刻变成"永远死不了"。
     * 同样的闸也加在下面休息回复那条上。
     */
    if (this.player.health > 0
      && this.player.hunger > HEALTH_PASSIVE_NEED && this.player.water > HEALTH_PASSIVE_NEED) {
      this.player.health = Math.min(this.player.health + delta * HEALTH_PASSIVE_REGEN, this.player.maxHealth);
    }

    // --- 劳力回复：休息最快，静止其次，移动最慢 ---
    // 护甲整体缩放这三档：皮甲把防御换成产出（×1.35 时一个白天多回 99 点劳力
    // ≈ 6.6 次挖矿）；铁甲保持基础回复速度，不再额外扣减。
    const staminaRegen = (this.player.resting
      ? STAMINA_REST_REGEN
      : this.player.idleTime > 0.4
        ? STAMINA_IDLE_REGEN
        : STAMINA_ACTIVE_REGEN)
      * ARMOR_STATS[this.player.armor].staminaScale
      * this.tuning.staminaRegen;
    this.player.stamina = clamp(this.player.stamina + delta * staminaRegen, 0, this.player.maxStamina);

    // --- 连击窗口：手停下来层数就掉 ---
    if (this.comboTimer > 0) {
      this.comboTimer = Math.max(0, this.comboTimer - delta);
      if (this.comboTimer === 0 && this.comboStacks > 0) {
        this.comboStacks = 0;
        this.comboTargetKey = null;
        this.events.push({ type: "combo", stacks: 0 });
      }
    }

    // === 体温 ===
    // 两个独立分量相加：昼/夜基线，加上贴着篝火时的火焰增益。
    //
    //   白天无火 = +0.69/s      白天贴火 = +3.85/s
    //   夜晚无火 = −1.05/s      夜晚贴火 = +2.11/s
    //
    // **没有"劳作产热"这一项** —— 它曾经存在（+0.9/s），但那是白天基线的 2.7 倍，
    // 直接导致"正常采集必然中暑且无法自救"，已在 WARMTH_FIRE_GAIN 上方那条注释里
    // 说明为何移除。所以移动、采集、休息都**完全不影响体温**，玩家能动的只有
    // 三件事：喝水降温、贴火升温、以及就地调节（requestThermalAction）。
    //
    // 白天一定会热：地板 15 按 +0.69/s 爬到中暑线 100 要 123 秒，而白天有 180 秒。
    // 所以"白天必须喝水"不是建议，是硬性节奏。
    const nearFire = this.findNearestLitFire(FIRE_WARMTH_RADIUS) !== null;
    let warmthDelta = 0;
    if (nearFire) warmthDelta += WARMTH_FIRE_GAIN;
    if (this.phase === "day") warmthDelta += WARMTH_DAY_BASE * this.tuning.thermalPressure;
    else warmthDelta -= WARMTH_NIGHT_LOSS * this.tuning.thermalPressure;
    let warmth = this.player.warmth + delta * warmthDelta;

    // 昼夜反向夹逼：白天有地板、夜晚有天花板。
    // 结果是中暑只可能发生在白天、失温只可能发生在夜晚，两者的反制手段完全不同
    // （白天靠喝水降温，夜晚靠篝火回温）。这是本作节奏的骨架。
    if (this.phase === "day") warmth = Math.max(warmth, WARMTH_DAY_FLOOR);
    else warmth = Math.min(warmth, WARMTH_NIGHT_CEILING);
    this.player.warmth = clamp(warmth, WARMTH_MIN, WARMTH_MAX);

    this.updateCondition();
  }

  /**
   * 体温调节：一个按键，方向由当前体温决定 —— 偏热就降温、偏冷就升温。
   * 两个方向各自独立冷却，都不消耗任何资源。
   * 舒适区内不给按，免得白白空转冷却。
   */
  requestThermalAction(): void {
    if (!this.running) return;
    const warmth = this.player.warmth;
    if (warmth > THERMAL_COMFORT_HIGH) {
      if (this.coolCooldown > 0) {
        this.events.push({ type: "message", key: "msg.31", params: { v0: Math.ceil(this.coolCooldown) } });
        return;
      }
      this.noteActivity();
      this.coolCooldown = COOL_ACTION_COOLDOWN;
      this.player.warmth = clamp(warmth - COOL_ACTION_WARMTH, WARMTH_MIN, WARMTH_MAX);
      this.updateCondition();
      this.events.push({ type: "thermal", direction: "cool" });
      this.events.push({ type: "message", key: "msg.32", params: { v0: COOL_ACTION_WARMTH } });
      return;
    }
    if (warmth < THERMAL_COMFORT_LOW) {
      if (this.warmCooldown > 0) {
        this.events.push({ type: "message", key: "msg.33", params: { v0: Math.ceil(this.warmCooldown) } });
        return;
      }
      this.noteActivity();
      this.warmCooldown = WARM_ACTION_COOLDOWN;
      this.player.warmth = clamp(warmth + WARM_ACTION_WARMTH, WARMTH_MIN, WARMTH_MAX);
      this.updateCondition();
      this.events.push({ type: "thermal", direction: "warm" });
      this.events.push({ type: "message", key: "msg.34", params: { v0: WARM_ACTION_WARMTH } });
      return;
    }
    this.events.push({ type: "message", key: "msg.35" });
  }

  /** 体温越界的进入/解除带迟滞，避免在阈值上反复横跳。 */
  private updateCondition(): void {
    const warmth = this.player.warmth;
    let next: SurvivalCondition = this.player.condition;
    if (next === "heatstroke") {
      if (warmth <= WARMTH_HEAT_EXIT) next = "normal";
    } else if (next === "hypothermia") {
      if (warmth >= WARMTH_COLD_EXIT) next = "normal";
    } else if (warmth >= WARMTH_HEAT_ENTER) {
      next = "heatstroke";
    } else if (warmth <= WARMTH_COLD_ENTER) {
      next = "hypothermia";
    }
    if (next === this.player.condition) return;
    this.player.condition = next;
    this.events.push({ type: "condition", condition: next });
    if (next === "heatstroke") this.events.push({ type: "message", key: "msg.36" });
    else if (next === "hypothermia") this.events.push({ type: "message", key: "msg.37" });
    else this.events.push({ type: "message", key: "msg.38" });
  }

  /**
   * 实际攻击力 = 当前武器的绝对攻击 + 随身枯木加成（每根 +2，最多两根）。
   * 两项都是每次现算：武器可以换、枯木会烧掉，任何一边缓存都会算错。
   */
  getAttackPower(): number {
    const logs = Math.min(this.getInventoryCount("wood"), WOOD_ATTACK_CAP);
    return (this.getWeaponTier().attack ?? 0) + logs * WOOD_ATTACK_BONUS;
  }

  /** 防御力完全由当前护甲决定，没有其它来源。 */
  getDefense(): number {
    return this.getArmorTier().defense ?? 0;
  }

  private getWeaponTier(): EquipTier {
    return WEAPON_TIERS.find((tier) => tier.id === this.player.weapon) ?? WEAPON_TIERS[0];
  }

  private getArmorTier(): EquipTier {
    return ARMOR_TIERS.find((tier) => tier.id === this.player.armor) ?? ARMOR_TIERS[0];
  }

  /** 中暑 -60% 移速，失温 -75% 移速。（基准是 -85% / -99%，浏览器手感下放宽） */
  private getConditionSpeedScale(): number {
    if (this.player.condition === "heatstroke") return 0.4;
    if (this.player.condition === "hypothermia") return 0.25;
    return 1;
  }

  /** 中暑 -50% 攻速，失温 -65% 攻速，表现为攻击冷却被拉长。 */
  private getConditionCooldownScale(): number {
    if (this.player.condition === "heatstroke") return 2;
    if (this.player.condition === "hypothermia") return 2.85;
    return 1;
  }

  /**
   * 休息被挡住时给出**具体**原因。
   * 站定却不回复是玩家最容易误判为 bug 的情形，UI 必须能说清楚是哪一条挡住了。
   * 返回 null 表示可以休息。
   */
  getRestBlocker(): LocalizedText | null {
    const player = this.player;
    if (player.condition === "heatstroke") return loc("sim.37");
    if (player.condition === "hypothermia") return loc("sim.38");
    if (player.hunger < 20) return loc("sim.39");
    if (player.water < 20) return loc("sim.40");
    if (this.phase === "night" && player.warmth <= 30) return loc("sim.41");
    // 只有"刚挨过打"才禁止休息，而不是"附近有狼"。
    // 按距离判定会让夜里任何时候都休息不了 —— 夜间地图上本来就有几十只狼，
    // 20 米的追击半径几乎覆盖全图，玩家只会看到一句解释不了的"附近有狼"。
    if (this.combatTimer > 0) return loc("sim.42", { v0: Math.ceil(this.combatTimer) });
    if (player.idleTime < REST_IDLE_SECONDS) return loc("sim.43", { v0: Math.ceil(REST_IDLE_SECONDS - player.idleTime) });
    return null;
  }

  private updateRest(delta: number): void {
    // 劳力没满时也值得休息 —— 休息是劳力的主要回复途径。
    const wantsRecovery = this.player.health < this.player.maxHealth || this.player.stamina < this.player.maxStamina;
    const canRest = this.player.idleTime >= REST_IDLE_SECONDS && wantsRecovery && this.getRestBlocker() === null;
    this.setResting(canRest);
    // 恒定流失是 HEALTH_DECAY，休息的净回复要减掉它才是玩家实际看到的速度。
    // 净回复 1.5 → 1.9 → 2.6（吃不饱时仍是 1.1）。站定的门槛本来就不低，
    // 回得太慢的话"休息"只是名义上的选择：满血 66 秒 → 53 秒 → 38 秒。
    // 38 秒仍然是一段要主动付出的时间，但在手机上不再长到让人宁可继续跑。
    // 饥渴档没跟着提：吃饱喝足才回得快，这条差距是"先去吃饭"的动力所在。
    const healingRate = (this.player.hunger < 40 || this.player.water < 40 ? 1.1 : 2.6)
      + HEALTH_DECAY * this.tuning.healthDecay;
    // health > 0：跟被动回复同一道闸，血已经归零就不许再被拽回来。见 updateNeeds。
    if (this.player.resting && this.player.health > 0) {
      this.player.health = clamp(this.player.health + delta * healingRate, 0, this.player.maxHealth);
    }
  }

  private setResting(active: boolean): void {
    if (this.player.resting === active) return;
    this.player.resting = active;
    this.events.push({ type: "rest", active });
  }

  private noteActivity(): void {
    // 教学期间只清静止计时、不点时钟：第一步就是教移动，不挡的话教学越完整死得越快。
    if (!this.tutorialHold) this.clockStarted = true;
    this.player.idleTime = 0;
    this.setResting(false);
  }

  /**
   * 原地动作：只启动时钟，**不打断休息、不清空静止计时**。
   * 吃喝和合成都是站着不动就能做的事 —— 把它们算成"活动"会让玩家
   * 每喝一口水就被踢出休息、还要再站满 5 秒，劳力等于回不上来。
   */
  private noteInPlaceAction(): void {
    if (!this.tutorialHold) this.clockStarted = true;
  }

  private updateFires(delta: number): void {
    for (const camp of this.camps) camp.fuel = Math.max(0, camp.fuel - delta);
  }

  private updateCacti(): void {
    for (const patch of this.cacti) {
      if (patch.juice === 0 && patch.regrowAt > 0 && this.elapsed >= patch.regrowAt) {
        patch.juice = 2;
        patch.regrowAt = 0;
      }
    }
  }

  /**
   * 树桩自愈。白天自己长回来，玩家不必每晚重造 ——
   * 这让它从"每晚的消耗品"变成"一次性投入的阵地"，也是这类路障的核心设计
   * （那边是 +5.00/s）。大石不自愈：它是石头不是活物。
   */
  private updateStructures(delta: number): void {
    for (const structure of this.structures) {
      if (!structure.active || structure.hp >= structure.maxHp) continue;
      const spec = STRUCTURE_SPECS[structure.kind];
      if (spec.regen <= 0) continue;
      structure.hp = Math.min(structure.maxHp, structure.hp + spec.regen * delta);
    }
  }

  private updateDrops(): void {
    for (const drop of this.drops) {
      if (!drop.active) continue;
      if (this.elapsed >= drop.expiresAt) {
        drop.active = false;
        continue;
      }
      if (distanceSquared(this.player, drop) > 1.8 * 1.8) continue;
      // 装得下多少拿多少，剩下的**留在地上并从堆里扣掉**。
      // 长角羚一次会掉多组资源，背包常常只剩两格位置 —— 全有或全无的话玩家只能眼睁睁
      // 看着一头长角羚烂在沙子里；而不扣数量就等于允许同一堆反复领取。
      const taken = Math.min(drop.count, this.getInventorySpace(drop.kind));
      if (taken <= 0) continue;
      this.addInventory(drop.kind, taken);
      drop.count -= taken;
      this.events.push({ type: "pickup", kind: drop.kind });
      if (drop.count > 0) continue;
      drop.active = false;
    }
  }

  private distanceToWorldEdge(point: Vec2): number {
    const half = this.world.size / 2;
    return half - Math.max(Math.abs(point.x), Math.abs(point.z));
  }

  private createDrop(position: Vec2, kind: InventoryItemKind, angleOffset: number, count = 1): void {
    const angle = Math.atan2(this.player.z - position.z, this.player.x - position.x) + angleOffset;
    const drop: WorldDrop = {
      id: this.dropId++,
      kind,
      count,
      x: position.x + Math.cos(angle) * 0.9,
      z: position.z + Math.sin(angle) * 0.9,
      active: true,
      createdAt: this.elapsed,
      expiresAt: this.elapsed + DROP_LIFETIME,
      burstAngle: angle,
    };
    this.drops.push(drop);
    this.events.push({ type: "loot-drop", kind, dropId: drop.id });
  }

  // ==========================================================================
  // 荒漠猎物
  // 全部不攻击玩家。难度只由「警觉半径 + 逃跑速度 + 冲刺时长」三项决定：
  // 冲刺耗尽后它们会停下喘气，所以再快的猎物只要肯追都追得到 ——
  // 代价是你自己的劳力和体温（奔跑产热 +0.9/s，白天很容易把自己追到中暑）。
  // ==========================================================================


  /**
   * 出生点侧后方那一根教学枯木（见 TUTORIAL_WOOD_* 的注释）。
   *
   * 直接追加进 this.items，不进 world.initialItems —— 后者被 retreatNavigations
   * 拿去建撤退流场（只筛石头），也被别的只读用途共享，往里塞东西等于改世界定义。
   * 未放置的枯木不参与碰撞（isBlockingGroundItem 只认石头和 placed），所以它
   * 不会在出生点旁边立起一堵墙。
   */
  private addTutorialWood(): void {
    const angle = this.spawnFacing + TUTORIAL_WOOD_SPREAD;
    const spot = this.findNearestWalkablePoint({
      x: this.spawnAnchor.x + Math.cos(angle) * TUTORIAL_WOOD_RADIUS,
      z: this.spawnAnchor.z + Math.sin(angle) * TUTORIAL_WOOD_RADIUS,
    });
    this.items.push({
      id: this.items.length,
      kind: "wood",
      x: spot.x,
      z: spot.z,
      hp: BARRIER_STATS.wood.hp,
      placed: false,
      active: true,
      // 朝向写死，不消费 this.random()：这一根要稳定出现在同一个地方。
      rotation: angle,
    });
  }

  getCritterLabel(kind: CritterKind): LocalizedText {
    return loc(`critter.${kind}.name`);
  }

  /**
   * 玩家此刻躲在哪座亮着火的营地里；在野外则返回 null。
   * 判定放宽到营地半径 + 6 米：站在台地边缘也算"在营地里"，
   * 免得玩家贴着边走一步就让整队狗改变目标、来回抽搐。
   */
  private getPlayerShelter(): CampDefinition | null {
    let best: CampDefinition | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const camp of this.world.camps) {
      if (this.camps[camp.id].fuel <= 0) continue;
      const value = distanceSquared(this.player, camp);
      if (value > (camp.radius + 6) ** 2 || value >= bestDistance) continue;
      best = camp;
      bestDistance = value;
    }
    return best;
  }

  /**
   * 狼拆路障的一击伤害。大狼咬得更狠（×1.45），护甲按减法直接扣掉。
   * 减法在这里是关键：6 点护甲对第 3 夜的大狼只减 19%，对小狼却减 41% ——
   * 路障因此天然更擅长过滤杂鱼，而这正是它该干的活。
   */
  private getBarrierDamage(wolf: WolfState, armor: number): number {
    const sizeScale = wolf.kind === "elite" ? 1.6 : wolf.kind === "large" ? 1.45 : 1.05;
    const raw = Math.round(wolf.attack * sizeScale);
    return Math.max(1, raw - armor);
  }

  private advancePhase(): void {
    if (this.phase === "day") {
      this.phase = "night";
      this.phaseTime = this.day === 1 ? FIRST_NIGHT_DURATION : this.day === 2 ? SECOND_NIGHT_DURATION : LATER_NIGHT_DURATION;
      this.wolfDirector.beginNight();
      this.objectiveStage = 3;
      this.events.push({ type: "phase", phase: "night", day: this.day });
      const litAtDusk = this.getNearestLitCamp();
      this.events.push({
        type: "message",
        key: litAtDusk && litAtDusk.fuel >= this.phaseTime ? "msg.duskFireOk" : "msg.duskFireShort",
      });
      return;
    }
    this.phase = "day";
    this.day += 1;
    this.phaseTime = LATER_DAY_DURATION;
    // 只有夜袭部队撤离；白天的野狼留在原地继续游荡，它们才是狼皮的来源。
    this.wolfDirector.scheduleRaiderRetreat();
    this.duskWarningSent = false;
    this.wolfDirector.beginDay();
    this.events.push({ type: "phase", phase: "day", day: this.day });
    this.events.push({ type: "message", key: "msg.43" });
  }

  /** 即将到来的那一夜有多长 —— 黄昏算燃料够不够用得上。 */
  private getComingNightDuration(): number {
    return this.day === 1 ? FIRST_NIGHT_DURATION : this.day === 2 ? SECOND_NIGHT_DURATION : LATER_NIGHT_DURATION;
  }

  /**
   * 黄昏燃料预警。
   * 原先只有"火灭了 · 体温正在下降"这种**事后**提示，喊出来时玩家已经在挨冻了；
   * 而且天黑预警只在第 1 天出现，之后每一夜都是无预告的。
   * 这里改成**事前**并且给出确切数字：今晚多长、现在的火能烧多久、还差几根枯木。
   * 燃料每秒烧 1 点，一根枯木 +95 —— 所以缺口除以 95 就是要搬的根数。
   */
  private warnDuskFuel(): void {
    const night = this.getComingNightDuration();
    const lit = this.getNearestLitCamp();
    const fuel = lit ? lit.fuel : 0;
    if (fuel >= night) {
      this.events.push({ type: "message", key: "msg.44", params: { v0: Math.round(fuel) } });
      return;
    }
    const logs = Math.ceil((night - fuel) / 95);
    /*
     * **背包里的柴要算进去。**
     *
     * 这段原本只看营地火塘的燃料，于是不管玩家背上有几根柴，喊的都是"去囤枯木"。
     * 开局白送 3 根（STARTING_RATION）、营地火塘边又摆了 10 根之后，
     * 这句话在绝大多数情况下都是错的指令 —— 玩家不缺柴，缺的是"把柴添进火里"
     * 这一个动作。指错方向比不说话更糟：他会跑去捡本来就够的东西。
     */
    const carried = this.getInventoryCount("wood");
    if (carried >= logs) {
      this.events.push({ type: "message", key: "msg.duskCarryEnough", params: { logs } });
      return;
    }
    // 还差几根**要去捡的**，不是总共要几根。
    const missing = logs - carried;
    this.events.push(fuel <= 0
      ? { type: "message", key: "msg.duskNoFire", params: { night, logs: missing } }
      : { type: "message", key: "msg.duskLowFire", params: { fuel: Math.round(fuel), night, logs: missing } });
  }

  private updateObjectives(): void {
    // 每一天都预警，不再只有第 1 天。
    if (!this.duskWarningSent && this.phase === "day" && this.phaseTime <= 30) {
      this.duskWarningSent = true;
      this.warnDuskFuel();
    }
    // 枯木改为进背包之后，这一阶不能再只看 carrying —— 否则捡了柴也不算数，
    // 玩家会永远卡在"拿起身边的枯木"。
    if (this.objectiveStage === 0 && (this.player.carrying || this.getInventoryCount("wood") > 0)) {
      // 这一阶原本弹 msg.46（"枯木能烧火；门口巨石挡路"）。删掉了：
      // 一句塞两个话题，而两个话题在头 10 秒里各自已经被 msg.1 和 msg.47 说过。
      this.objectiveStage = 1;
    } else if (this.objectiveStage === 1 && this.camps.some((camp) => camp.fuel > 90)) {
      this.objectiveStage = 2;
      this.events.push({ type: "message", key: "msg.47" });
    } else if (this.objectiveStage === 2 && this.world.camps.some((camp) => this.isEntranceBlocked(camp))) {
      this.objectiveStage = 3;
      this.events.push({ type: "message", key: "msg.48" });
    }
  }

  private isEntranceBlocked(camp: CampDefinition): boolean {
    const entrance = campGatePosition(camp);
    return this.items.some((item) => item.active && item.placed && item.kind === "stone" && distanceSquared(item, entrance) < 3.6 * 3.6);
  }

  /** 背包还能再装下多少个 kind。addInventory 靠它保证"要么全进、要么不动"。 */
  getInventorySpace(kind: InventoryItemKind): number {
    const limit = INVENTORY_STACK_LIMITS[kind];
    let space = 0;
    for (const stack of this.player.inventory) {
      if (!stack) space += limit;
      else if (stack.kind === kind) space += Math.max(0, limit - stack.count);
    }
    return space;
  }

  /**
   * 入包，**原子操作**：装不下就一个都不装。
   * 所有调用方写的都是 `if (!addInventory(...)) 报错回滚`，可原先它会先把塞得下的
   * 那部分塞进去再返回 false —— 掉落物因此能被反复领取（拿走一半、地上那堆还是满的）。
   */
  private addInventory(kind: InventoryItemKind, count: number): boolean {
    if (count <= 0) return true;
    if (this.getInventorySpace(kind) < count) return false;
    // 过了容量检查就必然入包，锁存放在这里 —— 这是物品进背包的唯一收口
    // （挖矿、剥皮、捡掉落、开局口粮全走它），不必在各个调用点重复判断。
    if (kind === "hide" || kind === "iron-ore") this.equipmentUnlocked = true;
    let remaining = count;
    const limit = INVENTORY_STACK_LIMITS[kind];
    for (const stack of this.player.inventory) {
      if (!stack || stack.kind !== kind || stack.count >= limit) continue;
      const amount = Math.min(remaining, limit - stack.count);
      stack.count += amount;
      remaining -= amount;
      if (remaining === 0) return true;
    }
    for (let index = 0; index < this.player.inventory.length; index += 1) {
      if (this.player.inventory[index]) continue;
      const amount = Math.min(remaining, limit);
      this.player.inventory[index] = { kind, count: amount };
      remaining -= amount;
      if (remaining === 0) return true;
    }
    return false;
  }

  private removeInventory(kind: InventoryItemKind, count: number): void {
    let remaining = count;
    for (let index = this.player.inventory.length - 1; index >= 0; index -= 1) {
      const stack = this.player.inventory[index];
      if (!stack || stack.kind !== kind) continue;
      const amount = Math.min(remaining, stack.count);
      this.removeFromSlot(index, amount);
      remaining -= amount;
      if (remaining === 0) return;
    }
  }

  private removeFromSlot(index: number, count: number): void {
    const stack = this.player.inventory[index];
    if (!stack) return;
    stack.count -= count;
    if (stack.count <= 0) this.player.inventory[index] = null;
  }

  private findNearestCamp(maxDistance: number): CampDefinition | null {
    let nearest: CampDefinition | null = null;
    let best = maxDistance * maxDistance;
    for (const camp of this.world.camps) {
      const value = distanceSquared(this.player, camp);
      if (value < best) {
        nearest = camp;
        best = value;
      }
    }
    return nearest;
  }

  private findNearestItem(maxDistance: number): GroundItem | null {
    let nearest: GroundItem | null = null;
    let best = maxDistance * maxDistance;
    for (const item of this.items) {
      if (!item.active) continue;
      const value = distanceSquared(this.player, item);
      if (value < best) {
        nearest = item;
        best = value;
      }
    }
    return nearest;
  }

  private findNearestCactus(maxDistance: number): CactusPatch | null {
    let nearest: CactusPatch | null = null;
    let best = maxDistance * maxDistance;
    for (const patch of this.cacti) {
      if (patch.juice <= 0) continue;
      const value = distanceSquared(this.player, patch);
      if (value < best) {
        nearest = patch;
        best = value;
      }
    }
    return nearest;
  }

  /** 射程内还有柴的树；砍空的树桩不再返回。 */
  private findNearestTree(maxDistance: number): TreeState | null {
    let nearest: TreeState | null = null;
    let best = maxDistance * maxDistance;
    for (const tree of this.trees) {
      if (tree.wood <= 0) continue;
      const value = distanceSquared(this.player, tree);
      if (value < best) {
        nearest = tree;
        best = value;
      }
    }
    return nearest;
  }

  private findNearestIron(maxDistance: number): IronNode | null {
    let nearest: IronNode | null = null;
    let best = maxDistance * maxDistance;
    for (const node of this.ironNodes) {
      if (node.ore <= 0) continue;
      const value = distanceSquared(this.player, node);
      if (value < best) {
        nearest = node;
        best = value;
      }
    }
    return nearest;
  }

  private findNearestWalkablePoint(origin: Vec2): Vec2 {
    if (isTerrainWalkable(this.world, origin)) return origin;
    for (let radius = 2; radius <= 24; radius += 2) {
      for (let step = 0; step < 16; step += 1) {
        const angle = (step / 16) * TAU;
        const candidate = {
          x: clamp(origin.x + Math.cos(angle) * radius, -this.world.size / 2 + 1, this.world.size / 2 - 1),
          z: clamp(origin.z + Math.sin(angle) * radius, -this.world.size / 2 + 1, this.world.size / 2 - 1),
        };
        if (isTerrainWalkable(this.world, candidate)) return candidate;
      }
    }
    return origin;
  }

  private dropCarriedItem(): void {
    const kind = this.player.carrying;
    if (!kind) return;
    // 活狼没法"放在地上"，只能松手 —— 它落地就恢复行动。
    if (kind === "beast") {
      this.projectileCombat.releaseCarriedWolf();
      return;
    }
    const dropPosition = {
      x: this.player.x + this.player.facing.x * 2.05,
      z: this.player.z + this.player.facing.z * 2.05,
    };
    if (kind === "fuel") {
      const dropped = this.projectileCombat.dropCarriedBarrel(
        dropPosition,
        Math.atan2(this.player.facing.z, this.player.facing.x),
      );
      if (!dropped) {
        this.player.carrying = null;
      }
      return;
    }
    if (kind === "stake") {
      const structure = this.carriedStructure;
      if (!structure) {
        this.player.carrying = null;
        return;
      }
      const reason = this.getBuildBlocker(structure.kind, dropPosition);
      if (reason) {
        this.events.push({ type: "message", key: "msg.49", params: { v0: reason } });
        return;
      }
      structure.x = dropPosition.x;
      structure.z = dropPosition.z;
      structure.rotation = Math.atan2(this.player.facing.z, this.player.facing.x);
      structure.active = true;
      this.carriedStructure = null;
      this.player.carrying = null;
      this.events.push({ type: "drop", kind });
      return;
    }
    const existing = this.items.find((item) => !item.active);
    const item: GroundItem = existing ?? {
      id: this.items.length,
      x: dropPosition.x,
      z: dropPosition.z,
      kind,
      hp: 1,
      placed: true,
      active: true,
      rotation: Math.atan2(this.player.facing.z, this.player.facing.x),
    };
    item.x = dropPosition.x;
    item.z = dropPosition.z;
    item.kind = kind;
    item.hp = BARRIER_STATS[kind].hp;
    item.placed = true;
    item.active = true;
    item.rotation = Math.atan2(this.player.facing.z, this.player.facing.x);
    if (!existing) this.items.push(item);
    this.player.carrying = null;
    this.events.push({ type: "drop", kind });
  }

  private findNearestStructure(maxDistance: number): PlacedStructure | null {
    let nearest: PlacedStructure | null = null;
    let best = maxDistance * maxDistance;
    for (const structure of this.structures) {
      if (!structure.active) continue;
      const value = distanceSquared(this.player, structure);
      if (value < best) {
        nearest = structure;
        best = value;
      }
    }
    return nearest;
  }

}
