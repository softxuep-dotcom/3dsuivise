import {
  clamp,
  direction,
  distance,
  distanceSquared,
  dot,
  mulberry32,
  normalize,
  segmentIntersectsCircle,
  TAU,
} from "./geometry";
import { campGatePosition, isTerrainWalkable, terrainHeightAt, terrainSlopeAt } from "../terrain/TerrainModel";
import { NavigationGrid } from "./NavigationGrid";
import type {
  CactusPatch,
  CritterKind,
  CritterState,
  CampKind,
  CampDefinition,
  CampState,
  DeathCause,
  GameEvent,
  GroundItem,
  InteractionHint,
  ArmorKind,
  WeaponKind,
  IronNode,
  WellState,
  PlacedStructure,
  StructureKind,
  InventoryItemKind,
  Phase,
  PlayerState,
  SurvivalCondition,
  Vec2,
  WolfKind,
  WolfRole,
  WolfState,
  WorldDefinition,
  WorldDrop,
} from "./types";
import { CRITTER_SPECS, INVENTORY_CAPACITY, INVENTORY_STACK_LIMITS, STRUCTURE_SPECS } from "./types";

const PLAYER_RADIUS = 0.72;
const WOLF_RADIUS = 0.68;
const FIRST_DAY_DURATION = 90;
const FIRST_NIGHT_DURATION = 150;
const LATER_DAY_DURATION = 180;
const SECOND_NIGHT_DURATION = 180;
const LATER_NIGHT_DURATION = 180;
const MAX_WOLVES = 120;
/** 地形拒绝整步移动时依次尝试的缩短比例，见 stepAxis()。 */
const MOVE_STEP_FALLBACKS = [1, 0.5, 0.25];
/** 挨打后多少秒内不能休息（原本是"附近有狼"，夜里几乎恒为真）。 */
const REST_COMBAT_LOCK = 6;

const ITEM_LABELS: Record<InventoryItemKind, string> = {
  "cactus-juice": "仙人掌汁",
  "raw-meat": "生肉",
  "cooked-meat": "熟肉",
  hide: "兽皮",
  "iron-ore": "铁矿",
  water: "水",
  "wash-water": "洗脸水",
  wood: "枯木",
};

export interface EquipTier {
  id: string;
  label: string;
  cost: Array<[InventoryItemKind, number]>;
  needsFire: boolean;
  blurb: string;
  attack?: number;
  defense?: number;
}

/** 武器三阶。第 3 阶的兽皮开销刻意压得重 —— 兽皮只从狼身上掉。 */
const WEAPON_TIERS: EquipTier[] = [
  { id: "survival-knife", label: "求生匕首", cost: [], needsFire: false, blurb: "" },
  { id: "iron-spear", label: "粗铁矛", cost: [["iron-ore", 3], ["hide", 1]], needsFire: true, blurb: "攻击+18，攻程更远", attack: 18 },
  { id: "fang-spear", label: "狼牙重矛", cost: [["iron-ore", 5], ["hide", 3]], needsFire: true, blurb: "攻击+16，攻程再进一步", attack: 16 },
];

const ARMOR_TIERS: EquipTier[] = [
  { id: "none", label: "粗布衣", cost: [], needsFire: false, blurb: "" },
  { id: "leather", label: "兽皮衣", cost: [["hide", 4]], needsFire: false, blurb: "防御+4", defense: 4 },
  { id: "reinforced", label: "镶铁重甲", cost: [["hide", 6], ["iron-ore", 4]], needsFire: true, blurb: "防御+7，移速-5%", defense: 7 },
];

/**
 * 武器手感表。原先用 `weapon === "iron-spear" ? a : b` 判断，第 3 阶加进来之后
 * 会掉进 else 分支拿到匕首的攻程（3.1，比 T2 的 3.8 还短）—— 换表消除这个隐患。
 * 攻程随阶数变长，冷却也变长：重矛打得狠、够得远，但挥得慢。
 */
const WEAPON_STATS: Record<WeaponKind, { cooldown: number; range: number }> = {
  "survival-knife": { cooldown: 0.50, range: 3.1 },
  "iron-spear": { cooldown: 0.58, range: 3.8 },
  "fang-spear": { cooldown: 0.62, range: 4.2 },
};

/** 镶铁重甲的负重：换来 11 点防御，代价是 5% 移速。 */
const REINFORCED_ARMOR_SPEED = 0.95;

// 肉的两级。生肉顶饿不回体力，烤肉才回 —— 烤肉的价值全在体力那一条上。
const RAW_HUNGER: readonly [number, number] = [12, 18];
const RAW_WATER: readonly [number, number] = [2, 6];
const COOKED_HUNGER: readonly [number, number] = [26, 38];
const COOKED_WATER: readonly [number, number] = [5, 10];
const COOKED_HEALTH = 14;

// 洗脸水，对齐原图 I01V（触发器 047）：体温 -25~-50、水分 +10~25。
const WASH_WATER_COOLING: readonly [number, number] = [25, 50];
const WASH_WATER_HYDRATION: readonly [number, number] = [10, 25];
/** Dawn withdrawal cadence: small packs peel away instead of the whole raid vanishing at once. */
const RETREAT_BATCH_SIZE = 5;
const RETREAT_BATCH_INTERVAL = 2.4;
const RETREAT_WITHIN_BATCH_STAGGER = 0.22;

// --- 体温调节动作（移植自原图 A02B 尿 / A06M 活埋）---
// 原图的降温主力从来不是喝水（饮品只给 -5~12），而是这类**零资源消耗**的动作。
// 它们的存在保证了玩家再穷也有自救手段，不会被锁死在中暑/失温里。
//
// 冷却 40 → 120 秒。原图用**劳力成本**（尿 10、活埋 15）限制它们，我们改成零消耗 +
// 长冷却，那冷却就必须真的长：40 秒时一个白天能按三次，把中暑线从 123 秒推到 188 秒，
// 而白天只有 180 秒 —— 等于零代价地抹掉了"白天必定中暑"这条压力，洗脸水和喝水降温
// 全都失去存在理由。120 秒把它压回**每相位一次**的自救阀门：白天中暑推迟到 145 秒、
// 夜里失温推迟到 95 秒，两者都仍然会在相位内发生。
//
// 90 秒以上其实结果相同（舒适区门槛卡着，第二次永远来不及按），取 120 是为了留出余量，
// 又不像 180 那样让白天用掉的那次连夜里也一起锁死。
const COOL_ACTION_WARMTH = 15;    // 原图 A02B 尿：固定 -15
const COOL_ACTION_COOLDOWN = 120;
const WARM_ACTION_WARMTH = 25;    // 原图 A06M 活埋：固定 +25
const WARM_ACTION_COOLDOWN = 120;
/** 落在这个区间内两个方向都不给按，避免玩家在舒适区里空转 CD。 */
const THERMAL_COMFORT_LOW = 35;
const THERMAL_COMFORT_HIGH = 62;

// --- 仙人掌汁：对齐原图 I00B（触发器 006________11）的随机区间 ---
const JUICE_WATER: readonly [number, number] = [8, 16];
const JUICE_HUNGER: readonly [number, number] = [1, 5];
const JUICE_WARMTH: readonly [number, number] = [5, 10];
const DROP_LIFETIME = 180;

// ============================================================================
// 五轴生存模型 —— 移植自《荒漠幸存者》，详见 docs/荒漠幸存者-数值分析.md
//
//   体力(health)  恒定流失，是"该吃饭了"的硬心跳
//   劳力(stamina) 采集与攻击的预算，休息回得快、行动回得慢
//   体温(warmth)  白天有地板、夜晚有天花板 ⇒ 中暑只在白天、失温只在夜晚
//   水分(water)   归零立即死亡
//   饥饿(hunger)  归零立即死亡
//
// 原图昼夜周期 750 秒，我们是 240~255 秒，所以速率不是简单等比缩放，
// 而是按"在一个昼夜内应该发生几次危机"重新配平，偏离处见下方注释。
// ============================================================================

// --- 体温 ---
const WARMTH_MIN = 0;
const WARMTH_MAX = 100;
const WARMTH_INITIAL = 22;
/** 白天地板：低于此值会被拉回，所以白天冻不死。（原图 15） */
const WARMTH_DAY_FLOOR = 15;
/** 夜晚天花板：高于此值会被压回，所以夜晚中不了暑。（原图 80） */
const WARMTH_NIGHT_CEILING = 80;
/** 中暑触发/解除阈值，迟滞避免在边界反复横跳。（原图 100 / 95） */
const WARMTH_HEAT_ENTER = 100;
const WARMTH_HEAT_EXIT = 92;
/** 失温触发/解除阈值。（原图 5 / 5，我们放宽解除以免瞬间反复） */
const WARMTH_COLD_ENTER = 5;
const WARMTH_COLD_EXIT = 14;
// 昼夜各 180 秒，与原图的 375/375 同为对称结构，所以时间压缩系数是全局统一的
// ×2.083（= 750/360）。下面三条体温速率都是原图值 ×2.083 得来，
// 结果是各阶段占相位的比例与原图完全一致，见 docs/复盘-与原图对照.md。
/** 白天 +0.69/s：从白天地板 15 爬到中暑线 100 需 123 秒，占白天的 68% —— 白天必定中暑。 */
const WARMTH_DAY_BASE = 0.69;
/**
 * 夜间 -1.05/s：从天花板 80 掉到失温线 5 需 71 秒，占夜晚的 40%。
 *
 * 这一条**故意偏离** ×2.083 的等比换算（严格换算是 1.39）。原因是时间压缩保住了
 * 比例却保不住手感：原图夜损 0.667 给玩家 118 秒的外出窗口，等比压缩后只剩 54 秒 ——
 * 比例同样是三成，但人做决策、导航、应对突发所需要的是**绝对秒数**，它不随游戏时钟缩放。
 * 54 秒的窗口玩家根本不敢出门，夜晚就退化成"蹲在火边发呆"。
 * 所以换算规则在这里有例外：凡是玩家必须在其内做出反应的时长，都要额外放宽。
 */
const WARMTH_NIGHT_LOSS = 1.05;
// 劳作产热已移除。原图（荒漠幸存者）根本没有这一项，而我们曾把它设成 +0.9/s
// —— 是白天基线的 2.7 倍，直接导致"正常采集必然中暑且无法自救"。
/** 篝火 +3.16/s：夜晚静止净 +1.77/s，约 45 秒从 0 回满到天花板 80。 */
const WARMTH_FIRE_GAIN = 3.16;
/**
 * 篝火有效半径 10.0。
 * 原图火窖的光环 `A03Z` 半径是 320 游戏单位；按移速换算（原图英雄 240 / 我们 8.2，
 * 约 29.3 单位 = 1 米）折合 **10.9 米**，我们此前只有 5.5，不到一半。
 * 放大之后语义从"必须贴着火站"变成"待在营地里就算烤着火" —— 这正是原图的行为，
 * 也让添柴、烤肉、升级装备这些营地事务不必再挤在火堆脚下完成。
 */
const FIRE_WARMTH_RADIUS = 10.0;

// --- 体力：恒定流失（原图 600HP / -0.7/s ≈ 857 秒） ---
const HEALTH_DECAY = 0.24; // 100 / 0.24 ≈ 417 秒 ≈ 1.16 个昼夜（原图 857/750 = 1.14）

// --- 水分与饥饿（原图两者都是 -0.2/s，满值 500 秒） ---
const WATER_DECAY = 0.42;  // 238 秒 ≈ 0.66 个昼夜（原图 500/750 = 0.67）
const HUNGER_DECAY = 0.42; // 238 秒 ≈ 0.66 个昼夜（原图同水分，两轴等速）
/** 水分低于此值时，取水会抢占所有其它交互，避免玩家被拾取挡着渴死。 */
const WATER_URGENT = 32;

// --- 劳力（原图 225 上限、几乎不回复，靠睡觉补） ---
const STAMINA_MAX = 100;
const STAMINA_REST_REGEN = 7.5;   // 休息中
const STAMINA_IDLE_REGEN = 1.6;   // 站着不动但没进入休息
const STAMINA_ACTIVE_REGEN = 1.1; // 移动中：仍只有休息的 1/7，但走路不再是完全的死区
                                  // （0.5 时走满全图 200 秒才回满，而游戏大部分时间在走）
const STAMINA_COST_CACTUS = 10;
const STAMINA_COST_MINE = 15;
/**
 * 捡一根枯木 30 劳力。
 * 木头进背包之后，原来"双手被占、一次一根、不能攻击"这三条约束同时消失，
 * 木头会变成免费无限。原图用采集成本接住稀缺性（砍一根 150 劳力 / 满值 225，
 * 一管只够 1.5 根），我们按量程缩到 30 —— 一管三根，而一夜要烧两根。
 */
const STAMINA_COST_WOOD = 30;
/**
 * 随身枯木每根 +2 攻击，最多两根生效。
 * 抄自原图 I00E「一块木头。增加 5 点的攻击力」—— 背包里的材料同时是个边际武器，
 * 占那一格才有回报，否则玩家只会觉得被收了格子税。
 */
const WOOD_ATTACK_BONUS = 2;
const WOOD_ATTACK_CAP = 2;   // 20 → 15：两级武器共需 8 块铁 = 原先两整管劳力的站桩
const STAMINA_COST_DRAW = 8;
const STAMINA_COST_ATTACK = 4;
/** 劳力低于此值时攻击仍可挥出，但伤害衰减到 EXHAUSTED_DAMAGE_SCALE。 */
const STAMINA_EXHAUSTED = STAMINA_COST_ATTACK;
const EXHAUSTED_DAMAGE_SCALE = 0.6;

// --- 水源：两级结构 ---
//   仙人掌：位置随机、产量有限，一刀即得 —— 沿途顺手补给
//   干枯的井：地图上预置的固定水源，必得但要走一趟 —— 规划路线的锚点
// 原图是「建造干枯的井」+「提水」两级技能，我们省掉建造直接预置几口井。
// 因此井是**地标**：它不产生"挖不挖"的赌博，而产生"今晚在哪过夜"的空间决策。
const WELL_DRAW_SECONDS = 2.6;
/** 井口有效交互半径。 */
const WELL_REACH = 3.2;
/** 每口井的蓄水上限，以及回蓄一次所需秒数。 */
const WELL_CHARGES_MAX = 3;
/**
 * 井的初始存量只有 1 格，不是满的。
 * 原图的井是多人分摊、而且要自己造（木头+石头+石头）；我们是单人还白送 5 口，
 * 所以必须在别处收紧。开局满存量意味着白送 20 份水 = 3.4 个昼夜，
 * 而一局才 2~3 天 —— 那样缺水压力整局都不会出现。
 * 回蓄速度没动：逛 1 口井覆盖需求的 29%、逛 2 口 59%，剩下的交给仙人掌和骆驼水。
 */
const WELL_CHARGES_INITIAL = 1;
// 210 秒 = 一口井每昼夜再生 1.7 格，只覆盖一个玩家约 30% 的饮水需求，
// 和原图（500 容量 / +0.1/s ⇒ 1.5 次提水每昼夜）的比例一致。
// 曾经是 50 秒，那意味着单独一口井就够你活，井的空间决策等于不存在。
const WELL_REFILL_SECONDS = 210;
const WATER_RESTORE = 26;
/** 一份水降 14 点体温：正好能把刚中暑的 100 拉到解除线 92 以下。 */
const WATER_WARMTH_COST = 14;

// --- 终局 ---
/** 累计击杀达标后头狼出场。（原图狼王需要 250 杀，按我们 3~4 夜的体量缩到 40） */
const ALPHA_KILL_REQUIREMENT = 40;

const CAMP_LABELS: Record<CampKind, string> = {
  "windy-ridge": "风蚀台地",
  "deep-cave": "岩壁洞窟",
  "abandoned-camp": "废弃营地",
};

export class GameSimulation {
  readonly world: WorldDefinition;
  readonly camps: CampState[];
  readonly items: GroundItem[];
  readonly cacti: CactusPatch[];
  readonly ironNodes: IronNode[];
  readonly wells: WellState[];
  readonly structures: PlacedStructure[] = [];
  readonly player: PlayerState;
  readonly wolves: WolfState[] = [];
  readonly critters: CritterState[] = [];
  readonly drops: WorldDrop[] = [];

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
  private wolfId = 0;
  private critterId = 0;
  private critterRespawnCountdown = 4;
  private dropId = 0;
  private spawnCountdown = 3;
  private spawnedThisNight = 0;
  private navigationCountdown = 0;
  private wildRespawnCountdown = 0;
  /** 本帧玩家是否在移动 —— 劳作产热的输入。 */
  /** 挨打后的休息封锁倒计时，见 REST_COMBAT_LOCK。 */
  private combatTimer = 0;
  /** 当前正在提水的井 id，-1 表示没有。 */
  private drawingWellId = -1;
  private structureId = 0;
  /** 生肉不回体力这条只在第一次生吞时说一遍，之后靠目标行常驻。 */
  private rawMeatHintSent = false;
  /** 体温调节动作的冷却（公开给 HUD 显示）。 */
  coolCooldown = 0;
  warmCooldown = 0;
  private objectiveStage = 0;
  private gameOverSent = false;
  private duskWarningSent = false;
  private largeWolfAnnounced = false;
  private alphaSpawned = false;
  /** 头狼被击杀后置位，胜利结算只跑一次。 */
  private victorySent = false;
  // 死因记录，供 UI 显示游戏结束文案
  deathCause: DeathCause | null = null;
  won = false;

  constructor(world: WorldDefinition) {
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
      navigation.rebuild(target);
      return navigation;
    });
    const startCamp = world.camps[world.startCampId];
    this.camps = world.camps.map((camp) => ({ id: camp.id, fuel: camp.id === world.startCampId ? 42 : 0 }));
    this.items = world.initialItems.map((item) => ({ ...item }));
    this.cacti = world.initialCacti.map((patch) => ({ ...patch }));
    this.ironNodes = world.ironNodes.map((node) => ({ ...node }));
    this.wells = world.wells.map((well) => ({ id: well.id, charges: WELL_CHARGES_INITIAL, refillAt: 0 }));
    this.player = {
      x: startCamp.x,
      z: startCamp.z + 1.5,
      facing: { x: 0.7, z: 0.7 },
      health: 100,
      maxHealth: 100,
      attack: 28,
      defense: 2,
      warmth: WARMTH_INITIAL,
      hunger: 82,
      water: 90,
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
      gatherTimer: 0,
      kills: 0,
    };
    this.navigation.rebuild(this.player);
    this.seedCritters();
  }

  start(): void {
    this.running = true;
    this.events.push({ type: "message", text: "首次移动后开始计时 · 天黑前添柴并封住入口" });
  }

  update(deltaSeconds: number, movement: Vec2): void {
    if (!this.running) return;
    const delta = Math.min(deltaSeconds, 0.05);
    this.player.attackCooldown = Math.max(0, this.player.attackCooldown - delta);
    this.player.attackFlash = Math.max(0, this.player.attackFlash - delta);
    this.player.hurtFlash = Math.max(0, this.player.hurtFlash - delta);
    const isMoving = Math.hypot(movement.x, movement.z) >= 0.08;
    this.updatePlayerMovement(delta, movement, isMoving);
    if (!this.clockStarted) return;

    this.elapsed += delta;
    this.phaseTime -= delta;
    this.combatTimer = Math.max(0, this.combatTimer - delta);
    this.coolCooldown = Math.max(0, this.coolCooldown - delta);
    this.warmCooldown = Math.max(0, this.warmCooldown - delta);
    if (!isMoving) this.player.idleTime += delta;
    this.navigationCountdown -= delta;
    if (this.navigationCountdown <= 0) {
      this.navigation.rebuild(this.player);
      this.navigationCountdown = 0.65;
    }

    this.updateNeeds(delta);
    this.updateWaterGather(delta);
    this.updateFires(delta);
    this.updateCacti();
    this.updateWells();
    this.updateDrops();
    this.updateCritters(delta);
    this.updateWolves(delta);
    this.updateRest(delta);
    this.updateObjectives();

    if (this.phaseTime <= 0) this.advancePhase();

    // 游戏结束判定：水分或饥饿归零立即死亡（移植自原图触发器 002），生命归零为战斗/衰竭死。
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
        // 血归零有两条完全不同的路：被狼咬死，或者体力恒定流失把你耗干
        // （0.24/s，417 秒不吃不休就见底，全程可以一只狼都没碰到）。
        // 混成一个"被狼撕碎"会让玩家完全学不到自己其实是没吃饭死的。
        this.endGame(this.combatTimer > 0 ? "killed" : "exhausted");
      }
    }
  }

  /** 死亡瞬间的瘫痪状态，供结算文案指出真正的死因链。 */
  deathCondition: SurvivalCondition = "normal";

  private endGame(cause: DeathCause): void {
    this.deathCondition = this.player.condition;
    this.setResting(false);
    this.running = false;
    this.gameOverSent = true;
    this.deathCause = cause;
    this.events.push({ type: "game-over" });
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
    if (!this.running) return;
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

    if (this.player.carrying) {
      this.dropCarriedItem();
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

    const item = this.findNearestItem(2.5);
    if (item) {
      if (item.kind === "wood") {
        if (!this.spendStamina(STAMINA_COST_WOOD, "捡枯木")) return;
        if (!this.addInventory("wood", 1)) {
          this.player.stamina = Math.min(this.player.maxStamina, this.player.stamina + STAMINA_COST_WOOD);
          this.events.push({ type: "message", text: "背包已满 · 放不下枯木" });
          return;
        }
      } else {
        this.player.carrying = item.kind;
      }
      item.active = false;
      this.events.push({ type: "pickup", kind: item.kind });
      return;
    }

    const cactusPatch = this.findNearestCactus(2.7);
    if (cactusPatch) {
      this.harvestCactus(cactusPatch);
      return;
    }

    const ironNode = this.findNearestIron(2.8);
    if (ironNode) {
      if (!this.spendStamina(STAMINA_COST_MINE, "挖矿")) return;
      if (!this.addInventory("iron-ore", 1)) {
        this.events.push({ type: "message", text: "背包已满" });
        return;
      }
      ironNode.ore -= 1;
      this.events.push({ type: "pickup", kind: "iron-ore" });
      this.events.push({ type: "message", text: "获得铁矿 · 可在燃烧的篝火旁制作粗铁矛" });
      return;
    }

    const well = this.findNearestWell(WELL_REACH);
    if (well) {
      this.beginWaterDraw(well);
      return;
    }
  }

  /**
   * 火塘之外还有没有更近的可交互目标。
   * 采集类目标的判定半径都在 3.2 米以内，火塘却有 10 米 —— 不比距离的话，
   * 营地范围内的拾取、割仙人掌、挖矿、提水会被添柴全部吃掉。
   */
  private hasNearerTarget(hearthDistance: number): boolean {
    const item = this.findNearestItem(2.5);
    if (item && distance(this.player, item) < hearthDistance) return true;
    const cactus = this.findNearestCactus(2.7);
    if (cactus && distance(this.player, cactus) < hearthDistance) return true;
    const iron = this.findNearestIron(2.8);
    if (iron && distance(this.player, iron) < hearthDistance) return true;
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
   * 劳力是本作对"无限点击采集"的唯一约束，移植自原图砍木头 150 魔法的设计。
   */
  private spendStamina(cost: number, label: string): boolean {
    if (this.player.stamina < cost) {
      this.events.push({ type: "exhausted" });
      this.events.push({ type: "message", text: `劳力不足 · ${label}需要 ${cost} 点，站着不动可以恢复` });
      return false;
    }
    this.player.stamina -= cost;
    return true;
  }

  /** 割仙人掌取汁：一刀即得，代价是劳力和"你得先找到它"。 */
  private harvestCactus(patch: CactusPatch): void {
    if (!this.spendStamina(STAMINA_COST_CACTUS, "割仙人掌")) return;
    if (!this.addInventory("cactus-juice", 1)) {
      this.events.push({ type: "message", text: "背包已满" });
      return;
    }
    patch.juice -= 1;
    if (patch.juice === 0) patch.regrowAt = this.elapsed + 180;
    this.events.push({ type: "pickup", kind: "cactus-juice" });
  }

  /** 从井里提水：必得，但要站定 2.6 秒，且这口井的存量会被扣掉。 */
  private beginWaterDraw(well: WellState): void {
    if (this.player.gatherTimer > 0) return;
    if (this.getInventoryCount("water") >= INVENTORY_STACK_LIMITS.water * 2) {
      this.events.push({ type: "message", text: "水已经带够了" });
      return;
    }
    if (!this.spendStamina(STAMINA_COST_DRAW, "提水")) return;
    this.player.gatherTimer = WELL_DRAW_SECONDS;
    this.drawingWellId = well.id;
    this.events.push({ type: "draw-water" });
  }

  /**
   * 提水结算。与旧的挖沙不同，这里**没有失败概率** —— 井就是井，
   * 代价是它有存量、要走过去、而且回蓄很慢。用空间和时间换掉了随机挫败感。
   */
  private updateWaterGather(delta: number): void {
    if (this.player.gatherTimer <= 0) return;
    this.player.gatherTimer -= delta;
    if (this.player.gatherTimer > 0) return;
    this.player.gatherTimer = 0;
    const well = this.wells.find((entry) => entry.id === this.drawingWellId);
    this.drawingWellId = -1;
    if (!well || well.charges <= 0) {
      this.events.push({ type: "message", text: "这口井已经见底了" });
      return;
    }
    if (!this.addInventory("water", 1)) {
      this.events.push({ type: "message", text: "背包已满 · 水又倒回井里了" });
      return;
    }
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
    if (!this.running || this.player.attackCooldown > 0 || this.player.carrying) return;
    this.noteActivity();
    // 劳力不足不会禁止挥砍，但伤害衰减到 60%，"脱力"是可感知的惩罚而不是硬锁。
    const exhausted = this.player.stamina < STAMINA_EXHAUSTED;
    if (exhausted) this.events.push({ type: "exhausted" });
    else this.player.stamina = Math.max(0, this.player.stamina - STAMINA_COST_ATTACK);
    const baseCooldown = WEAPON_STATS[this.player.weapon].cooldown;
    this.player.attackCooldown = baseCooldown * this.getConditionCooldownScale();
    this.player.attackFlash = 0.22;
    this.events.push({ type: "attack" });
    let hit = false;

    const attackRange = WEAPON_STATS[this.player.weapon].range;
    // 转向辅助优先锁狼：猎物不还手，被狼咬着还去追兔子才是真的要命。
    const inRange = <T extends Vec2>(list: T[], alive: (item: T) => boolean): T | undefined => list
      .filter((item) => alive(item) && distanceSquared(this.player, item) <= attackRange * attackRange)
      .sort((a, b) => distanceSquared(this.player, a) - distanceSquared(this.player, b))[0];
    const assistedTarget = inRange(this.wolves, (wolf) => wolf.mode !== "dead")
      ?? inRange(this.critters, (critter) => critter.mode !== "dead");
    if (assistedTarget) this.player.facing = direction(this.player, assistedTarget);
    for (const wolf of this.wolves) {
      if (wolf.mode === "dead" || distanceSquared(this.player, wolf) > attackRange * attackRange) continue;
      const towardWolf = direction(this.player, wolf);
      if (dot(this.player.facing, towardWolf) < -0.15) continue;
      const wasRetreating = wolf.mode === "retreating";
      const needsMultiplier = this.player.hunger < 15 || this.player.water < 15 ? 0.8 : 1;
      const staminaMultiplier = exhausted ? EXHAUSTED_DAMAGE_SCALE : 1;
      const damage = Math.max(1, Math.round(this.getAttackPower() * needsMultiplier * staminaMultiplier) - wolf.defense);
      wolf.health -= damage;
      wolf.hurtFlash = 0.18;
      wolf.provoked = true;
      if (wolf.health <= 0) wolf.mode = "dead";
      else if (!wasRetreating) wolf.mode = "chase";
      wolf.lostTimer = 0;
      hit = true;
      this.events.push({ type: "wolf-hit", wolfId: wolf.id });
      if (wolf.health <= 0) this.killWolf(wolf);
    }

    // 猎物：同一次挥砍也会打到，伤害算法和打狼一致（它们没有护甲）。
    for (const critter of this.critters) {
      if (critter.mode === "dead" || distanceSquared(this.player, critter) > attackRange * attackRange) continue;
      if (dot(this.player.facing, direction(this.player, critter)) < -0.15) continue;
      const needsMultiplier = this.player.hunger < 15 || this.player.water < 15 ? 0.8 : 1;
      const staminaMultiplier = exhausted ? EXHAUSTED_DAMAGE_SCALE : 1;
      // 和打狼走同一个攻击力（含随身枯木加成）—— 否则 HUD 上显示的攻击力
      // 在砍猎物时对不上账。
      critter.health -= Math.max(1, Math.round(this.getAttackPower() * needsMultiplier * staminaMultiplier));
      critter.hurtFlash = 0.18;
      // 挨了一下必然受惊，冲刺条也回满 —— 第一刀没打死就得追。
      critter.mode = "flee";
      critter.sprint = CRITTER_SPECS[critter.kind].sprintSeconds;
      hit = true;
      this.events.push({ type: "critter-hit", critterId: critter.id });
      if (critter.health <= 0) this.killCritter(critter);
    }

    if (this.phase === "night") {
      for (const wolf of this.wolves) {
        if (wolf.mode !== "dead" && distanceSquared(this.player, wolf) < 17 * 17) {
          wolf.mode = "chase";
          wolf.lostTimer = 0;
        }
      }
    }
    if (!hit && this.objectiveStage >= 3) this.events.push({ type: "message", text: "挥空会暴露位置" });
  }

  consumeJuice(): void {
    const slot = this.player.inventory.findIndex((stack) => stack?.kind === "cactus-juice");
    if (slot >= 0) this.useInventorySlot(slot);
  }

  consumeWater(): void {
    const slot = this.player.inventory.findIndex((stack) => stack?.kind === "water");
    if (slot >= 0) this.useInventorySlot(slot);
  }

  consumeWashWater(): void {
    const slot = this.player.inventory.findIndex((stack) => stack?.kind === "wash-water");
    if (slot >= 0) this.useInventorySlot(slot);
  }

  useInventorySlot(index: number): void {
    if (!this.running) return;
    const stack = this.player.inventory[index];
    if (!stack) return;
    this.noteInPlaceAction();

    // 洗脸水（原图 I01V）：降温主力。同样一份水，兑过之后降温效率是直接喝的四倍，
    // 代价是补水少一半 —— 于是"这份水拿来喝还是拿来降温"成了一个真实的取舍。
    if (stack.kind === "wash-water") {
      this.removeFromSlot(index, 1);
      this.player.water = clamp(this.player.water + this.randomInt(...WASH_WATER_HYDRATION), 0, 100);
      this.player.warmth = clamp(this.player.warmth - this.randomInt(...WASH_WATER_COOLING), WARMTH_MIN, WARMTH_MAX);
      this.updateCondition();
      this.events.push({ type: "drink" });
      return;
    }

    // 每种消耗品同时喂多条轴，权重不同 —— 移植自原图的食物表：
    // 肉主要补体力和饥饿，仙人掌汁偏水分，水是纯水分且都要付体温代价。
    // 仙人掌汁：补水为主、少量顶饿，并且和水一样降体温（原图 I00B 就是这么设计的）。
    if (stack.kind === "cactus-juice") {
      // 对齐原图 I00B（触发器 006________11）：水分 +8~16、饥饿 +1~5、体温 -5~-10。
      // 原图所有消耗品都是随机区间而非固定值，所以每次采集的收益是有波动的。
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
      // 烤肉（原图 I03T）：唯一大量回体力的食物，所以它值得为之走一趟火边。
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
        this.events.push({ type: "message", text: "水分已满" });
        return;
      }
      this.removeFromSlot(index, 1);
      this.player.water = clamp(this.player.water + WATER_RESTORE, 0, 100);
      this.player.warmth = clamp(this.player.warmth - WATER_WARMTH_COST, WARMTH_MIN, WARMTH_MAX);
      this.updateCondition();
      this.events.push({ type: "drink" });
      if (this.phase === "night" && this.player.warmth < 32) {
        this.events.push({ type: "message", text: "夜里喝水会更冷 · 靠近篝火" });
      }
      return;
    }
    if (stack.kind === "raw-meat") {
      // 生肉直接就能吃 —— 原图所有的肉都是这样，烤肉是另一个更好的独立物品，
      // 从来不是吃肉的前置。生肉顶饿但**完全不回体力**，这正是烤肉存在的理由：
      // 体力每秒恒定流失，而烤肉是唯一能大量回体力的食物。
      // "现在生吞垫一口，还是留到火边烤了再吃"因此成为一个真实取舍。
      if (this.isNourishmentFull(RAW_HUNGER[1], RAW_WATER[1], 0)) return;
      this.removeFromSlot(index, 1);
      this.player.hunger = clamp(this.player.hunger + this.randomInt(...RAW_HUNGER), 0, 100);
      this.player.water = clamp(this.player.water + this.randomInt(...RAW_WATER), 0, 100);
      this.events.push({ type: "eat", kind: "cooked-meat" });
      // 火就在旁边却生吞 —— 这是提示烤肉最有说服力的一刻：机会正在被浪费。
      if (this.findNearestLitFire(FIRE_WARMTH_RADIUS)) {
        this.events.push({ type: "message", text: `旁边就有火 · 烤了再吃能多回 ${COOKED_HEALTH} 点体力` });
      } else if (!this.rawMeatHintSent) {
        this.rawMeatHintSent = true;
        this.events.push({ type: "message", text: "生肉只顶饿不回体力 · 攒到篝火旁烤熟再吃" });
      }
      return;
    }
    if (stack.kind === "iron-ore") {
      this.events.push({ type: "message", text: this.player.weapon === "iron-spear" ? "已经装备粗铁矛" : "3块铁矿和1张兽皮可制作粗铁矛" });
      return;
    }
    const nextArmor = this.getNextTier("armor");
    this.events.push({ type: "message", text: nextArmor ? `下一阶：${nextArmor.label} · ${nextArmor.blurb}` : "护甲已满级" });
  }

  /** 闭区间随机整数，对应原图的 GetRandomInt。 */
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
   * 装备升级：每个槽位一条线，一次推进一阶，配方读自 WEAPON_TIERS / ARMOR_TIERS。
   *
   * 三阶而不是两阶，是因为狼群数量按 40+(d-1)×15 一路涨到 90，而旧的两件装备
   * 第 2 天就拿全了 —— 威胁曲线继续爬、玩家曲线却平掉，后期就变成一堵墙而不是高潮。
   * 第 3 阶刻意吃兽皮大头：兽皮只从狼身上来，于是"打狼"自己喂养"打狼的能力"。
   */
  craftWeapon(): boolean {
    return this.craftUpgrade(WEAPON_TIERS, this.player.weapon, (next) => {
      this.player.weapon = next.id as WeaponKind;
      this.player.attack += next.attack ?? 0;
      this.events.push({ type: "craft-weapon" });
    });
  }

  craftArmor(): boolean {
    return this.craftUpgrade(ARMOR_TIERS, this.player.armor, (next) => {
      this.player.armor = next.id as ArmorKind;
      this.player.defense += next.defense ?? 0;
      this.events.push({ type: "craft-coat" });
    });
  }

  /** 返回某条装备线的下一阶；已满级返回 null。供 HUD 渲染按钮文案。 */
  getNextTier(line: "weapon" | "armor"): EquipTier | null {
    const tiers = line === "weapon" ? WEAPON_TIERS : ARMOR_TIERS;
    const current = line === "weapon" ? this.player.weapon : this.player.armor;
    const index = tiers.findIndex((tier) => tier.id === current);
    return tiers[index + 1] ?? null;
  }

  private craftUpgrade(tiers: EquipTier[], current: string, apply: (tier: EquipTier) => void): boolean {
    if (!this.running) return false;
    const index = tiers.findIndex((tier) => tier.id === current);
    const next = tiers[index + 1];
    if (!next) return false;
    // 判定半径与取暖、烤肉统一走 FIRE_WARMTH_RADIUS：原先这里单独写死 5.2，
    // 于是"站在营地里就算烤着火"对升级装备这一条不成立。
    if (next.needsFire && !this.findNearestLitFire(FIRE_WARMTH_RADIUS)) {
      this.events.push({ type: "message", text: `${next.label}必须在燃烧的篝火旁制作` });
      return false;
    }
    const missing = next.cost.filter(([kind, count]) => this.getInventoryCount(kind) < count);
    if (missing.length > 0) {
      const need = next.cost.map(([kind, count]) => `${ITEM_LABELS[kind]}×${count}`).join(" + ");
      this.events.push({ type: "message", text: `${next.label}需要 ${need}` });
      return false;
    }
    this.noteInPlaceAction();
    for (const [kind, count] of next.cost) this.removeInventory(kind, count);
    apply(next);
    this.events.push({ type: "message", text: `${next.label}完成 · ${next.blurb}` });
    return true;
  }

  /** 烤肉：生肉 1 份在燃烧的篝火旁烤成熟肉。这是篝火除了取暖之外的第二个用途。 */
  craftCookedMeat(): boolean {
    if (!this.running) return false;
    if (this.getInventoryCount("raw-meat") < 1) {
      this.events.push({ type: "message", text: "没有生肉可烤" });
      return false;
    }
    if (!this.findNearestLitFire(FIRE_WARMTH_RADIUS)) {
      this.events.push({ type: "message", text: "要在燃烧的篝火旁才能烤肉" });
      return false;
    }
    this.noteInPlaceAction();
    this.removeInventory("raw-meat", 1);
    if (!this.addInventory("cooked-meat", 1)) {
      // 生肉必须放回去 —— 刚腾出来的位置一定装得下，否则这一步等于凭空烧掉一块肉。
      this.addInventory("raw-meat", 1);
      this.events.push({ type: "message", text: "背包已满 · 烤好的肉没处放" });
      return false;
    }
    this.events.push({ type: "cook" });
    this.events.push({ type: "message", text: "烤好了 · 熟肉是唯一能大量回体力的食物" });
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
      const need = spec.cost.map(([item, count]) => `${ITEM_LABELS[item]}×${count}`).join(" + ");
      this.events.push({ type: "message", text: `${spec.label}需要 ${need}` });
      return false;
    }
    const spot = {
      x: this.player.x + this.player.facing.x * 2.0,
      z: this.player.z + this.player.facing.z * 2.0,
    };
    const reason = this.getBuildBlocker(kind, spot);
    if (reason) {
      this.events.push({ type: "message", text: `这里放不下${spec.label} · ${reason}` });
      return false;
    }
    if (!this.spendStamina(spec.stamina, `搭${spec.label}`)) return false;

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
    this.events.push({ type: "message", text: `${spec.label}搭好了 · ${spec.blurb}` });
    return true;
  }

  /** 放不下的原因；能放返回 null。 */
  private getBuildBlocker(kind: StructureKind, spot: Vec2): string | null {
    if (!isTerrainWalkable(this.world, spot)) return "地面太陡";
    const spec = STRUCTURE_SPECS[kind];
    for (const other of this.structures) {
      if (!other.active) continue;
      const gap = spec.radius + STRUCTURE_SPECS[other.kind].radius + 0.4;
      if (distanceSquared(spot, other) < gap * gap) return `离已有的${STRUCTURE_SPECS[other.kind].label}太近`;
    }
    for (const wall of this.world.walls) {
      if (distanceSquared(spot, wall) < (wall.radius + spec.radius) ** 2) return "这里有东西挡着";
    }
    return null;
  }

  /** 洗脸水：1 份水兑成 1 份洗脸水，降温效率翻四倍（原图 I01V）。 */
  craftWashWater(): boolean {
    if (!this.running) return false;
    if (this.getInventoryCount("water") < 1) {
      this.events.push({ type: "message", text: "兑洗脸水需要 1 份水" });
      return false;
    }
    if (this.getInventoryCount("wash-water") >= INVENTORY_STACK_LIMITS["wash-water"] * 2) {
      this.events.push({ type: "message", text: "洗脸水带够了" });
      return false;
    }
    this.noteInPlaceAction();
    this.removeInventory("water", 1);
    if (!this.addInventory("wash-water", 1)) {
      // 同烤肉：兑不出来就把那份水还回去，绝不能凭空蒸发。
      this.addInventory("water", 1);
      this.events.push({ type: "message", text: "背包已满 · 洗脸水没处放" });
      return false;
    }
    this.events.push({ type: "craft-wash-water" });
    this.events.push({ type: "message", text: "兑成洗脸水 · 降温 25~50，是直接喝的四倍" });
    return true;
  }

  getInventoryCount(kind: InventoryItemKind): number {
    return this.player.inventory.reduce((total, stack) => total + (stack?.kind === kind ? stack.count : 0), 0);
  }

  getInteractionHint(): InteractionHint {
    if (this.player.gatherTimer > 0) return { action: "well", text: "正在提水…" };
    // 与 requestInteraction 保持一致：水分告急时，仙人掌优先、其次找井。
    if (this.player.water < WATER_URGENT && !this.player.carrying) {
      if (this.findNearestCactus(2.7)) return { action: "cactus", text: `水分告急 · 割仙人掌 · 劳力 ${STAMINA_COST_CACTUS}` };
      const urgentWell = this.findNearestWell(WELL_REACH);
      if (urgentWell) return { action: "well", text: `水分告急 · 提水 · 劳力 ${STAMINA_COST_DRAW}` };
    }
    if (this.player.carrying) {
      return { action: "drop", text: "放下大石 · 一块即可封住窄口" };
    }
    // 与 requestInteraction 同一套优先级：火塘只在比脚边的东西更近时才占住 E。
    if (this.getInventoryCount("wood") > 0) {
      const hearth = this.findNearestHearth(FIRE_WARMTH_RADIUS);
      if (hearth && !this.hasNearerTarget(hearth.distance)) {
        return { action: "feed", text: `添一根枯木 · 火焰延长 95 秒（余 ${this.getInventoryCount("wood")}）` };
      }
    }
    const item = this.findNearestItem(2.5);
    if (item) {
      return item.kind === "wood"
        ? { action: "pickup", text: `拾起枯木入包 · 劳力 ${STAMINA_COST_WOOD}` }
        : { action: "pickup", text: "双手搬起大石" };
    }
    if (this.findNearestCactus(2.7)) return { action: "cactus", text: `割仙人掌取汁 · 劳力 ${STAMINA_COST_CACTUS}` };
    if (this.findNearestIron(2.8)) return { action: "mine", text: `敲取铁矿 · 劳力 ${STAMINA_COST_MINE}` };
    const well = this.findNearestWell(WELL_REACH);
    if (well) return { action: "well", text: `从井里提水 · 劳力 ${STAMINA_COST_DRAW} · 井中余 ${well.charges}` };
    return { action: "none", text: "" };
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

  getCurrentLocationLabel(): string {
    const camp = this.findNearestCamp(14);
    return camp ? CAMP_LABELS[camp.kind] : "无名沙海";
  }

  // getNearestThreat() 已删除：它服务的是那块常驻在屏幕中央的"最近敌人"面板。
  // 夜里地图上几十只狼，24 米内永远有一只顶上来，那块面板等于常年糊在视野正中。
  // 现在普通狼的血量走头顶跟随血条（受伤才亮 2.6 秒），头狼走顶部 BOSS 条。

  getAlpha(): WolfState | null {
    return this.wolves.find((wolf) => wolf.kind === "alpha" && wolf.mode !== "dead") ?? null;
  }

  getAlphaProgress(): { kills: number; required: number; spawned: boolean } {
    return { kills: this.player.kills, required: ALPHA_KILL_REQUIREMENT, spawned: this.alphaSpawned };
  }

  getObjective(): string {
    if (!this.clockStarted) return "移动或拿起枯木，开始第一天";
    if (this.player.gatherTimer > 0) return "取水中 · 别移动";

    // 致命轴优先：水分和饥饿归零是立即死亡，必须压过其它所有提示。
    if (this.player.water < 18) return "水分见底 · 立刻找水，归零即死";
    if (this.player.hunger < 18) return "饥饿见底 · 立刻进食，归零即死";
    // 其次是瘫痪状态。
    if (this.player.condition === "hypothermia") return "失温 · 移动几乎停滞，爬向篝火";
    if (this.player.condition === "heatstroke") return "中暑 · 离开火边，喝水降温";

    if (this.player.resting) return "休息中 · 生命与劳力都在回复";
    // 枯木现在进背包，所以指引从"往哪搬"变成"够不够、去哪烧"。
    // 同样要让过 requestInteraction 的优先级：脚边有东西可捡时 E 不会去添柴，
    // 这里就不能喊"按互动键添柴"。
    if (this.getInventoryCount("wood") > 0) {
      const hearth = this.findNearestHearth(FIRE_WARMTH_RADIUS);
      if (hearth && !this.hasNearerTarget(hearth.distance)) return "就在火边 · 按互动键添柴";
    }
    const alpha = this.getAlpha();
    if (alpha) return `头狼 ${Math.max(0, Math.ceil(alpha.health))}/${alpha.maxHealth} · 杀死它即可获救`;

    if (this.phase === "night") {
      if (this.player.warmth < 30) return "体温偏低 · 回篝火，或者靠不停跑动扛住";
      const lit = this.getNearestLitCamp();
      if (!lit) return "篝火熄灭 · 沙海上捡一根枯木，搬到营地火堆上点燃";
      if (lit.fuel < 25) return `火只剩 ${Math.round(lit.fuel)} 秒 · 再捡一根枯木搬到火边`;
      if (this.day === 1 && this.phaseTime > 60) return "守住火光 · 夜袭狼只掉肉，不掉皮";
      return `守住火光 · 累计猎杀 ${this.player.kills}/${ALPHA_KILL_REQUIREMENT} 引出头狼`;
    }

    if (this.phase === "day" && this.day === 1 && this.phaseTime <= 14) return "天快黑了 · 用入口大石封住缺口";
    if (this.player.warmth > 78) return "劳作让体温快爆了 · 喝水或停下来歇会儿";
    const retreatingWolves = this.wolves.filter((wolf) => wolf.mode === "retreating").length;
    if (retreatingWolves > 0) return `天亮了 · ${retreatingWolves}只狼正在撤离`;
    if (this.objectiveStage === 0) return `捡起身边的枯木 · 劳力 ${STAMINA_COST_WOOD}/根`;
    if (this.objectiveStage === 1) return "走到篝火旁，按互动键添柴";
    if (this.objectiveStage === 2) return "找到入口旁的大石并搬到缺口中央";
    if (this.getInventoryCount("water") === 0 && this.getInventoryCount("cactus-juice") === 0) return "先囤水 · 割仙人掌，或走一趟水井";
    if (this.player.armor === "none" && this.getInventoryCount("hide") > 0) return "收集4张兽皮制作兽皮衣";
    const wildWolves = this.wolves.filter((wolf) => wolf.role === "wild" && wolf.mode !== "dead").length;
    if (this.player.armor === "none" && wildWolves > 0) return `沙海上有 ${wildWolves} 只野狼 · 只有它们掉兽皮`;
    // 体力是恒定流失的轴，而烤肉是唯一的大额补给。身上有生肉却在掉血时，
    // 目标行直接把这条路指出来 —— 比等玩家自己翻背包发现要快得多。
    if (this.player.health < 62 && this.getInventoryCount("cooked-meat") === 0
      && this.getInventoryCount("raw-meat") > 0) {
      const lit = this.getNearestLitCamp();
      return lit
        ? `体力在掉 · 去 ${Math.round(lit.distance)} 米外的篝火把生肉烤了，一份回 ${COOKED_HEALTH} 点`
        : `体力在掉 · 生肉烤熟才回体力，先找个篝火添柴`;
    }
    if (this.getInventoryCount("raw-meat") === 0 && this.getInventoryCount("cooked-meat") === 0) {
      const camel = this.critters.find((critter) => critter.kind === "camel" && critter.mode !== "dead");
      if (camel) return "缺肉了 · 骆驼一头顶四块肉外加两份水，但它跑得比你快";
      return "缺肉了 · 打点甲壳虫、蜥蜴或野兔";
    }
    return "白天备水备食，夜里守火";
  }

  private updatePlayerMovement(delta: number, rawMovement: Vec2, isMoving: boolean): void {
    if (!isMoving) return;
    // 移动会打断取水，劳力不退还 —— 让取水成为一个需要站定的承诺。
    if (this.player.gatherTimer > 0) {
      this.player.gatherTimer = 0;
      this.events.push({ type: "message", text: "取水被打断" });
    }
    this.noteActivity();
    const movement = normalize(rawMovement);
    this.player.facing = movement;
    const carryingPenalty = this.player.carrying === "stone" ? 0.54 : this.player.carrying ? 0.82 : 1;
    const needsPenalty = this.player.hunger < 12 || this.player.water < 12 ? 0.84 : 1;
    const armorPenalty = this.player.armor === "reinforced" ? REINFORCED_ARMOR_SPEED : 1;
    const speed = 8.2 * carryingPenalty * needsPenalty * armorPenalty * this.getConditionSpeedScale();
    this.moveEntity(this.player, movement.x * speed * delta, movement.z * speed * delta, PLAYER_RADIUS, true);
  }

  private updateNeeds(delta: number): void {
    // --- 代谢：水分与饥饿独立衰减，任一归零立即死亡 ---
    this.player.water = clamp(this.player.water - delta * WATER_DECAY, 0, 100);
    this.player.hunger = clamp(this.player.hunger - delta * HUNGER_DECAY, 0, 100);

    // --- 体力恒定流失：把"吃饭"从可拖延的提示变成硬心跳（原图 -0.7/600HP）---
    this.player.health -= delta * HEALTH_DECAY;

    // --- 劳力回复：休息最快，静止其次，移动最慢 ---
    const staminaRegen = this.player.resting
      ? STAMINA_REST_REGEN
      : this.player.idleTime > 0.4
        ? STAMINA_IDLE_REGEN
        : STAMINA_ACTIVE_REGEN;
    this.player.stamina = clamp(this.player.stamina + delta * staminaRegen, 0, this.player.maxStamina);

    // === 体温 ===
    // 四个独立分量相加：篝火、昼/夜基线、劳作产热。
    //   白天奔波无火 = +1.25/s      白天静止无火 = +0.35/s
    //   夜晚奔跑无火 = -0.35/s      夜晚静止无火 = -1.25/s
    //   白天贴火奔波 = +4.65/s      夜晚贴火静止 = +2.15/s
    const nearFire = this.findNearestLitFire(FIRE_WARMTH_RADIUS) !== null;
    let warmthDelta = 0;
    if (nearFire) warmthDelta += WARMTH_FIRE_GAIN;
    if (this.phase === "day") warmthDelta += WARMTH_DAY_BASE;
    else warmthDelta -= WARMTH_NIGHT_LOSS;
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
   * 两个方向各自独立冷却，都不消耗任何资源（对应原图 A02B 尿 / A06M 活埋）。
   * 舒适区内不给按，免得白白空转冷却。
   */
  requestThermalAction(): void {
    if (!this.running) return;
    const warmth = this.player.warmth;
    if (warmth > THERMAL_COMFORT_HIGH) {
      if (this.coolCooldown > 0) {
        this.events.push({ type: "message", text: `降温还需 ${Math.ceil(this.coolCooldown)} 秒` });
        return;
      }
      this.noteActivity();
      this.coolCooldown = COOL_ACTION_COOLDOWN;
      this.player.warmth = clamp(warmth - COOL_ACTION_WARMTH, WARMTH_MIN, WARMTH_MAX);
      this.updateCondition();
      this.events.push({ type: "thermal", direction: "cool" });
      this.events.push({ type: "message", text: `就地降温 · 体温 -${COOL_ACTION_WARMTH}` });
      return;
    }
    if (warmth < THERMAL_COMFORT_LOW) {
      if (this.warmCooldown > 0) {
        this.events.push({ type: "message", text: `取暖还需 ${Math.ceil(this.warmCooldown)} 秒` });
        return;
      }
      this.noteActivity();
      this.warmCooldown = WARM_ACTION_COOLDOWN;
      this.player.warmth = clamp(warmth + WARM_ACTION_WARMTH, WARMTH_MIN, WARMTH_MAX);
      this.updateCondition();
      this.events.push({ type: "thermal", direction: "warm" });
      this.events.push({ type: "message", text: `钻进沙里保温 · 体温 +${WARM_ACTION_WARMTH}` });
      return;
    }
    this.events.push({ type: "message", text: "体温还在舒适区 · 不用调节" });
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
    if (next === "heatstroke") this.events.push({ type: "message", text: "中暑 · 行动迟缓，立刻离开火边并喝水降温" });
    else if (next === "hypothermia") this.events.push({ type: "message", text: "失温 · 几乎迈不开腿，爬向最近的篝火" });
    else this.events.push({ type: "message", text: "体温回到安全区间" });
  }

  /**
   * 实际攻击力 = 基础 + 随身枯木加成（每根 +2，最多两根）。
   * 加成不写进 player.attack，因为那个字段被装备升级永久累加；
   * 枯木是会烧掉的临时物，必须每次现算。
   */
  getAttackPower(): number {
    const logs = Math.min(this.getInventoryCount("wood"), WOOD_ATTACK_CAP);
    return this.player.attack + logs * WOOD_ATTACK_BONUS;
  }

  /** 中暑 -60% 移速，失温 -75% 移速。（原图是 -85% / -99%，浏览器手感下放宽） */
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
  getRestBlocker(): string | null {
    const player = this.player;
    if (player.gatherTimer > 0) return "取水中";
    if (player.condition === "heatstroke") return "中暑时无法休息 · 先喝水降温";
    if (player.condition === "hypothermia") return "失温时无法休息 · 先回篝火";
    if (player.hunger < 20) return "太饿睡不着 · 先吃东西";
    if (player.water < 20) return "太渴睡不着 · 先喝水";
    if (this.phase === "night" && player.warmth <= 30) return "冻得睡不着 · 靠近篝火再休息";
    // 只有"刚挨过打"才禁止休息，而不是"附近有狼"。
    // 按距离判定会让夜里任何时候都休息不了 —— 夜间地图上本来就有几十只狼，
    // 20 米的追击半径几乎覆盖全图，玩家只会看到一句解释不了的"附近有狼"。
    if (this.combatTimer > 0) return `刚受到攻击 · ${Math.ceil(this.combatTimer)} 秒后可休息`;
    if (player.idleTime < 5) return `站定 ${Math.ceil(5 - player.idleTime)} 秒后开始休息`;
    return null;
  }

  private updateRest(delta: number): void {
    // 劳力没满时也值得休息 —— 休息是劳力的主要回复途径。
    const wantsRecovery = this.player.health < this.player.maxHealth || this.player.stamina < this.player.maxStamina;
    const canRest = this.player.idleTime >= 5 && wantsRecovery && this.getRestBlocker() === null;
    this.setResting(canRest);
    // 恒定流失是 HEALTH_DECAY，休息的净回复要减掉它才是玩家实际看到的速度。
    const healingRate = (this.player.hunger < 40 || this.player.water < 40 ? 0.9 : 1.5) + HEALTH_DECAY;
    if (this.player.resting) this.player.health = clamp(this.player.health + delta * healingRate, 0, this.player.maxHealth);
  }

  private setResting(active: boolean): void {
    if (this.player.resting === active) return;
    this.player.resting = active;
    this.events.push({ type: "rest", active });
  }

  private noteActivity(): void {
    this.clockStarted = true;
    this.player.idleTime = 0;
    this.setResting(false);
  }

  /**
   * 原地动作：只启动时钟，**不打断休息、不清空静止计时**。
   * 吃喝和合成都是站着不动就能做的事 —— 把它们算成"活动"会让玩家
   * 每喝一口水就被踢出休息、还要再站满 5 秒，劳力等于回不上来。
   */
  private noteInPlaceAction(): void {
    this.clockStarted = true;
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

  private updateDrops(): void {
    for (const drop of this.drops) {
      if (!drop.active) continue;
      if (this.elapsed >= drop.expiresAt) {
        drop.active = false;
        continue;
      }
      if (distanceSquared(this.player, drop) > 1.8 * 1.8) continue;
      // 装得下多少拿多少，剩下的**留在地上并从堆里扣掉**。
      // 骆驼一次掉 4 块肉，背包常常只剩两格位置 —— 全有或全无的话玩家只能眼睁睁
      // 看着一头骆驼烂在沙子里；而不扣数量就等于允许同一堆反复领取。
      const taken = Math.min(drop.count, this.getInventorySpace(drop.kind));
      if (taken <= 0) continue;
      this.addInventory(drop.kind, taken);
      drop.count -= taken;
      this.events.push({ type: "pickup", kind: drop.kind });
      if (drop.count > 0) continue;
      drop.active = false;
    }
  }

  private updateWolves(delta: number): void {
    this.updateWildWolves(delta);
    const livingCount = this.wolves.filter((wolf) => wolf.mode !== "dead").length;
    // 每夜目标狼数大幅上调：D1 26→40，D2 36→55，D3+ 46→70，压力明显增强
    const target = Math.min(90, 40 + (this.day - 1) * 15);
    if (this.phase === "night" && livingCount < MAX_WOLVES && this.spawnedThisNight < target) {
      this.spawnCountdown -= delta;
      if (this.spawnCountdown <= 0) {
        this.spawnWolf({ role: "raider" });
        this.spawnedThisNight += 1;
        const nightProgress = clamp(1 - this.phaseTime / this.getPhaseDuration(), 0, 1);
        const nightlyPressure = Math.max(0.78, 1 - (this.day - 1) * 0.09);
        // 刷怪间隔曲线整体压缩：从 0.9~5.7s 缩到 0.7~4.0s，前期更密集
        const curvedInterval = 0.7 + Math.pow(nightProgress, 0.8) * 3.3;
        this.spawnCountdown = curvedInterval * nightlyPressure * (0.85 + this.random() * 0.3);
      }
    }

    for (const wolf of this.wolves) {
      if (wolf.retreatAt > 0 && this.elapsed >= wolf.retreatAt) this.beginRetreat(wolf);
      this.updateWolf(wolf, delta);
    }
    for (let index = this.wolves.length - 1; index >= 0; index -= 1) {
      const wolf = this.wolves[index];
      if (wolf.mode === "dead" && wolf.deathTimer <= 0) this.wolves.splice(index, 1);
      else if (wolf.mode === "retreating" && (
        this.isAtWorldEdge(wolf)
        || wolf.lostTimer >= 34
        || (wolf.lostTimer >= 18 && distanceSquared(wolf, this.player) > 45 * 45)
      )) this.wolves.splice(index, 1);
    }
  }

  private updateWolf(wolf: WolfState, delta: number): void {
    wolf.attackCooldown = Math.max(0, wolf.attackCooldown - delta);
    wolf.hurtFlash = Math.max(0, wolf.hurtFlash - delta);
    if (wolf.mode === "dead") {
      wolf.deathTimer -= delta;
      return;
    }

    if (wolf.mode === "retreating") wolf.lostTimer += delta;
    // 夜袭狼靠视野主动锁定；白天的野狼只有被激怒后才会追击；头狼昼夜都在猎杀。
    const hunting = wolf.kind === "alpha" ? true
      : wolf.role === "wild" ? wolf.provoked
        : this.phase === "night";
    const canSeePlayer = hunting && wolf.mode !== "retreating" && this.wolfCanSeePlayer(wolf);
    if (canSeePlayer) {
      wolf.mode = "chase";
      wolf.lostTimer = 0;
    } else if (wolf.mode === "chase") {
      wolf.lostTimer += delta;
      const beyondLeash = distance(wolf, wolf.anchor) > 38;
      if ((wolf.lostTimer > 4.5 && distance(wolf, this.player) > 13) || beyondLeash) {
        wolf.mode = "patrol";
        wolf.lostTimer = 0;
      }
    }

    let target: Vec2;
    if (wolf.mode === "retreating") {
      target = wolf.anchor;
    } else if (wolf.mode === "entering") {
      target = wolf.anchor;
      if (distanceSquared(wolf, wolf.anchor) < 3 * 3) wolf.mode = wolf.raider ? "raid" : "patrol";
    } else if (wolf.mode === "chase") {
      target = this.player;
    } else if (wolf.mode === "raid") {
      target = this.getRaidTarget(wolf);
      if (distanceSquared(wolf, this.player) < 15 * 15) wolf.mode = "chase";
    } else {
      wolf.patrolAngle += delta * (0.22 + (wolf.id % 5) * 0.015);
      target = {
        x: wolf.anchor.x + Math.cos(wolf.patrolAngle) * 7,
        z: wolf.anchor.z + Math.sin(wolf.patrolAngle * 0.83) * 5,
      };
    }

    const playerDistance = distance(wolf, this.player);
    if (wolf.mode === "chase" && playerDistance < 1.75) {
      if (wolf.attackCooldown <= 0) {
        wolf.attackCooldown = 1.15;
        const damage = Math.max(1, wolf.attack - this.player.defense);
        this.player.health -= damage;
        this.player.hurtFlash = 0.3;
        this.combatTimer = REST_COMBAT_LOCK;
        this.noteActivity();
        this.events.push({ type: "player-hit", amount: damage });
      }
      return;
    }

    let desired = direction(wolf, target);
    if (wolf.mode === "chase" && this.lineOfSightBlocked(wolf, this.player)) desired = this.navigation.directionFrom(wolf);
    // Retreats always follow a terrain-aware flow field. A straight line to the
    // edge can look clear while still crossing an unwalkable heightfield slope.
    if (wolf.mode === "retreating") desired = this.getRetreatNavigation(wolf).directionFrom(wolf);
    // 树桩挡在前面时先拆桩 —— 这正是它存在的意义：把狼的时间从"咬你"换成"咬木头"。
    const blockingStructure = wolf.mode === "retreating" ? null : this.findBlockingStructure(wolf, desired);
    if (blockingStructure) {
      if (wolf.attackCooldown <= 0) {
        wolf.attackCooldown = 0.95;
        blockingStructure.hp -= Math.round(wolf.attack * (wolf.kind === "large" ? 1.45 : 1.05));
        this.events.push({ type: "barrier-hit", itemId: -1 - blockingStructure.id });
        if (blockingStructure.hp <= 0) {
          blockingStructure.active = false;
          this.events.push({ type: "structure-destroyed", kind: blockingStructure.kind });
        }
      }
      return;
    }

    const blockingItem = wolf.mode === "retreating" ? null : this.findBlockingItem(wolf, desired);
    if (blockingItem) {
      if (wolf.attackCooldown <= 0) {
        wolf.attackCooldown = 0.95;
        const barrierDamage = Math.round(wolf.attack * (wolf.kind === "large" ? 1.45 : 1.05));
        blockingItem.hp -= barrierDamage;
        this.events.push({ type: "barrier-hit", itemId: blockingItem.id });
        if (blockingItem.hp <= 0) blockingItem.active = false;
      }
      return;
    }

    const steered = this.getSteeredDirection(wolf, desired);
    wolf.facing = steered;
    const pace = wolf.mode === "retreating" ? wolf.speed * 1.45 : wolf.mode === "chase" ? wolf.speed * 1.2 : wolf.speed;
    const beforeX = wolf.x;
    const beforeZ = wolf.z;
    // Wolves may cross slightly steeper ground while fleeing. If one still
    // stalls, the allowance increases gradually instead of leaving it pinned
    // against the same heightfield cell until the hard despawn timer fires.
    const retreatSlopeAllowance = wolf.mode === "retreating"
      ? Math.min(3.2, 1.55 + wolf.retreatStuckTimer * 0.9)
      : 1;
    this.moveEntity(
      wolf,
      steered.x * pace * delta,
      steered.z * pace * delta,
      WOLF_RADIUS,
      wolf.mode !== "retreating",
      retreatSlopeAllowance,
    );
    if (wolf.mode === "retreating") {
      const advanced = Math.hypot(wolf.x - beforeX, wolf.z - beforeZ);
      wolf.retreatStuckTimer = advanced < pace * delta * 0.12 ? wolf.retreatStuckTimer + delta : 0;
    }
  }

  private beginRetreat(wolf: WolfState): void {
    if (wolf.mode === "dead") return;
    const half = this.world.size / 2 + 2;
    const exits: Vec2[] = [
      { x: -half, z: wolf.z },
      { x: half, z: wolf.z },
      { x: wolf.x, z: -half },
      { x: wolf.x, z: half },
    ];
    wolf.mode = "retreating";
    wolf.anchor = exits.reduce((best, candidate) => (
      distanceSquared(wolf, candidate) < distanceSquared(wolf, best) ? candidate : best
    ));
    wolf.lostTimer = 0;
    wolf.retreatAt = 0;
    wolf.retreatStuckTimer = 0;
    wolf.attackCooldown = 0;
  }

  private scheduleRaiderRetreat(): void {
    const raiders = this.wolves
      .filter((wolf) => wolf.role === "raider" && wolf.kind !== "alpha" && wolf.mode !== "dead")
      // Wolves already near an edge form the first packs, keeping later packs
      // visible around the camps while the withdrawal unfolds.
      .sort((a, b) => this.distanceToWorldEdge(a) - this.distanceToWorldEdge(b) || a.id - b.id);

    for (let index = 0; index < raiders.length; index += 1) {
      const wolf = raiders[index];
      const batch = Math.floor(index / RETREAT_BATCH_SIZE);
      const withinBatch = index % RETREAT_BATCH_SIZE;
      wolf.mode = "patrol";
      wolf.provoked = false;
      wolf.anchor = { x: wolf.x, z: wolf.z };
      wolf.lostTimer = 0;
      wolf.retreatStuckTimer = 0;
      wolf.retreatAt = this.elapsed
        + 0.6
        + batch * RETREAT_BATCH_INTERVAL
        + withinBatch * RETREAT_WITHIN_BATCH_STAGGER
        + this.random() * 0.18;
    }
  }

  private distanceToWorldEdge(point: Vec2): number {
    const half = this.world.size / 2;
    return half - Math.max(Math.abs(point.x), Math.abs(point.z));
  }

  private getRetreatNavigation(wolf: WolfState): NavigationGrid {
    const horizontalExit = Math.abs(wolf.anchor.x) > this.world.size / 2;
    if (horizontalExit) return this.retreatNavigations[wolf.anchor.x < 0 ? 0 : 1];
    return this.retreatNavigations[wolf.anchor.z < 0 ? 2 : 3];
  }

  private isAtWorldEdge(wolf: WolfState): boolean {
    const edge = this.world.size / 2 - WOLF_RADIUS - 1;
    return Math.abs(wolf.x) >= edge || Math.abs(wolf.z) >= edge;
  }

  private killWolf(wolf: WolfState): void {
    if (wolf.dropsCreated) return;
    wolf.dropsCreated = true;
    wolf.mode = "dead";
    wolf.retreatAt = 0;
    wolf.retreatStuckTimer = 0;
    wolf.health = 0;
    wolf.deathTimer = 0.8;
    this.player.kills += 1;

    if (wolf.kind === "alpha") {
      this.createDrop(wolf, "raw-meat", -0.65, 3);
      this.createDrop(wolf, "hide", 0.65, 4);
      this.events.push({ type: "wolf-killed", wolfId: wolf.id });
      this.endGameWithVictory();
      return;
    }

    // 夜袭狼**什么都不掉**（原图：Player(11) 的狼不触发掉落表）。
    // 这条把"守夜"和"打猎"彻底拆开 —— 夜里打赢只是活下来，资源必须白天出去拿。
    //
    // 不只是为了还原：一夜刷 40~90 只，按每只 1~2 块肉算就是几十上百块，
    // 而一个昼夜只需要约 6 块熟肉。夜袭掉落等于把食物供给放大十几倍，
    // 饥饿和体力这两条轴因此永远咬不住人。
    if (wolf.role === "wild") {
      const bulk = wolf.kind === "large" ? 2 : 1;
      this.createDrop(wolf, "raw-meat", -0.65, bulk);
      this.createDrop(wolf, "hide", 0.65, bulk);
    }
    this.events.push({ type: "wolf-killed", wolfId: wolf.id });
    this.maybeSpawnAlpha();
  }

  /** 累计击杀达标后，头狼在夜晚从地图边缘登场；白天达标则等到入夜。 */
  private maybeSpawnAlpha(): void {
    if (this.alphaSpawned || this.victorySent) return;
    if (this.player.kills < ALPHA_KILL_REQUIREMENT) return;
    if (this.phase !== "night") return;
    this.alphaSpawned = true;
    this.spawnWolf({ role: "raider", forceKind: "alpha" });
    this.events.push({ type: "alpha-spawned" });
    this.events.push({ type: "message", text: "头狼出现了 · 杀死它，这片沙海就安静了" });
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

  /**
   * 每夜的成长曲线：+3 攻击、+12 生命、+4% 移速，且不封顶。
   * 原图是每夜 +25 攻 +300 血（200 级上限），这里按我们 3~5 夜的体量缩放。
   */
  private getNightScaling(): { attack: number; health: number; speed: number } {
    const nights = Math.max(0, this.day - 1);
    return { attack: nights * 3, health: nights * 12, speed: 1 + nights * 0.04 };
  }

  private spawnWolf(options: { role?: WolfRole; forceKind?: WolfKind; origin?: Vec2 } = {}): void {
    const role = options.role ?? "raider";
    const half = this.world.size / 2 - 2;
    const tutorialWolf = role === "raider" && !options.forceKind && this.day === 1 && this.spawnedThisNight === 0;
    const side = Math.floor(this.random() * 4);
    const along = (this.random() - 0.5) * (this.world.size - 12);
    const edgeSpawn = side === 0 ? { x: -half, z: along }
      : side === 1 ? { x: half, z: along }
      : side === 2 ? { x: along, z: -half }
      : { x: along, z: half };
    const camp = tutorialWolf
      ? this.world.camps[this.world.startCampId]
      : this.world.camps[Math.floor(this.random() * this.world.camps.length)];
    const spawnCandidate = options.origin ?? (tutorialWolf ? {
      x: camp.x + Math.cos(camp.entranceAngle) * (camp.radius + 18),
      z: camp.z + Math.sin(camp.entranceAngle) * (camp.radius + 18),
    } : edgeSpawn);
    const spawn = this.findNearestWalkablePoint(spawnCandidate);

    const largeChance = Math.min(0.58, 0.22 + (this.day - 1) * 0.09);
    const kind: WolfKind = options.forceKind
      ?? (tutorialWolf || this.random() >= largeChance ? "small" : "large");
    const scaling = this.getNightScaling();

    let maxHealth: number;
    let attack: number;
    let defense: number;
    let speed: number;
    if (kind === "alpha") {
      // 头狼：明显是一堵墙，但不是数值上不可战胜 —— 对应原图狼王 10000HP / 28 护甲。
      maxHealth = 620 + scaling.health * 6;
      attack = 26 + scaling.attack;
      defense = 9;
      speed = 3.5;
    } else if (tutorialWolf) {
      maxHealth = 28;
      attack = 5;
      defense = 0;
      speed = 3.05;
    } else if (kind === "large") {
      maxHealth = 112 + scaling.health;
      attack = 16 + scaling.attack;
      defense = 5;
      speed = (2.85 + this.random() * 0.55) * scaling.speed;
    } else {
      maxHealth = 58 + scaling.health;
      attack = 10 + scaling.attack;
      defense = 1;
      speed = (3.65 + this.random() * 0.75) * scaling.speed;
    }
    // 野狼白天只在自己的地盘游荡，不参与夜袭的成长曲线，所以稍微弱一点。
    if (role === "wild") {
      maxHealth = Math.round(maxHealth * 0.85);
      attack = Math.max(6, Math.round(attack * 0.8));
    }

    const anchorAngle = this.random() * TAU;
    const anchorDistance = 12 + this.random() * 10;
    const anchor = role === "wild"
      ? this.findNearestWalkablePoint({ x: spawn.x, z: spawn.z })
      : this.findNearestWalkablePoint({
        x: camp.x + Math.cos(anchorAngle) * anchorDistance,
        z: camp.z + Math.sin(anchorAngle) * anchorDistance,
      });

    const raiderChance = Math.min(0.35, 0.16 + (this.day - 1) * 0.06);
    const raider = role === "raider" && (tutorialWolf || kind === "alpha" || this.random() < raiderChance);
    this.wolves.push({
      id: this.wolfId++,
      kind,
      role,
      ...spawn,
      facing: direction(spawn, anchor),
      health: maxHealth,
      maxHealth,
      attack,
      defense,
      mode: role === "wild" ? "patrol" : raider ? "raid" : "entering",
      raider,
      provoked: false,
      anchor,
      patrolAngle: this.random() * TAU,
      speed,
      attackCooldown: this.random(),
      lostTimer: 0,
      retreatAt: 0,
      retreatStuckTimer: 0,
      hurtFlash: 0,
      deathTimer: 0,
      dropsCreated: false,
    });
    if (tutorialWolf) this.events.push({ type: "message", text: "侦察小狼正在逼近 · 面向它攻击" });
    if (kind === "large" && role === "raider" && !this.largeWolfAnnounced) {
      this.largeWolfAnnounced = true;
      this.events.push({ type: "message", text: "发现大狼 · 生命、防御和破坏力都更高" });
    }
  }

  // ==========================================================================
  // 荒漠猎物
  // 全部不攻击玩家。难度只由「警觉半径 + 逃跑速度 + 冲刺时长」三项决定：
  // 冲刺耗尽后它们会停下喘气，所以再快的猎物只要肯追都追得到 ——
  // 代价是你自己的劳力和体温（奔跑产热 +0.9/s，白天很容易把自己追到中暑）。
  // ==========================================================================

  private updateCritters(delta: number): void {
    this.critterRespawnCountdown -= delta;
    if (this.critterRespawnCountdown <= 0) {
      this.critterRespawnCountdown = 6;
      this.replenishCritters();
    }
    for (const critter of this.critters) this.updateCritter(critter, delta);
    for (let index = this.critters.length - 1; index >= 0; index -= 1) {
      const critter = this.critters[index];
      if (critter.mode === "dead" && critter.deathTimer <= 0) this.critters.splice(index, 1);
    }
  }

  /** 每种猎物各自维持自己的目标数量，在远离玩家的地方补回来。 */
  /**
   * 开局把整个种群一次撒满。
   * 之前只靠每 6 秒补 1 只，玩家开局面对的是一片空荡荡的沙漠，
   * 要一分钟后才慢慢有东西可打 —— 第一天的觅食完全没法进行。
   */
  private seedCritters(): void {
    for (const kind of Object.keys(CRITTER_SPECS) as CritterKind[]) {
      const spec = CRITTER_SPECS[kind];
      for (let index = 0; index < spec.population; index += 1) {
        // 开局允许离玩家近一些，否则第一天要跑很远才见得到活物。
        const point = this.findCritterSpawnPoint(14);
        if (point) this.spawnCritter(kind, point);
      }
    }
  }

  private replenishCritters(): void {
    for (const kind of Object.keys(CRITTER_SPECS) as CritterKind[]) {
      const spec = CRITTER_SPECS[kind];
      const alive = this.critters.filter((c) => c.kind === kind && c.mode !== "dead").length;
      if (alive >= spec.population) continue;
      const point = this.findCritterSpawnPoint();
      if (point) this.spawnCritter(kind, point);
    }
  }

  private findCritterSpawnPoint(minPlayerDistance = 30): Vec2 | null {
    for (let guard = 0; guard < 24; guard += 1) {
      const point = {
        x: (this.random() - 0.5) * (this.world.size - 20),
        z: (this.random() - 0.5) * (this.world.size - 20),
      };
      // 别在玩家眼皮底下凭空出现。
      if (distanceSquared(point, this.player) < minPlayerDistance * minPlayerDistance) continue;
      if (!isTerrainWalkable(this.world, point)) continue;
      return point;
    }
    return null;
  }

  private spawnCritter(kind: CritterKind, origin: Vec2): void {
    const spec = CRITTER_SPECS[kind];
    const spawn = this.findNearestWalkablePoint(origin);
    this.critters.push({
      id: this.critterId++,
      kind,
      ...spawn,
      facing: { x: Math.cos(this.random() * TAU), z: Math.sin(this.random() * TAU) },
      health: spec.maxHealth,
      maxHealth: spec.maxHealth,
      mode: "graze",
      anchor: { ...spawn },
      wanderAngle: this.random() * TAU,
      sprint: spec.sprintSeconds,
      hurtFlash: 0,
      deathTimer: 0,
      dropsCreated: false,
    });
  }

  private updateCritter(critter: CritterState, delta: number): void {
    critter.hurtFlash = Math.max(0, critter.hurtFlash - delta);
    if (critter.mode === "dead") {
      critter.deathTimer -= delta;
      return;
    }

    const spec = CRITTER_SPECS[critter.kind];
    const playerDistance = distance(critter, this.player);
    const startled = playerDistance < spec.alertRadius && critter.sprint > 0;

    if (startled) {
      critter.mode = "flee";
      critter.sprint = Math.max(0, critter.sprint - delta);
    } else {
      critter.mode = "graze";
      // 只有玩家离得够远才回气，否则站在旁边等它回满就太廉价了。
      if (playerDistance > spec.alertRadius * 1.35) {
        critter.sprint = Math.min(spec.sprintSeconds, critter.sprint + delta * (spec.sprintSeconds / spec.sprintRecovery));
      }
    }

    let desired: Vec2;
    let pace: number;
    if (critter.mode === "flee") {
      desired = direction(this.player, critter);
      pace = spec.fleeSpeed;
    } else {
      // 游荡：绕着锚点慢慢晃，离得太远就往回收。
      critter.wanderAngle += delta * (0.3 + (critter.id % 5) * 0.04);
      const anchorPull = distance(critter, critter.anchor) > 14 ? direction(critter, critter.anchor) : { x: 0, z: 0 };
      desired = normalize({
        x: Math.cos(critter.wanderAngle) + anchorPull.x * 2.2,
        z: Math.sin(critter.wanderAngle * 0.82) + anchorPull.z * 2.2,
      });
      pace = spec.grazeSpeed;
    }

    const steered = this.getSteeredDirection(critter, desired);
    critter.facing = steered;
    this.moveEntity(critter, steered.x * pace * delta, steered.z * pace * delta, 0.4, false);
  }

  private killCritter(critter: CritterState): void {
    if (critter.dropsCreated) return;
    const spec = CRITTER_SPECS[critter.kind];
    critter.dropsCreated = true;
    critter.mode = "dead";
    critter.health = 0;
    critter.deathTimer = 0.7;
    if (spec.meat > 0) this.createDrop(critter, "raw-meat", -0.6, spec.meat);
    if (spec.hide > 0) this.createDrop(critter, "hide", 0.6, spec.hide);
    // 骆驼是唯一会掉水的猎物 —— 对应原图杀骆驼掉「骆驼水」。
    if (spec.water > 0) this.createDrop(critter, "water", 1.8, spec.water);
    this.events.push({ type: "critter-killed", critterId: critter.id, kind: critter.kind });
  }

  getCritterLabel(kind: CritterKind): string {
    return CRITTER_SPECS[kind].label;
  }

  /**
   * 白天在远离玩家的地方补充游荡野狼。
   * 它们不主动攻击，被打才反击 —— 是狼皮（进而是防具线）的唯一来源。
   */
  private updateWildWolves(delta: number): void {
    if (this.phase !== "day") return;
    this.wildRespawnCountdown -= delta;
    if (this.wildRespawnCountdown > 0) return;
    this.wildRespawnCountdown = 9;
    const wildCount = this.wolves.filter((wolf) => wolf.role === "wild" && wolf.mode !== "dead").length;
    if (wildCount >= 5) return;
    for (let guard = 0; guard < 20; guard += 1) {
      const point = {
        x: (this.random() - 0.5) * (this.world.size - 24),
        z: (this.random() - 0.5) * (this.world.size - 24),
      };
      if (distanceSquared(point, this.player) < 34 * 34) continue;
      if (!isTerrainWalkable(this.world, point)) continue;
      this.spawnWolf({ role: "wild", origin: point });
      return;
    }
  }

  private wolfCanSeePlayer(wolf: WolfState): boolean {
    const maxDistance = wolf.raider ? 17.5 : 14.5;
    if (distanceSquared(wolf, this.player) > maxDistance * maxDistance) return false;
    const towardPlayer = direction(wolf, this.player);
    if (dot(wolf.facing, towardPlayer) < 0.08 && distanceSquared(wolf, this.player) > 5 * 5) return false;
    return !this.lineOfSightBlocked(wolf, this.player);
  }

  private lineOfSightBlocked(start: Vec2, end: Vec2): boolean {
    for (const wall of this.world.walls) {
      if (segmentIntersectsCircle(start, end, wall, wall.radius * 0.82)) return true;
    }
    const startHeight = terrainHeightAt(this.world, start) + 1.15;
    const endHeight = terrainHeightAt(this.world, end) + 1.15;
    for (let step = 1; step < 8; step += 1) {
      const t = step / 8;
      const point = { x: start.x + (end.x - start.x) * t, z: start.z + (end.z - start.z) * t };
      const sightHeight = startHeight + (endHeight - startHeight) * t;
      if (terrainHeightAt(this.world, point) > sightHeight + 0.35) return true;
    }
    for (const item of this.items) {
      if (item.active && item.placed && segmentIntersectsCircle(start, end, item, item.kind === "stone" ? 1.48 : 0.65)) return true;
    }
    return false;
  }

  private getRaidTarget(wolf: WolfState): Vec2 {
    let nearest: CampDefinition | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const camp of this.world.camps) {
      if (this.camps[camp.id].fuel <= 0) continue;
      const value = distanceSquared(wolf, camp);
      if (value < nearestDistance) {
        nearest = camp;
        nearestDistance = value;
      }
    }
    if (!nearest) return this.player;
    const entrance = {
      x: nearest.x + Math.cos(nearest.entranceAngle) * (nearest.radius + 3),
      z: nearest.z + Math.sin(nearest.entranceAngle) * (nearest.radius + 3),
    };
    return distanceSquared(wolf, entrance) > 3.2 * 3.2 ? entrance : nearest;
  }

  /** 挡在狼前进方向上的放置物。 */
  private findBlockingStructure(wolf: WolfState, desired: Vec2): PlacedStructure | null {
    let closest: PlacedStructure | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const structure of this.structures) {
      if (!structure.active) continue;
      const reach = STRUCTURE_SPECS[structure.kind].radius + 1.5;
      const structureDistance = distance(wolf, structure);
      if (structureDistance > reach) continue;
      if (dot(desired, direction(wolf, structure)) < 0.35) continue;
      if (structureDistance < closestDistance) {
        closest = structure;
        closestDistance = structureDistance;
      }
    }
    return closest;
  }

  private findBlockingItem(wolf: WolfState, desired: Vec2): GroundItem | null {
    let closest: GroundItem | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const item of this.items) {
      if (!item.active || !item.placed) continue;
      const itemDistance = distance(wolf, item);
      if (itemDistance > 2.3) continue;
      if (dot(desired, direction(wolf, item)) < 0.35) continue;
      const clusterSize = this.items.filter((other) => other.active && other.placed && distanceSquared(item, other) < 4.2 * 4.2).length;
      if (item.kind === "wood" && clusterSize < 2) continue;
      if (itemDistance < closestDistance) {
        closest = item;
        closestDistance = itemDistance;
      }
    }
    return closest;
  }

  private getSteeredDirection(entity: Vec2, desired: Vec2): Vec2 {
    let steerX = desired.x;
    let steerZ = desired.z;
    for (const wall of this.world.walls) {
      const safe = wall.radius + 2.3;
      const value = distanceSquared(entity, wall);
      if (value > safe * safe || value < 0.0001) continue;
      const away = direction(wall, entity);
      const strength = (safe - Math.sqrt(value)) / safe;
      steerX += away.x * strength * 2.6;
      steerZ += away.z * strength * 2.6;
    }
    for (const item of this.items) {
      if (!item.active || !item.placed || distanceSquared(entity, item) > 3.2 * 3.2) continue;
      const away = direction(item, entity);
      steerX += away.x * 1.8;
      steerZ += away.z * 1.8;
    }
    return normalize({ x: steerX, z: steerZ });
  }

  private advancePhase(): void {
    if (this.phase === "day") {
      this.phase = "night";
      this.phaseTime = this.day === 1 ? FIRST_NIGHT_DURATION : this.day === 2 ? SECOND_NIGHT_DURATION : LATER_NIGHT_DURATION;
      this.spawnCountdown = 0.45;
      this.spawnedThisNight = 0;
      this.objectiveStage = 3;
      this.events.push({ type: "phase", phase: "night", day: this.day });
      const litAtDusk = this.getNearestLitCamp();
      this.events.push({
        type: "message",
        text: litAtDusk && litAtDusk.fuel >= this.phaseTime
          ? "狼正从沙海边缘逐只进入 · 火能撑到天亮"
          : "狼正从沙海边缘逐只进入 · 火撑不到天亮，备好枯木",
      });
      // 白天打满击杀数的话，头狼会在入夜的这一刻登场。
      this.maybeSpawnAlpha();
      return;
    }
    this.phase = "day";
    this.day += 1;
    this.phaseTime = LATER_DAY_DURATION;
    // 只有夜袭部队撤离；白天的野狼留在原地继续游荡，它们才是狼皮的来源。
    // 头狼绝不撤退 —— 它一旦登场就必须被杀死，否则玩家再也没有通关途径。
    this.scheduleRaiderRetreat();
    this.duskWarningSent = false;
    this.wildRespawnCountdown = 2;
    this.events.push({ type: "phase", phase: "day", day: this.day });
    this.events.push({ type: "message", text: "天亮了 · 夜袭狼正在分批撤离；白天的野狼可以猎取兽皮" });
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
      this.events.push({ type: "message", text: `天色转暗 · 火够烧 ${Math.round(fuel)} 秒，撑得过今晚` });
      return;
    }
    const logs = Math.ceil((night - fuel) / 95);
    this.events.push({
      type: "message",
      text: fuel <= 0
        ? `天色转暗 · 营地没有火，今晚 ${night} 秒需要 ${logs} 根枯木`
        : `天色转暗 · 火只够烧 ${Math.round(fuel)} 秒，今晚 ${night} 秒还差 ${logs} 根枯木`,
    });
  }

  private updateObjectives(): void {
    // 每一天都预警，不再只有第 1 天。
    if (!this.duskWarningSent && this.phase === "day" && this.phaseTime <= 30) {
      this.duskWarningSent = true;
      this.warnDuskFuel();
      if (this.day === 1) {
        this.events.push({ type: "message", text: "入口的大石一块就能封住窄口" });
      }
    }
    // 枯木改为进背包之后，这一阶不能再只看 carrying —— 否则捡了柴也不算数，
    // 玩家会永远卡在"拿起身边的枯木"。
    if (this.objectiveStage === 0 && (this.player.carrying || this.getInventoryCount("wood") > 0)) {
      this.objectiveStage = 1;
      this.events.push({ type: "message", text: "枯木用于添火；入口旁的大石负责封路" });
    } else if (this.objectiveStage === 1 && this.camps.some((camp) => camp.fuel > 90)) {
      this.objectiveStage = 2;
      this.events.push({ type: "message", text: "火已续上 · 把入口的大石搬到缺口中央" });
    } else if (this.objectiveStage === 2 && this.world.camps.some((camp) => this.isEntranceBlocked(camp))) {
      this.objectiveStage = 3;
      this.events.push({ type: "message", text: "封口完成 · 石头会挡路并承受狼的攻击" });
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
    const dropPosition = {
      x: this.player.x + this.player.facing.x * 2.05,
      z: this.player.z + this.player.facing.z * 2.05,
    };
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
    item.hp = kind === "stone" ? 220 : 70;
    item.placed = true;
    item.active = true;
    item.rotation = Math.atan2(this.player.facing.z, this.player.facing.x);
    if (!existing) this.items.push(item);
    this.player.carrying = null;
    this.events.push({ type: "drop", kind });
  }

  /**
   * 推进单个轴，整步被地形拒绝时退而求其次走半步、四分之一步。
   * 没有这个回退的话，贴着坡沿走会在"整步 0.14m"和"原地不动"之间反复横跳
   * —— 那正是走路发卡的手感。有了回退，玩家会平滑地贴到坡沿再停住。
   */
  private stepAxis(entity: Vec2, axis: "x" | "z", amount: number, terrainSlopeAllowance = 1): void {
    const origin = entity[axis];
    for (const scale of MOVE_STEP_FALLBACKS) {
      entity[axis] = origin + amount * scale;
      const from = axis === "x" ? { x: origin, z: entity.z } : { x: entity.x, z: origin };
      if (this.canTraverseTerrain(from, entity, terrainSlopeAllowance)) return;
    }
    entity[axis] = origin;
  }

  private moveEntity(
    entity: Vec2,
    dx: number,
    dz: number,
    radius: number,
    collideWithItems: boolean,
    terrainSlopeAllowance = 1,
  ): void {
    // 分轴推进本身就提供了沿墙滑行：一轴被挡时另一轴仍然生效。
    this.stepAxis(entity, "x", dx, terrainSlopeAllowance);
    this.resolveCollisions(entity, radius, collideWithItems);
    this.stepAxis(entity, "z", dz, terrainSlopeAllowance);
    this.resolveCollisions(entity, radius, collideWithItems);
    const half = this.world.size / 2 - radius;
    entity.x = clamp(entity.x, -half, half);
    entity.z = clamp(entity.z, -half, half);
  }

  private resolveCollisions(entity: Vec2, radius: number, collideWithItems: boolean): void {
    for (let pass = 0; pass < 3; pass += 1) {
      for (const obstacle of this.world.walls) this.pushOutsideCircle(entity, radius, obstacle, obstacle.radius);
      if (!collideWithItems) continue;
      for (const item of this.items) {
        if (!item.active || !item.placed) continue;
        this.pushOutsideCircle(entity, radius, item, item.kind === "stone" ? 1.48 : 0.62);
      }
      for (const structure of this.structures) {
        if (!structure.active) continue;
        this.pushOutsideCircle(entity, radius, structure, STRUCTURE_SPECS[structure.kind].radius);
      }
    }
  }

  private canTraverseTerrain(from: Vec2, to: Vec2, terrainSlopeAllowance = 1): boolean {
    if (terrainSlopeAt(this.world, to) > this.world.terrain.maxWalkableSlope * terrainSlopeAllowance) return false;
    const travel = Math.hypot(to.x - from.x, to.z - from.z);
    if (travel < 0.0001) return true;
    const rise = Math.abs(terrainHeightAt(this.world, to) - terrainHeightAt(this.world, from));
    return rise / travel <= this.world.terrain.maxWalkableSlope * 1.12 * terrainSlopeAllowance;
  }

  private pushOutsideCircle(entity: Vec2, radius: number, obstacle: Vec2, obstacleRadius: number): void {
    const dx = entity.x - obstacle.x;
    const dz = entity.z - obstacle.z;
    const minDistance = radius + obstacleRadius;
    const value = dx * dx + dz * dz;
    if (value >= minDistance * minDistance) return;
    const currentDistance = Math.sqrt(value);
    if (currentDistance < 0.0001) {
      entity.x += minDistance;
      return;
    }
    const correction = minDistance - currentDistance;
    entity.x += (dx / currentDistance) * correction;
    entity.z += (dz / currentDistance) * correction;
  }

}
