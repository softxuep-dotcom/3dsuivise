import {
  clamp,
  direction,
  distance,
  distanceSquared,
  dot,
  mulberry32,
  normalize,
} from "./geometry";
import { campGatePosition, campLocalToWorld, isTerrainWalkable } from "../terrain/TerrainModel";
import { nearest } from "./query/nearest";
import { pickAt } from "./query/pickAt";
import type { ClickPick } from "./query/pickAt";
import { describeCost, loc } from "./text";
import { NavigationGrid } from "./NavigationGrid";
import { CollisionKernel } from "./movement/CollisionKernel";
import { InventorySystem } from "./InventorySystem";
import { EquipmentSystem } from "./EquipmentSystem";
import { SurvivalSystem } from "./SurvivalSystem";
import { CritterDirector } from "./CritterDirector";
import { FuelPerkSystem } from "./FuelPerkSystem";
import type { FuelPerkId } from "../balance/fuelPerks";
import { TruckSystem } from "./TruckSystem";
import type { FuelProgress } from "./TruckSystem";
import { ObjectiveNarrator } from "./ObjectiveNarrator";
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
/*
 * 平衡数值住在 ../balance/ 下的三个文件里，不在这里。
 *
 * 它们原先是本文件开头的 646 行、83 个模块级常量 —— 于是"调一下白天升温速率"
 * 和"改一条战斗规则"落在同一个文件里，每次改平衡都要在三千行逻辑中间找位置。
 * 分开之后：数字在 balance/，规则在这里，两边的改动不再互相干扰。
 *
 *   balance/survival.ts   五轴：体温 / 生命 / 水分 / 饥饿 / 劳力
 *   balance/equipment.ts  武器与护甲双线的属性和造价
 *   balance/world.ts      昼夜时长、判定距离、井、掉落、教学布置、卡车与油桶
 *
 * 搬运没有改动任何数值，行为由 tests/baseline.test.ts 的三份快照锁着。
 */
import {
  COOKED_HEALTH,
  COOKED_HUNGER,
  COOKED_WATER,
  EXHAUSTED_DAMAGE_SCALE,
  FIRE_WARMTH_RADIUS,
  JUICE_HUNGER,
  JUICE_WARMTH,
  JUICE_WATER,
  RAW_HEALTH,
  RAW_HUNGER,
  RAW_WATER,
  STAMINA_COST_CACTUS,
  STAMINA_COST_CHOP,
  STAMINA_COST_DRAW,
  STAMINA_COST_MINE,
  STAMINA_COST_WOOD,
  STAMINA_MAX,
  WARMTH_INITIAL,
  WARMTH_MAX,
  WARMTH_MIN,
  WATER_RESTORE,
  WATER_URGENT,
  WATER_WARMTH_COST,
} from "../balance/survival";
import type { EquipTier, WeaponStat } from "../balance/equipment";
import {
  ATTACK_COOLDOWN,
  COMBO_WINDOW,
} from "../balance/equipment";
import {
  DROP_LIFETIME,
  FIRST_DAY_DURATION,
  FIRST_NIGHT_DURATION,
  FUEL_PICKUP_REACH,
  LATER_DAY_DURATION,
  LATER_NIGHT_DURATION,
  REVIVE_CLEAR_RADIUS,
  REVIVE_GRACE_SECONDS,
  SECOND_NIGHT_DURATION,
  STARTING_RATION,
  STRAIGHT_WALK_MAX,
  TREE_REACH,
  TREE_WOOD,
  TRUCK_BOARD_REACH,
  TRUCK_LOAD_REACH,
  TUTORIAL_WOOD_RADIUS,
  TUTORIAL_WOOD_SPREAD,
  WELL_CHARGES_INITIAL,
  WELL_CHARGES_MAX,
  WELL_REACH,
  WELL_REFILL_SECONDS,
} from "../balance/world";

/**
 * 造一条待渲染文案。模拟层所有面向玩家的字符串都经这里出去 ——
 * 它不认识任何一门语言，只负责说清"这是哪一条、带什么参数"。
 */

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

/**
 * 模拟层的状态容器与每帧编排。**规则本身住在下面这些子系统里。**
 *
 *   movement/CollisionKernel  谁能站、谁走得过去、谁挡着谁的视线
 *   query/nearest             「离玩家最近的那个」
 *   InventorySystem           背包格子的增删查
 *   EquipmentSystem           武器与护甲双线
 *   SurvivalSystem            五轴：体温 / 生命 / 水分 / 饥饿 / 劳力
 *   WolfDirector              狼群
 *   CritterDirector           猎物
 *   TruckSystem               卡车与油桶（通关条件）
 *   ObjectiveNarrator         目标行与方位提示
 *
 * 这里剩下的是三样东西：**状态**（世界、玩家、各类实体数组）、
 * **每帧的调用顺序**（{@link GameSimulation.update}），以及各子系统之间的**接线**。
 *
 * ## update() 里的顺序是契约，不要随手调
 *
 * 那一串 updateX 的先后关系是有理由的，有几条还写着注释解释为什么
 * （比如拾取必须排在时钟闸之前）。加新子系统时想清楚它该插在哪一拍。
 *
 * ## 标着「端口成员」的那些方法和字段
 *
 * 它们本来都是 private。抽子系统时不得不公开，因为 TypeScript 的结构化类型
 * 不认 private 成员 —— 子系统通过接口（`XxxOwner`）调它们，而接口里的成员必须是公开的。
 *
 * **它们不是给渲染层和 HUD 用的。** 外部只该用原有的那批公有方法。
 * 想彻底收干净的话有两条路：改用 WolfDirector 那样的适配器对象
 * （`createWolfWorld()` 就是个现成的例子，代价是每个子系统多十来行样板），
 * 或者等 API 收窄那一轮统一处理。
 */
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
  /**
   * 碰撞与空间查询。谁能站、谁走得过去、谁挡着谁的视线，全归它。
   *
   * 声明在这里而不是构造函数里：它只存一个 this 引用，构造时不读任何字段，
   * 所以字段初始化顺序对它没有影响（world 这时还没赋值也无所谓）。
   */
  private readonly collision = new CollisionKernel(this);
  /** 背包格子的增删查。只管格子，东西是什么由各系统自己判断。 */
  private readonly inventory = new InventorySystem(this);
  /** 武器与护甲双线：当前装着什么、还能造什么、造出来是多少属性。 */
  private readonly equipment = new EquipmentSystem(this, this.inventory);
  /** 五轴生存模型：体温 / 生命 / 水分 / 饥饿 / 劳力，外加休息与就地冷暖。 */
  private readonly survival = new SurvivalSystem(this, this.equipment);
  /** 猎物：肉、皮和开局那三只教学猎物。 */
  private readonly critterDirector = new CritterDirector(this, this.collision);
  /** 卡车与油桶：这个游戏唯一的通关条件。 */
  /**
   * 搬油三选一。见 FuelPerkSystem —— 它是奖励状态的唯一真相来源，
   * HUD 只读 getFuelPerkOffer() / 回 chooseFuelPerk()。
   */
  readonly fuelPerks = new FuelPerkSystem(this);
  private readonly truckSystem = new TruckSystem(this, this.collision);
  /** 目标行与方位提示：模拟层唯一产出玩家能读到的话的地方。 */
  private readonly objectives = new ObjectiveNarrator(this, this.truckSystem, this.equipment);
  private readonly wolfDirector!: WolfDirector;
  /** 狼群本体现在归 WolfDirector 管；这里保留同名入口，渲染层和 HUD 不用改。 */
  get wolves(): WolfState[] { return this.wolfDirector.wolves; }
  /** 猎物本体归 CritterDirector 管；这里保留同名入口，渲染层和 HUD 不用改。 */
  get critters(): CritterState[] { return this.critterDirector.critters; }

  /** 猎物的名字。HUD 在猎杀提示里用。 */
  getCritterLabel(kind: CritterKind): LocalizedText {
    return this.critterDirector.label(kind);
  }
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

  /** 本局的确定性随机源。端口成员（见 emit()），行为基线全靠它可复现。 */
  readonly random = mulberry32(847331);
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
  /** 刚挨过打之后的倒计时。端口成员，见 emit()。 */
  combatTimer = 0;
  private structureId = 0;
  /** 正被玩家双手搬运的树桩；保留原对象才能避免搬运受损树桩时把生命值刷满。 */
  private carriedStructure: PlacedStructure | null = null;
  /** 生肉不回体力这条只在第一次生吞时说一遍，之后靠目标行常驻。 */
  private rawMeatHintSent = false;
  /** 体温调节动作的冷却（公开给 HUD 显示）。状态在 SurvivalSystem 里。 */
  get coolCooldown(): number { return this.survival.coolCooldown; }
  get warmCooldown(): number { return this.survival.warmCooldown; }
  private gameOverSent = false;
  /** 胜利结算只跑一次。端口成员，见 emit()。 */
  victorySent = false;
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
  /** 端口成员，见 emit()。教学猎物要撒在这里。 */
  readonly spawnAnchor: Vec2;
  readonly spawnFacing: number;

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
      hunger: 90,
      water: 85,
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
    this.navigation.rebuild(this.player, this.collision.getFlowFieldObstacles());
    this.wolfDirector = new WolfDirector(this.createWolfWorld());
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
        // 护桶姿势只在**扛着油**的时候减伤 —— 它买的是危险运输路线的容错。
        const scaled = sim.player.carrying === "fuel"
          ? amount * sim.fuelPerks.carriedDamageScale()
          : amount;
        sim.player.health -= scaled;
        sim.healthDamageCause = "killed";
        sim.healthDamageAttacker = attacker.kind;
      },
      setCombatTimer: (seconds) => { sim.combatTimer = seconds; },
      noteActivity: () => sim.noteActivity(),
      getDefense: () => sim.equipment.defense(),
      getPhaseDuration: () => sim.getPhaseDuration(),
      getPlayerShelter: () => sim.getPlayerShelter(),
      getPlayerArmor: () => sim.equipment.armorStats(),
      createDrop: (position, kind, angleOffset, count) => sim.createDrop(position, kind, angleOffset, count),
      moveEntity: (entity, dx, dz, radius, collideWithItems, terrainSlopeAllowance) =>
        sim.collision.moveEntity(entity, dx, dz, radius, collideWithItems, terrainSlopeAllowance),
      canStepToward: (from, dir, radius, collideWithItems) => sim.collision.canStepToward(from, dir, radius, collideWithItems),
      findSteppableDirection: (from, desired, collideWithItems) =>
        sim.collision.findSteppableDirection(from, desired, collideWithItems),
      findNearestWalkablePoint: (origin) => sim.collision.findNearestWalkablePoint(origin),
      lineOfSightBlocked: (start, end) => sim.collision.lineOfSightBlocked(start, end),
      hasMeleeLine: (start, end) => sim.collision.hasMeleeLine(start, end),
      distanceToWorldEdge: (point) => sim.collision.distanceToWorldEdge(point),
      getSteeredDirection: (entity, desired) => sim.collision.getSteeredDirection(entity, desired),
      getBarrierDamage: (wolf, armor) => sim.getBarrierDamage(wolf, armor),
      isBlockingGroundItem: (item) => sim.collision.isBlockingGroundItem(item),
      notePerkWolfKilled: () => sim.fuelPerks.noteWolfKilled(),
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
    if (this.truckSystem.departing) {
      this.truckSystem.updateDeparture(delta);
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
    this.survival.tickCooldowns(delta);
    this.fuelPerks.tick(delta);
    if (!isMoving) this.player.idleTime += delta;
    this.navigationCountdown -= delta;
    if (this.navigationCountdown <= 0) {
      this.navigation.rebuild(this.player, this.collision.getFlowFieldObstacles());
      this.navigationCountdown = 0.65;
    }

    this.survival.tick(delta);
    this.updateFires(delta);
    this.updateCacti();
    this.updateWells();
    this.updateStructures(delta);
    if (this.crittersEnabled) this.critterDirector.update(delta);
    if (this.wolvesEnabled) this.wolfDirector.updateWolves(delta);
    this.survival.updateRest(delta);
    this.objectives.updateObjectives();

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
  /**
   * 本次交互开始前的静止时长；劳力不足导致交互落空时用它还原。
   * 端口成员（见 emit()），实现在 SurvivalSystem.spendStamina。
   */
  idleTimeBeforeAction = 0;

  private endGame(cause: DeathCause): void {
    this.deathCondition = this.player.condition;
    this.deathKiller = cause === "killed" ? this.healthDamageAttacker : null;
    this.survival.setResting(false);
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
    this.survival.setResting(false);
    this.running = false;
    this.victorySent = true;
    this.won = true;
    this.events.push({ type: "victory" });
  }

  requestInteraction(): void {
    // 驶离期间整个操作面锁死：那十秒里玩家已经在车上了，按什么都不该有反应。
    if (!this.running || this.truckSystem.departing) return;
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
    // 所以判定半径（5.5）比拾取半径（2.6）宽：对着车找角度不该是玩法的一部分。
    if (this.player.carrying === "fuel" && this.truckSystem.carriedBarrel
      && distance(this.player, this.truck) <= TRUCK_LOAD_REACH) {
      this.truckSystem.loadCarried();
      return;
    }

    if (this.player.carrying) {
      this.dropCarriedItem();
      return;
    }

    // 空手站在加满油的车边 = 发车。放在拾取之前，否则车边掉了根柴就永远上不了车。
    if (this.truck.loaded >= FUEL_REQUIRED && distance(this.player, this.truck) <= TRUCK_BOARD_REACH) {
      this.truckSystem.depart();
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
      barrel.placement = "carried";
      this.truckSystem.carriedBarrel = barrel;
      this.player.carrying = "fuel";
      this.events.push({ type: "pickup", kind: "fuel" });
      return;
    }

    const item = this.findNearestItem(2.5);
    if (item) {
      if (item.kind === "wood") {
        if (!this.survival.spendStamina(STAMINA_COST_WOOD)) return;
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
      if (!this.survival.spendStamina(STAMINA_COST_MINE)) return;
      if (!this.addInventory("iron-ore", 1)) {
        this.events.push({ type: "message", key: "msg.3" });
        return;
      }
      ironNode.ore -= 1;
      this.events.push({ type: "pickup", kind: "iron-ore" });
      this.events.push({ type: "message", key: "msg.4", params: { v0: this.equipment.describeNextUpgrade("weapon") } });
      return;
    }

    const tree = this.findNearestTree(TREE_REACH);
    if (tree) {
      if (!this.survival.spendStamina(STAMINA_COST_CHOP)) return;
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

  private findNearestBarrel(maxDistance: number): FuelBarrelState | null {
    return nearest(this.barrels, this.player, maxDistance,
      { accept: (barrel) => barrel.placement === "ground" });
  }

  /** 复活无敌还剩多久；HUD 拿它提示"这几秒不会掉血"。 */
  getReviveGrace(): number {
    return this.reviveGrace;
  }

  getObjective(): LocalizedText {
    return this.objectives.getObjective();
  }

  getCurrentLocationLabel(): LocalizedText {
    return this.objectives.getCurrentLocationLabel();
  }

  isDeparting(): boolean {
    return this.truckSystem.departing;
  }

  /**
   * 火塘之外还有没有更近的可交互目标。
   * 采集类目标的判定半径都在 3.2 米以内，火塘却有 10 米 —— 不比距离的话，
   * 营地范围内的拾取、割仙人掌、挖矿、提水会被添柴全部吃掉。
   */
  /** 端口成员，见 emit()。 */
  hasNearerTarget(hearthDistance: number): boolean {
    const barrel = this.findNearestBarrel(FUEL_PICKUP_REACH);
    if (barrel && distance(this.player, barrel) < hearthDistance) return true;
    const item = this.findNearestItem(2.5);
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

  private findNearestWell(maxDistance: number): WellState | null {
    // WellState 上只有 id 和存量，坐标要去 world.wells 里取。
    return nearest(this.wells, this.player, maxDistance, {
      accept: (well) => well.charges > 0,
      positionOf: (well) => this.world.wells[well.id],
    });
  }

  /** 端口成员：让连击窗口走一拍。位置为什么在代谢和体温之间，见 SurvivalSystem.tick。 */
  tickCombo(delta: number): void {
    if (this.comboTimer > 0) {
      this.comboTimer = Math.max(0, this.comboTimer - delta);
      if (this.comboTimer === 0 && this.comboStacks > 0) {
        this.comboStacks = 0;
        this.comboTargetKey = null;
        this.events.push({ type: "combo", stacks: 0 });
      }
    }
  }

  /** TruckSystem 的端口：开出边界就通关。 */
  finishVictory(): void {
    this.endGameWithVictory();
  }

  /** TruckSystem 的端口：发车瞬间退出休息。 */
  stopResting(): void {
    this.survival.setResting(false);
  }

  /** TruckSystem 的端口：某个方向在屏幕上是哪个方位角。 */
  screenBearingTo(target: Vec2): number {
    return screenBearing(this.player, target);
  }

  /** 端口成员：这一帧的掉血先记成"自然耗尽"，被狼咬会随后覆盖掉。 */
  noteMetabolicDamage(): void {
    this.healthDamageCause = "exhausted";
    this.healthDamageAttacker = null;
  }

  /** 割仙人掌取汁：一刀即得，代价是劳力和"你得先找到它"。 */
  private harvestCactus(patch: CactusPatch): void {
    if (!this.survival.spendStamina(STAMINA_COST_CACTUS)) return;
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
    if (!this.survival.spendStamina(STAMINA_COST_DRAW)) return;
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

  requestAttack(): void {
    if (!this.running || this.truckSystem.departing || this.player.attackCooldown > 0 || this.player.carrying) return;
    this.noteActivity();
    const stats = this.equipment.weaponStats();
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
    this.player.attackCooldown = ATTACK_COOLDOWN * this.survival.conditionCooldownScale();
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
      && this.collision.hasMeleeLine(this.player, target);

    for (const wolf of this.wolves) {
      if (wolf.mode === "dead" || !inArc(wolf)) continue;
      const wasRetreating = wolf.mode === "retreating";
      const rolled = this.rollDamage(stats, comboMultiplier, exhausted, wolf.defense);
      // 清巢老手只对**还守着**的巢犬加伤：五只全死之后这张卡也退出候选池。
      const damage = rolled.damage * this.fuelPerks.denDamageScale(wolf.role === "guard");
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
    if (!hit && this.objectives.objectiveStage >= 3) this.events.push({ type: "message", key: "msg.10" });
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
    const raw = this.equipment.attackPower()
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


  /** 背包物品格统一走这个索引入口。 */
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
      this.survival.updateCondition();
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
      this.survival.updateCondition();
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
    this.events.push({ ...this.equipment.describeNextUpgrade(stack.kind === "iron-ore" ? "weapon" : "armor"), type: "message" });
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

  getEquipped(slot: "weapon" | "armor"): EquipTier {
    return this.equipment.equipped(slot);
  }

  getUpgradeOptions(slot: "weapon" | "armor"): EquipTier[] {
    return this.equipment.upgradeOptions(slot);
  }

  /** 满足材料与火源条件、可以从 HUD 直接制作的正常升级；换线不在这里。 */
  getCraftableUpgrades(slot: "weapon" | "armor"): EquipTier[] {
    return this.equipment.craftableUpgrades(slot);
  }

  isEquipmentUnlocked(): boolean {
    return this.equipment.unlocked;
  }

  getLineFinale(slot: "weapon" | "armor", line: EquipLine): EquipTier | null {
    return this.equipment.lineFinale(slot, line);
  }

  getSwitchOptions(slot: "weapon" | "armor"): EquipTier[] {
    return this.equipment.switchOptions(slot);
  }

  craftEquip(slot: "weapon" | "armor", id: string): boolean {
    return this.equipment.craft(slot, id);
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
      const need = describeCost(spec.cost);
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
    if (!this.survival.spendStamina(spec.stamina)) return false;

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
    return this.inventory.count(kind);
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
  /**
   * 键鼠玩家点了一下世界上的某个点，那一下点中了什么。
   *
   * `point` 是射线打到地面的点，`forward` 是这条射线在地面上的前进方向 ——
   * 两个都由 GameRenderer.screenToGround 一次给出。**方向不能省**：
   * 玩家点的是物体画出来的像素（离地一两米），命中点落在物体身后 0.8~13.4 米，
   * 判定必须沿视线分解才不会落空。详见 query/pickAt.ts 顶上那段实测。
   *
   * 返回 null 表示点的是空地 —— 调用方退回原来的纯移动。
   */
  pickAt(point: Vec2, forward: Vec2): ClickPick | null {
    if (this.truckSystem.departing) return null;
    /*
     * 显式构造，**不要写 `{ ...this }`**。
     *
     * 对象展开只复制自有可枚举属性，而 `wolves`（以及别的几个）是原型上的 getter ——
     * 展开出来是 undefined，于是点狼永远选不中，而且不报错，只是"点了没反应"。
     * 顺带也省掉每次点击复制九十多个字段。
     */
    return pickAt({
      world: this.world,
      wells: this.wells,
      trees: this.trees,
      cacti: this.cacti,
      ironNodes: this.ironNodes,
      items: this.items,
      structures: this.structures,
      barrels: this.barrels,
      critters: this.critters,
      wolves: this.wolves,
      truck: this.truck,
      attackRange: this.equipment.weaponStats().range,
      carrying: this.player.carrying,
    }, point, forward);
  }

  hasAttackTargetInRange(): boolean {
    if (this.player.carrying) return false;
    const range = this.equipment.weaponStats().range;
    const rangeSq = range * range;
    return this.wolves.some((wolf) => wolf.mode !== "dead" && distanceSquared(this.player, wolf) <= rangeSq)
      || this.critters.some((critter) => critter.mode !== "dead" && distanceSquared(this.player, critter) <= rangeSq);
  }

  getInteractionHint(): InteractionHint {
    if (this.truckSystem.departing) return { action: "none", text: loc("hint.none") };
    // 与 requestInteraction 保持一致：水分告急时，仙人掌优先、其次找井。
    if (this.player.water < WATER_URGENT && !this.player.carrying) {
      if (this.findNearestCactus(2.7)) return { action: "cactus", text: loc("hint.urgentCactus") };
      const urgentWell = this.findNearestWell(WELL_REACH);
      if (urgentWell) return { action: "well", text: loc("hint.urgentWell") };
    }
    if (this.player.carrying === "fuel") {
      return distance(this.player, this.truck) <= TRUCK_LOAD_REACH
        ? { action: "load", text: loc("hint.loadFuel", { loaded: this.truck.loaded, required: FUEL_REQUIRED }) }
        : { action: "drop", text: loc("hint.dropFuel") };
    }
    if (this.player.carrying) {
      return this.player.carrying === "stake"
        ? { action: "drop", text: loc("hint.dropStake") }
        : { action: "drop", text: loc("hint.dropStone") };
    }
    if (this.truck.loaded >= FUEL_REQUIRED && distance(this.player, this.truck) <= TRUCK_BOARD_REACH) {
      return { action: "board", text: loc("hint.board") };
    }
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
    const item = this.findNearestItem(2.5);
    if (item) {
      return item.kind === "wood"
        ? { action: "pickup", text: loc("hint.takeWood") }
        : { action: "pickup", text: loc("hint.liftStone") };
    }
    const structure = this.findNearestStructure(2.7);
    if (structure) return { action: "pickup", text: loc("hint.liftStake") };
    if (this.findNearestCactus(2.7)) return { action: "cactus", text: loc("hint.cactus") };
    if (this.findNearestIron(2.8)) return { action: "mine", text: loc("hint.mine") };
    if (this.findNearestTree(TREE_REACH)) {
      return { action: "chop", text: loc("hint.chop") };
    }
    const well = this.findNearestWell(WELL_REACH);
    if (well) return { action: "well", text: loc("hint.well", { left: well.charges }) };
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
   * 玩家此刻是否正被篝火烤着。
   *
   * 火焰半径（10 米）几乎盖住整座营地，肉眼**看不出**自己在不在圈里 ——
   * 而"在不在圈里"决定夜里体温是 +2.11/s 还是 −1.05/s，是夜间最重要的一条状态。
   * 渲染层拿它画脚下的暖环，第一夜教学拿它判定"学会烤火了"，两处同一个判据。
   */
  isWarmedByFire(): boolean {
    return this.findNearestLitFire(FIRE_WARMTH_RADIUS) !== null;
  }

  /** 端口成员，见 emit()。 */
  findNearestHearth(maxDistance: number): { campId: number; distance: number } | null {
    const camp = nearest(this.world.camps, this.player, maxDistance);
    // 开根号写在这里而不是 nearest 里：nearest 全程比较距离的平方，
    // 换成 distance() 的 Math.hypot 会在最后一位有效数字上和原来不同。
    return camp ? { campId: camp.id, distance: Math.sqrt(distanceSquared(this.player, camp)) } : null;
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

  // getNearestThreat() 已删除：它服务的是那块常驻在屏幕中央的"最近敌人"面板。
  // 夜里地图上几十只狼，24 米内永远有一只顶上来，那块面板等于常年糊在视野正中。
  // 狼的血量统一走头顶跟随血条（受伤才亮 2.6 秒），不再有唯一 BOSS 血条。

  getFuelProgress(): FuelProgress {
    return this.truckSystem.progress();
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
      this.clickRoute.rebuild(target, this.collision.getFlowFieldObstacles());
    }
    if (distance(this.player, target) < STRAIGHT_WALK_MAX && this.collision.canWalkStraight(this.player, target)) {
      return direction(this.player, target);
    }
    return this.clickRoute.reachedTargetCell(this.player) ? null : this.clickRoute.directionFrom(this.player);
  }

  /** 剑线连击的当前层数与上限，供 HUD 在攻击按钮上画进度弧。 */
  getComboState(): { stacks: number; max: number } {
    return { stacks: this.comboStacks, max: this.equipment.weaponStats().comboMax };
  }

  private updatePlayerMovement(delta: number, rawMovement: Vec2, isMoving: boolean): void {
    if (!isMoving) return;
    this.noteActivity();
    const movement = normalize(rawMovement);
    this.player.facing = movement;
    /*
     * 搬运惩罚和空手加速，两者互斥 —— 军用肩带管返程（扛着的时候），
     * 熟门熟路管去程（空手跑去找下一桶）。见 balance/fuelPerks.ts。
     */
    const carryingPenalty = this.player.carrying
      ? this.fuelPerks.carryScale()
      : this.fuelPerks.emptyRunScale();
    const needsPenalty = this.player.hunger < 12 || this.player.water < 12 ? 0.84 : 1;
    // 武器与护甲的移速系数相乘。全重装（砍刀Ⅲ + 铁甲Ⅲ）是 0.92 × 0.88 = 0.810
    // → 6.64，全轻装是 1.06 × 1.09 = 1.155 → 9.47，差 43%。
    // 守油大狼发现玩家后会短程冲刺；全重装不能再无伤拉着它们绕地形，
    // 轻装仍能靠机动脱离，装备选择因此有明确取舍。
    const gearScale = this.equipment.weaponStats().moveScale * this.equipment.armorStats().moveScale;
    const speed = 8.2 * carryingPenalty * needsPenalty * gearScale * this.survival.conditionSpeedScale();
    this.collision.moveEntity(this.player, movement.x * speed * delta, movement.z * speed * delta, PLAYER_RADIUS, true);
  }

  requestThermalAction(): void {
    this.survival.requestThermalAction();
  }

  /**
   * 给奖励系统用的三轴回复口（后座补给、见血回神）。
   *
   * 走这里而不是让子系统直接碰 player，是为了把封顶这件事收在一处 ——
   * 五项最大值都是 100，而"回复能把人从死亡线上拽回来"是错的顺序，
   * 所以这里也不复活：health <= 0 的那一帧交给 update 末尾的死亡判定。
   */
  restoreNeeds(health: number, water: number, hunger: number): void {
    const player = this.player;
    if (health > 0) player.health = Math.min(player.health + health, player.maxHealth);
    if (water > 0) player.water = Math.min(player.water + water, 100);
    if (hunger > 0) player.hunger = Math.min(player.hunger + hunger, 100);
  }

  // ── 搬油三选一的取值口。真相全在 fuelPerks，这里只做转发。 ──
  perkBonusDefense(): number { return this.fuelPerks.bonusDefense(); }
  perkDecayScale(): number { return this.fuelPerks.decayScale(); }
  perkBonusStaminaRegen(): number { return this.fuelPerks.bonusStaminaRegen(); }
  notePerkFuelLoaded(loaded: number, required: number): void {
    this.fuelPerks.noteFuelLoaded(loaded, required);
  }

  /** HUD 读这次给哪三张；没有待选时返回 null。 */
  getFuelPerkOffer(): readonly FuelPerkId[] | null { return this.fuelPerks.pendingOffer(); }
  /** HUD 把选择送回来校验。不在本次 offer 里会被拒绝。 */
  chooseFuelPerk(id: FuelPerkId): boolean { return this.fuelPerks.choose(id); }
  fuelPerkStacks(id: FuelPerkId): number { return this.fuelPerks.stacksOf(id); }

  /** 场上还有没有活着的守巢狼。清巢老手（den-breaker）靠它决定要不要发。 */
  hasLivingGuards(): boolean {
    return this.wolves.some((wolf) => wolf.role === "guard" && wolf.mode !== "dead");
  }

  getAttackPower(): number {
    return this.equipment.attackPower();
  }

  getDefense(): number {
    return this.equipment.defense();
  }

  getRestBlocker(): LocalizedText | null {
    return this.survival.restBlocker();
  }

  /** 端口成员，见 emit()。 */
  noteActivity(): void {
    // 教学期间只清静止计时、不点时钟：第一步就是教移动，不挡的话教学越完整死得越快。
    if (!this.tutorialHold) this.clockStarted = true;
    this.player.idleTime = 0;
    this.survival.setResting(false);
  }

  /**
   * 原地动作：只启动时钟，**不打断休息、不清空静止计时**。
   * 吃喝和合成都是站着不动就能做的事 —— 把它们算成"活动"会让玩家
   * 每喝一口水就被踢出休息、还要再站满 5 秒，劳力等于回不上来。
   */
  /** 端口成员，见 emit()。 */
  noteInPlaceAction(): void {
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





  /** 端口成员，见 emit()。 */
  createDrop(position: Vec2, kind: InventoryItemKind, angleOffset: number, count = 1): void {
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

  /** LOD 错峰用的帧计数。 */

  /**
   * 出生点侧后方那一根教学枯木（见 TUTORIAL_WOOD_* 的注释）。
   *
   * 直接追加进 this.items，不进 world.initialItems —— 后者被 retreatNavigations
   * 拿去建撤退流场（只筛石头），也被别的只读用途共享，往里塞东西等于改世界定义。
   * 未放置的枯木不参与碰撞（isBlockingGroundItem 只认石头和 placed），所以它
   * 不会在出生点旁边立起一堵墙。
   */
  /**
   * 柴进包的**唯一**汇合点，用来喂 ObjectiveNarrator 的第 0 阶。
   *
   * 挂在 addInventory 上而不是挂在那两处 pickup 事件旁边：调用点会长出第三处
   * （现在是地面拾取和砍树两条），漏挂一处不会报错，只会让目标行悄悄停在上一阶。
   * `running` 这道闸是关键 —— 开局口粮在构造函数里就发了，那时 running 还是 false，
   * 而"口粮里的柴不算他捡的"正是这一整条修复的全部内容。
   */
  private noteWoodIntake(kind: InventoryItemKind): void {
    if (kind === "wood" && this.running) this.objectives.noteWoodGathered();
  }

  private addTutorialWood(): void {
    const angle = this.spawnFacing + TUTORIAL_WOOD_SPREAD;
    const spot = this.collision.findNearestWalkablePoint({
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
      this.objectives.objectiveStage = 3;
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
    this.objectives.resetDuskWarning();
    this.wolfDirector.beginDay();
    this.events.push({ type: "phase", phase: "day", day: this.day });
    this.events.push({ type: "message", key: "msg.43" });
  }

  /** 即将到来的那一夜有多长 —— 黄昏算燃料够不够用得上。 */
  /** 端口成员，见 emit()。 */
  getComingNightDuration(): number {
    return this.day === 1 ? FIRST_NIGHT_DURATION : this.day === 2 ? SECOND_NIGHT_DURATION : LATER_NIGHT_DURATION;
  }

  /** 端口成员，见 emit()。 */
  isEntranceBlocked(camp: CampDefinition): boolean {
    const entrance = campGatePosition(camp);
    return this.items.some((item) => item.active && item.placed && item.kind === "stone" && distanceSquared(item, entrance) < 3.6 * 3.6);
  }

  getInventorySpace(kind: InventoryItemKind): number {
    return this.inventory.space(kind);
  }

  private addInventory(kind: InventoryItemKind, count: number): boolean {
    // 背包满时 add 返回 false，什么也没进包 —— 那一下不算"他捡到了柴"。
    if (!this.inventory.add(kind, count)) return false;
    this.noteWoodIntake(kind);
    return true;
  }

  /** InventorySystem 的入包钩子。装备解锁的判定挂在这一处，理由见那边的端口注释。 */
  onItemAcquired(kind: InventoryItemKind): void {
    this.equipment.noteAcquired(kind);
  }

  /**
   * 子系统统一的事件出口。HUD 每帧用 drainEvents() 取走。
   *
   * 公开是因为它是**端口成员** —— 抽出去的子系统通过接口调它，而 TypeScript 的
   * 结构化类型不认 private。下面几个标了「端口」的方法同理。
   */
  emit(event: GameEvent): void {
    this.events.push(event);
  }

  /** EquipmentSystem 的端口：身边有没有点着的火。 */
  hasLitFireNearby(): boolean {
    return this.findNearestLitFire(FIRE_WARMTH_RADIUS) !== null;
  }

  /** EquipmentSystem 的端口：换了武器，上一把剑攒的连击层数不该跟着走。 */
  onWeaponChanged(): void {
    this.comboStacks = 0;
    this.comboTargetKey = null;
    this.events.push({ type: "combo", stacks: 0 });
  }

  private removeInventory(kind: InventoryItemKind, count: number): void {
    this.inventory.remove(kind, count);
  }

  private removeFromSlot(index: number, count: number): void {
    this.inventory.removeFromSlot(index, count);
  }

  /** 端口成员，见 emit()。 */
  findNearestCamp(maxDistance: number): CampDefinition | null {
    return nearest(this.world.camps, this.player, maxDistance);
  }

  private findNearestItem(maxDistance: number): GroundItem | null {
    return nearest(this.items, this.player, maxDistance, { accept: (item) => item.active });
  }

  private findNearestCactus(maxDistance: number): CactusPatch | null {
    return nearest(this.cacti, this.player, maxDistance, { accept: (patch) => patch.juice > 0 });
  }

  /** 射程内还有柴的树；砍空的树桩不再返回。 */
  private findNearestTree(maxDistance: number): TreeState | null {
    return nearest(this.trees, this.player, maxDistance, { accept: (tree) => tree.wood > 0 });
  }

  private findNearestIron(maxDistance: number): IronNode | null {
    return nearest(this.ironNodes, this.player, maxDistance, { accept: (node) => node.ore > 0 });
  }

  private dropCarriedItem(): void {
    const kind = this.player.carrying;
    if (!kind) return;
    const dropPosition = {
      x: this.player.x + this.player.facing.x * 2.05,
      z: this.player.z + this.player.facing.z * 2.05,
    };
    if (kind === "fuel") {
      const barrel = this.truckSystem.carriedBarrel;
      if (!barrel) {
        this.player.carrying = null;
        return;
      }
      barrel.x = dropPosition.x;
      barrel.z = dropPosition.z;
      barrel.rotation = Math.atan2(this.player.facing.z, this.player.facing.x);
      barrel.placement = "ground";
      this.truckSystem.carriedBarrel = null;
      this.player.carrying = null;
      this.events.push({ type: "drop", kind });
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
    return nearest(this.structures, this.player, maxDistance, { accept: (s) => s.active });
  }

}
