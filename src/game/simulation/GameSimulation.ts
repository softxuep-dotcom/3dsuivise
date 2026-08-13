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
  CampDefinition,
  CampState,
  DeathCause,
  EquipLine,
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

/**
 * 造一条待渲染文案。模拟层所有面向玩家的字符串都经这里出去 ——
 * 它不认识任何一门语言，只负责说清"这是哪一条、带什么参数"。
 */
const loc = (key: string, params?: LocalizedText["params"]): LocalizedText => (
  params ? { key, params } : { key }
);

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

/**
 * 一阶装备。
 *
 * `attack` / `defense` 是**这件装备自己的绝对属性**，不是相对上一阶的增量。
 * 增量口径只在"装备是一条直线"时说得清；一旦分叉成多条线，"+18" 是相对谁的 +18
 * 就没有答案了。绝对值还顺带修掉一处口径不一致：HUD 上写的是累计值（狼牙重矛
 * "攻击+34"），配方表的 blurb 写的是增量（"攻击+16"），同一件装备两个数字。
 */
export interface EquipTier {
  id: string;
  /** 所属分线；阶 0 是 "none"，四条线各自三阶。 */
  line: EquipLine;
  /** 0~3。只能沿同一条线逐阶推进，跨线必须从一阶重来。 */
  tier: number;
  cost: Array<[InventoryItemKind, number]>;
  needsFire: boolean;
  /** 装备后的攻击力绝对值。武器线必填。 */
  attack?: number;
  /** 装备后的防御力绝对值。护甲线必填。 */
  defense?: number;
}

/**
 * 武器：共用阶 0 + 两条各三阶的线，**从一阶就分叉**。
 *
 * 两条线抢的不是同一个资源池，这比数值上的强弱更能拉开差别：
 *   刀线吃**铁矿** —— 全图 14 个矿点 × 2~3 块，不再生，且没有第二个用途。
 *                     走满一条刀线要 12 块，配上铁甲就是 21 块，吃掉全图一半到四分之三。
 *   剑线吃**枯木** —— 而枯木同时是唯一的燃料（1 根 = 篝火 +95 秒）。
 *                     走满剑线要 8 根，等于拿今晚的火换明天的剑。
 *
 * 剑一阶是全部 12 件里仅有的两件 `needsFire: false` 之一 —— 轻线因此是唯一
 * 能在远征途中变强的线，也是唯一第一天日落前就拿得到的线。
 *
 * 三阶统一卡在**狼牙**上：只有白天的大狼掉，而大狼占比是
 * `min(0.58, 0.22 + (天数−1)×0.09)`，这把三阶自动锁到第 3 天以后，
 * 不需要写任何天数判定。
 */
const WEAPON_TIERS: EquipTier[] = [
  { id: "survival-knife", line: "none", tier: 0, cost: [], needsFire: false, attack: 30 },

  { id: "saber-1", line: "saber", tier: 1, needsFire: true, attack: 34,
    cost: [["iron-ore", 3], ["hide", 1]] },
  { id: "saber-2", line: "saber", tier: 2, needsFire: true, attack: 42,
    cost: [["iron-ore", 4], ["hide", 2], ["wood", 2]] },
  { id: "saber-3", line: "saber", tier: 3, needsFire: true, attack: 50,
    cost: [["iron-ore", 5], ["hide", 2], ["wolf-fang", 3]] },

  { id: "sword-1", line: "sword", tier: 1, needsFire: false, attack: 38,
    cost: [["hide", 1], ["wood", 2]] },
  { id: "sword-2", line: "sword", tier: 2, needsFire: true, attack: 45,
    cost: [["hide", 3], ["wood", 3]] },
  { id: "sword-3", line: "sword", tier: 3, needsFire: true, attack: 55,
    cost: [["hide", 4], ["wood", 3], ["wolf-fang", 3]] },
];

/**
 * 护甲：共用阶 0 + 两条各三阶的线。
 *
 * 铁甲堆减法防御，皮甲堆百分比闪避。减法吃"多而弱"的咬伤，百分比吃"少而重"的，
 * 两条曲线必然交叉 —— 解 `A − D铁 = (A − D皮)(1 − 闪避)` 得交叉点在原始攻击
 * 30.0 / 35.2 / 35.9（逐阶）。第 5 夜头狼 38 攻击已经过线，大狼要到第 8 夜才过。
 * 所以**重甲是守夜的甲，皮甲是打头狼的甲**，这不是平衡说辞，是公式的形状。
 */
const ARMOR_TIERS: EquipTier[] = [
  { id: "none", line: "none", tier: 0, cost: [], needsFire: false, defense: 2 },

  { id: "scale-1", line: "scale", tier: 1, needsFire: true, defense: 8,
    cost: [["iron-ore", 2], ["hide", 2]] },
  { id: "scale-2", line: "scale", tier: 2, needsFire: true, defense: 13,
    cost: [["iron-ore", 3], ["hide", 3]] },
  { id: "scale-3", line: "scale", tier: 3, needsFire: true, defense: 18,
    cost: [["iron-ore", 4], ["hide", 3], ["wolf-fang", 2]] },

  { id: "hide-1", line: "hide", tier: 1, needsFire: false, defense: 5,
    cost: [["hide", 4]] },
  { id: "hide-2", line: "hide", tier: 2, needsFire: true, defense: 6,
    cost: [["hide", 4], ["wood", 2]] },
  { id: "hide-3", line: "hide", tier: 3, needsFire: true, defense: 7,
    cost: [["hide", 4], ["wood", 3], ["wolf-fang", 3]] },
];

/**
 * 全线统一的攻击冷却。
 *
 * 只有一个攻击动画可用（`Melee_1H_Attack_Chop`），而动画的播放速度是按
 * `clip.duration / 0.22` 缩放到攻击闪光时长的。冷却一旦逐阶不同，同一个动作
 * 在不同武器上就会以不同倍率被拉伸 —— 那看起来不像"重武器挥得慢"，
 * 看起来像 bug。攻速这条轴因此让位给攻程、扇形、劳力等不依赖动画的轴。
 */
const ATTACK_COOLDOWN = 0.55;

interface WeaponStat {
  range: number;
  /**
   * 扇形的 `dot` 阈值 = cos(扇形角 / 2)。命中面积 = (扇形角/360) × π × 攻程²，
   * 而命中数量**不设上限**（沿用现状）—— 所以面积就是群体能力本身，
   * 不需要一个凭空的"最多打 N 个"。
   *
   *   100° → +0.643    110° → +0.574    160° → +0.174
   *   197°（改造前写死的值）→ −0.148
   *   220° → −0.342    250° → −0.574    280° → −0.766
   */
  arcDot: number;
  /** 每次挥砍的劳力。夜里回不了劳力，这一列才是真正的战斗上限。 */
  stamina: number;
  /** 破甲：`有效护甲 = max(0, 目标护甲 − 破甲)`。只有刀线有。 */
  pierce: number;
  critChance: number;
  critMult: number;
  moveScale: number;
  /** 刀线击退：推开的米数。头狼免疫。 */
  knockback: number;
  /** 刀线击退真正值钱的部分：把目标的咬击往后推多少秒。 */
  knockbackStun: number;
  /** 剑线连击：每段加多少伤害。0 表示这把武器吃不到连击。 */
  comboStep: number;
  comboMax: number;
}

/**
 * 武器属性表。冷却全线统一（见 ATTACK_COOLDOWN），分化靠下面这些不依赖动画的轴。
 *
 * 刀线与剑线的关系不是强弱，是两个方向各自约两倍：
 *   被围（6 只均匀分布）——  刀三扫到 77.8%，剑三只扫到 30.6%，刀线领先 1.75×
 *   单体持久战          ——  剑三满层 228 DPS 对刀三 104.5，剑线领先 2.18×
 *
 * 早先的版本让刀线**同时**拥有大面积、低劳力、破甲与击退，剑线只有 +33% 单击，
 * 而单击优势只在"面前恰好一个目标"时兑现 —— 全局只有头狼那一场。
 * 于是刀线全面压制。修正有两处：劳力两线拉平（刀一次打好几个还收费更低等于白送），
 * 以及给剑线一个**刀线结构上吃不到**的机制 —— 连击。刀每一刀都换目标，永远停在 0 段。
 */
const WEAPON_STATS: Record<WeaponKind, WeaponStat> = {
  "survival-knife": { range: 3.1, arcDot: 0.174, stamina: 4, pierce: 0, critChance: 0, critMult: 1, moveScale: 1.00, knockback: 0, knockbackStun: 0, comboStep: 0, comboMax: 0 },

  "saber-1": { range: 3.4, arcDot: -0.342, stamina: 5, pierce: 2, critChance: 0, critMult: 1, moveScale: 0.98, knockback: 0.35, knockbackStun: 0.20, comboStep: 0, comboMax: 0 },
  "saber-2": { range: 3.6, arcDot: -0.574, stamina: 6, pierce: 5, critChance: 0.12, critMult: 1.8, moveScale: 0.95, knockback: 0.50, knockbackStun: 0.30, comboStep: 0, comboMax: 0 },
  "saber-3": { range: 3.8, arcDot: -0.766, stamina: 7, pierce: 8, critChance: 0.15, critMult: 2.0, moveScale: 0.92, knockback: 0.70, knockbackStun: 0.40, comboStep: 0, comboMax: 0 },

  "sword-1": { range: 3.2, arcDot: 0.643, stamina: 5, pierce: 0, critChance: 0.20, critMult: 1.8, moveScale: 1.00, knockback: 0, knockbackStun: 0, comboStep: 0.10, comboMax: 3 },
  "sword-2": { range: 3.3, arcDot: 0.643, stamina: 6, pierce: 0, critChance: 0.30, critMult: 2.0, moveScale: 1.03, knockback: 0, knockbackStun: 0, comboStep: 0.12, comboMax: 4 },
  "sword-3": { range: 3.4, arcDot: 0.574, stamina: 7, pierce: 0, critChance: 0.40, critMult: 2.2, moveScale: 1.06, knockback: 0, knockbackStun: 0, comboStep: 0.15, comboMax: 4 },
};

interface ArmorStat {
  /** 命中判定前掷骰，闪掉整次咬击。只有皮甲线有。 */
  dodge: number;
  /** 把狼**未经防御削减**的原始攻击力的这个比例弹回去。只有铁甲线有。 */
  thorns: number;
  moveScale: number;
  /** 乘在三档劳力回复上。皮甲把防御换成产出，铁甲反过来。 */
  staminaScale: number;
}

const ARMOR_STATS: Record<ArmorKind, ArmorStat> = {
  none: { dodge: 0, thorns: 0, moveScale: 1.00, staminaScale: 1.00 },

  "scale-1": { dodge: 0, thorns: 0.12, moveScale: 0.97, staminaScale: 1.00 },
  "scale-2": { dodge: 0, thorns: 0.22, moveScale: 0.93, staminaScale: 0.92 },
  "scale-3": { dodge: 0, thorns: 0.35, moveScale: 0.88, staminaScale: 0.85 },

  "hide-1": { dodge: 0.12, thorns: 0, moveScale: 1.02, staminaScale: 1.12 },
  "hide-2": { dodge: 0.24, thorns: 0, moveScale: 1.05, staminaScale: 1.22 },
  "hide-3": { dodge: 0.38, thorns: 0, moveScale: 1.09, staminaScale: 1.35 },
};

/**
 * 连击窗口：换目标、或这么久没有命中，层数清零。
 * 冷却是 0.55 秒，正常连打够用；被打断走位一次就断 —— 这正是"咬住一个目标"的代价。
 */
const COMBO_WINDOW = 1.2;

/** 头狼最早在第几天的夜里登场。见下方 maybeSpawnAlpha() 的注释。 */
const ALPHA_MIN_DAY = 4;

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
/**
 * 攻击的劳力开销已经**移进武器表**（WEAPON_STATS.stamina，刀剑两线都是 5/6/7）。
 * 劳力低于当次开销时攻击仍可挥出，但伤害衰减到 EXHAUSTED_DAMAGE_SCALE ——
 * "脱力"是可感知的惩罚，不是硬锁。
 */
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
 * 回蓄速度没动：逛 1 口井覆盖需求的 29%、逛 2 口 59%，剩下的交给仙人掌和长角羚。
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
  /** 剑线连击：当前层数、锁定的目标、以及还剩多久清零。 */
  private comboStacks = 0;
  private comboTargetKey: string | null = null;
  private comboTimer = 0;
  /** 头狼是否已被击杀。杀掉不再直接通关 —— 还得撑到天亮。 */
  private alphaSlain = false;
  /** 挨打后的休息封锁倒计时，见 REST_COMBAT_LOCK。 */
  private combatTimer = 0;
  /** 当前正在提水的井 id，-1 表示没有。 */
  private drawingWellId = -1;
  private structureId = 0;
  /** 正被玩家双手搬运的树桩；保留原对象才能避免搬运受损树桩时把生命值刷满。 */
  private carriedStructure: PlacedStructure | null = null;
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
    this.camps = world.camps.map((camp) => ({ id: camp.id, fuel: 0 }));
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
    this.events.push({ type: "message", key: "msg.1" });
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
    const structure = this.findNearestStructure(2.7);
    if (structure && distance(this.player, structure) < hearthDistance) return true;
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
  private spendStamina(cost: number, labelKey: string): boolean {
    if (this.player.stamina < cost) {
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

  /** 从井里提水：必得，但要站定 2.6 秒，且这口井的存量会被扣掉。 */
  private beginWaterDraw(well: WellState): void {
    if (this.player.gatherTimer > 0) return;
    if (this.getInventoryCount("water") >= INVENTORY_STACK_LIMITS.water * 2) {
      this.events.push({ type: "message", key: "msg.7" });
      return;
    }
    if (!this.spendStamina(STAMINA_COST_DRAW, "labour.draw")) return;
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
      this.events.push({ type: "message", key: "msg.8" });
      return;
    }
    if (!this.addInventory("water", 1)) {
      this.events.push({ type: "message", key: "msg.9" });
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
    const stats = WEAPON_STATS[this.player.weapon];
    // 劳力不足不会禁止挥砍，但伤害衰减到 60%，"脱力"是可感知的惩罚而不是硬锁。
    const exhausted = this.player.stamina < stats.stamina;
    if (exhausted) this.events.push({ type: "exhausted" });
    else this.player.stamina = Math.max(0, this.player.stamina - stats.stamina);
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
      && dot(this.player.facing, direction(this.player, target)) >= stats.arcDot;

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
      if (wolf.health <= 0) this.killWolf(wolf);
      else this.applyKnockback(wolf, stats);
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
    if (!hit && this.objectiveStage >= 3) this.events.push({ type: "message", key: "msg.10" });
  }

  /**
   * 一次命中的伤害。
   *
   * 顺序是刻意的：**重创与连击的倍率在减护甲之前结算**。
   * 先乘后减，倍率就对"打有甲目标"格外划算，"重击能破甲"这个直觉才成立；
   * 反过来先减后乘，重创会在小狼身上被放大、在头狼身上被稀释，正好是反的。
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

  /**
   * 刀线击退。
   *
   * 真正值钱的是 `knockbackStun` 那一项，不是推开的距离 —— 狼移速 3~5 m/s，
   * 0.7 米两百毫秒就走回来了；但狼的咬击间隔是 1.15 秒，你每 0.55 秒给它
   * +0.4 秒，等于把它的输出压掉七成。乘上"同时打五六只"，这就是刀线守夜能力
   * 的真正来源 —— 不在伤害上，在减伤上。
   *
   * 头狼免疫，否则 BOSS 战会变成推箱子。
   */
  private applyKnockback(wolf: WolfState, stats: WeaponStat): void {
    if (stats.knockback <= 0 || wolf.kind === "alpha") return;
    wolf.attackCooldown += stats.knockbackStun;
    const away = direction(this.player, wolf);
    // 走正常的碰撞与地形回退：直接改坐标会把狼推进崖壁里卡住抽搐。
    this.moveEntity(wolf, away.x * stats.knockback, away.z * stats.knockback, WOLF_RADIUS, false);
    this.events.push({ type: "knockback", wolfId: wolf.id });
  }

  // consumeJuice / consumeWater / consumeWashWater 已删除：它们只服务于 HUD 上那三颗
  // 快捷键和 R/F/C 热键。消耗现在一律走背包的物品格（开背包会暂停游戏），
  // "这份水拿来喝还是兑洗脸水"这个取舍因此发生在看得见全部存量的地方。
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
        this.events.push({ type: "message", key: "msg.13", params: { v0: COOKED_HEALTH } });
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
   * 换线不在这里 —— 它走 craftEquip(id) 直接指定另一条线的一阶，材料不返还。
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
    });
  }

  private craftUpgrade(next: EquipTier, apply: (tier: EquipTier) => void): boolean {
    if (!this.running) return false;
    // 判定半径与取暖、烤肉统一走 FIRE_WARMTH_RADIUS：原先这里单独写死 5.2，
    // 于是"站在营地里就算烤着火"对升级装备这一条不成立。
    if (next.needsFire && !this.findNearestLitFire(FIRE_WARMTH_RADIUS)) {
      this.events.push({ type: "message", key: "msg.16", params: { v0: loc(`equip.${next.id}.name`) } });
      return false;
    }
    const missing = next.cost.filter(([kind, count]) => this.getInventoryCount(kind) < count);
    if (missing.length > 0) {
      const need = this.describeCost(next.cost);
      this.events.push({ type: "message", key: "msg.17", params: { v0: loc(`equip.${next.id}.name`), v1: need } });
      return false;
    }
    this.noteInPlaceAction();
    for (const [kind, count] of next.cost) this.removeInventory(kind, count);
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

  /** 洗脸水：1 份水兑成 1 份洗脸水，降温效率翻四倍（原图 I01V）。 */
  craftWashWater(): boolean {
    if (!this.running) return false;
    if (this.getInventoryCount("water") < 1) {
      this.events.push({ type: "message", key: "msg.26" });
      return false;
    }
    if (this.getInventoryCount("wash-water") >= INVENTORY_STACK_LIMITS["wash-water"] * 2) {
      this.events.push({ type: "message", key: "msg.27" });
      return false;
    }
    this.noteInPlaceAction();
    this.removeInventory("water", 1);
    if (!this.addInventory("wash-water", 1)) {
      // 同烤肉：兑不出来就把那份水还回去，绝不能凭空蒸发。
      this.addInventory("water", 1);
      this.events.push({ type: "message", key: "msg.28" });
      return false;
    }
    this.events.push({ type: "craft-wash-water" });
    this.events.push({ type: "message", key: "msg.29" });
    return true;
  }

  getInventoryCount(kind: InventoryItemKind): number {
    return this.player.inventory.reduce((total, stack) => total + (stack?.kind === kind ? stack.count : 0), 0);
  }

  getInteractionHint(): InteractionHint {
    if (this.player.gatherTimer > 0) return { action: "well", text: loc("hint.drawing") };
    // 与 requestInteraction 保持一致：水分告急时，仙人掌优先、其次找井。
    if (this.player.water < WATER_URGENT && !this.player.carrying) {
      if (this.findNearestCactus(2.7)) return { action: "cactus", text: loc("hint.urgentCactus", { cost: STAMINA_COST_CACTUS }) };
      const urgentWell = this.findNearestWell(WELL_REACH);
      if (urgentWell) return { action: "well", text: loc("hint.urgentWell", { cost: STAMINA_COST_DRAW }) };
    }
    if (this.player.carrying) {
      return this.player.carrying === "stake"
        ? { action: "drop", text: loc("hint.dropStake") }
        : { action: "drop", text: loc("hint.dropStone") };
    }
    // 与 requestInteraction 同一套优先级：火塘只在比脚边的东西更近时才占住 E。
    if (this.getInventoryCount("wood") > 0) {
      const hearth = this.findNearestHearth(FIRE_WARMTH_RADIUS);
      if (hearth && !this.hasNearerTarget(hearth.distance)) {
        return { action: "feed", text: loc("hint.feed", { left: this.getInventoryCount("wood") }) };
      }
    }
    const item = this.findNearestItem(2.5);
    if (item) {
      return item.kind === "wood"
        ? { action: "pickup", text: loc("hint.takeWood", { cost: STAMINA_COST_WOOD }) }
        : { action: "pickup", text: loc("hint.liftStone") };
    }
    const structure = this.findNearestStructure(2.7);
    if (structure) return { action: "pickup", text: loc("hint.liftStake") };
    if (this.findNearestCactus(2.7)) return { action: "cactus", text: loc("hint.cactus", { cost: STAMINA_COST_CACTUS }) };
    if (this.findNearestIron(2.8)) return { action: "mine", text: loc("hint.mine", { cost: STAMINA_COST_MINE }) };
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
  // 现在普通狼的血量走头顶跟随血条（受伤才亮 2.6 秒），头狼走顶部 BOSS 条。

  getAlpha(): WolfState | null {
    return this.wolves.find((wolf) => wolf.kind === "alpha" && wolf.mode !== "dead") ?? null;
  }

  getAlphaProgress(): { kills: number; required: number; spawned: boolean; slain: boolean; minDay: number } {
    return {
      kills: this.player.kills,
      required: ALPHA_KILL_REQUIREMENT,
      spawned: this.alphaSpawned,
      slain: this.alphaSlain,
      minDay: ALPHA_MIN_DAY,
    };
  }

  /** 剑线连击的当前层数与上限，供 HUD 在攻击按钮上画进度弧。 */
  getComboState(): { stacks: number; max: number } {
    return { stacks: this.comboStacks, max: WEAPON_STATS[this.player.weapon].comboMax };
  }

  getObjective(): LocalizedText {
    if (!this.clockStarted) return loc("sim.7");
    if (this.player.gatherTimer > 0) return loc("sim.8");

    // 致命轴优先：水分和饥饿归零是立即死亡，必须压过其它所有提示。
    if (this.player.water < 18) return loc("sim.9");
    if (this.player.hunger < 18) return loc("sim.10");
    // 其次是瘫痪状态。
    if (this.player.condition === "hypothermia") return loc("sim.11");
    if (this.player.condition === "heatstroke") return loc("sim.12");

    if (this.player.resting) return loc("sim.13");
    // 枯木现在进背包，所以指引从"往哪搬"变成"够不够、去哪烧"。
    // 同样要让过 requestInteraction 的优先级：脚边有东西可捡时 E 不会去添柴，
    // 这里就不能喊"按互动键添柴"。
    if (this.getInventoryCount("wood") > 0) {
      const hearth = this.findNearestHearth(FIRE_WARMTH_RADIUS);
      if (hearth && !this.hasNearerTarget(hearth.distance)) return loc("sim.14");
    }
    // 头狼死了但天还没亮 —— 这是全局最紧张的一段，目标行必须只说这一件事。
    if (this.alphaSlain) return loc("sim.15", { v0: Math.max(0, Math.ceil(this.phaseTime)) });
    const alpha = this.getAlpha();
    if (alpha) return loc("sim.16", { v0: Math.max(0, Math.ceil(alpha.health)), v1: alpha.maxHealth });

    if (this.phase === "night") {
      if (this.player.warmth < 30) return loc("sim.17");
      const lit = this.getNearestLitCamp();
      if (!lit) return loc("sim.18");
      if (lit.fuel < 25) return loc("sim.19", { v0: Math.round(lit.fuel) });
      if (this.day === 1 && this.phaseTime > 60) return loc("sim.20");
      // 击杀数攒满但天数没到时，目标行得说清在等什么 —— 否则玩家会以为卡住了。
      if (this.player.kills >= ALPHA_KILL_REQUIREMENT && this.day < ALPHA_MIN_DAY) {
        return loc("sim.21", { v0: ALPHA_MIN_DAY });
      }
      return loc("sim.22", { v0: this.player.kills, v1: ALPHA_KILL_REQUIREMENT });
    }

    if (this.phase === "day" && this.day === 1 && this.phaseTime <= 14) return loc("sim.23");
    if (this.player.warmth > 78) return loc("sim.24");
    const retreatingWolves = this.wolves.filter((wolf) => wolf.mode === "retreating").length;
    if (retreatingWolves > 0) return loc("sim.25", { v0: retreatingWolves });
    if (this.objectiveStage === 0) return loc("sim.26", { v0: STAMINA_COST_WOOD });
    if (this.objectiveStage === 1) return loc("sim.27");
    if (this.objectiveStage === 2) return loc("sim.28");
    if (this.getInventoryCount("water") === 0 && this.getInventoryCount("cactus-juice") === 0) return loc("sim.29");
    if (this.getEquipped("armor").line === "none" && this.getInventoryCount("hide") > 0) return loc("sim.30");
    const wildWolves = this.wolves.filter((wolf) => wolf.role === "wild" && wolf.mode !== "dead").length;
    if (this.getEquipped("armor").line === "none" && wildWolves > 0) return loc("sim.31", { v0: wildWolves });
    // 三阶卡在狼牙上，而狼牙只有白天的大狼掉 —— 这条线索不给的话玩家找不到。
    if (this.getEquipped("weapon").tier === 2 && this.getInventoryCount("wolf-fang") < 3) {
      return loc("sim.32", { v0: this.getInventoryCount("wolf-fang") });
    }
    // 体力是恒定流失的轴，而烤肉是唯一的大额补给。身上有生肉却在掉血时，
    // 目标行直接把这条路指出来 —— 比等玩家自己翻背包发现要快得多。
    if (this.player.health < 62 && this.getInventoryCount("cooked-meat") === 0
      && this.getInventoryCount("raw-meat") > 0) {
      const lit = this.getNearestLitCamp();
      return lit
        ? loc("sim.cookNearby", { metres: Math.round(lit.distance), health: COOKED_HEALTH })
        : loc("sim.cookAnywhere");
    }
    if (this.getInventoryCount("raw-meat") === 0 && this.getInventoryCount("cooked-meat") === 0) {
      const oryx = this.critters.find((critter) => critter.kind === "oryx" && critter.mode !== "dead");
      if (oryx) return loc("sim.33");
      return loc("sim.34");
    }
    return loc("sim.35");
  }

  private updatePlayerMovement(delta: number, rawMovement: Vec2, isMoving: boolean): void {
    if (!isMoving) return;
    // 移动会打断取水，劳力不退还 —— 让取水成为一个需要站定的承诺。
    if (this.player.gatherTimer > 0) {
      this.player.gatherTimer = 0;
      this.events.push({ type: "message", key: "msg.30" });
    }
    this.noteActivity();
    const movement = normalize(rawMovement);
    this.player.facing = movement;
    const carryingPenalty = this.player.carrying ? 0.54 : 1;
    const needsPenalty = this.player.hunger < 12 || this.player.water < 12 ? 0.84 : 1;
    // 武器与护甲的移速系数相乘。全重装（熔渣重刀 + 熔渣板甲）是 0.92 × 0.88 = 0.810
    // → 6.64，全轻装是 1.06 × 1.09 = 1.155 → 9.47，差 43%。
    // 但 6.64 依然跑得过第 8 夜最快的狼（5.63）—— 慢是税，不是死刑。
    const gearScale = WEAPON_STATS[this.player.weapon].moveScale * ARMOR_STATS[this.player.armor].moveScale;
    const speed = 8.2 * carryingPenalty * needsPenalty * gearScale * this.getConditionSpeedScale();
    this.moveEntity(this.player, movement.x * speed * delta, movement.z * speed * delta, PLAYER_RADIUS, true);
  }

  private updateNeeds(delta: number): void {
    // --- 代谢：水分与饥饿独立衰减，任一归零立即死亡 ---
    this.player.water = clamp(this.player.water - delta * WATER_DECAY, 0, 100);
    this.player.hunger = clamp(this.player.hunger - delta * HUNGER_DECAY, 0, 100);

    // --- 体力恒定流失：把"吃饭"从可拖延的提示变成硬心跳（原图 -0.7/600HP）---
    this.player.health -= delta * HEALTH_DECAY;

    // --- 劳力回复：休息最快，静止其次，移动最慢 ---
    // 护甲整体缩放这三档：皮甲把防御换成产出（×1.35 时一个白天多回 99 点劳力
    // ≈ 6.6 次挖矿），铁甲反过来收税。
    const staminaRegen = (this.player.resting
      ? STAMINA_REST_REGEN
      : this.player.idleTime > 0.4
        ? STAMINA_IDLE_REGEN
        : STAMINA_ACTIVE_REGEN) * ARMOR_STATS[this.player.armor].staminaScale;
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
    // 三件事：喝水/洗脸水降温、贴火升温、以及就地调节（requestThermalAction）。
    //
    // 白天一定会热：地板 15 按 +0.69/s 爬到中暑线 100 要 123 秒，而白天有 180 秒。
    // 所以"白天必须喝水"不是建议，是硬性节奏。
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
  getRestBlocker(): LocalizedText | null {
    const player = this.player;
    if (player.gatherTimer > 0) return loc("sim.36");
    if (player.condition === "heatstroke") return loc("sim.37");
    if (player.condition === "hypothermia") return loc("sim.38");
    if (player.hunger < 20) return loc("sim.39");
    if (player.water < 20) return loc("sim.40");
    if (this.phase === "night" && player.warmth <= 30) return loc("sim.41");
    // 只有"刚挨过打"才禁止休息，而不是"附近有狼"。
    // 按距离判定会让夜里任何时候都休息不了 —— 夜间地图上本来就有几十只狼，
    // 20 米的追击半径几乎覆盖全图，玩家只会看到一句解释不了的"附近有狼"。
    if (this.combatTimer > 0) return loc("sim.42", { v0: Math.ceil(this.combatTimer) });
    if (player.idleTime < 5) return loc("sim.43", { v0: Math.ceil(5 - player.idleTime) });
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
      // 长角羚一次掉 4 块肉，背包常常只剩两格位置 —— 全有或全无的话玩家只能眼睁睁
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
        const armor = ARMOR_STATS[this.player.armor];
        this.combatTimer = REST_COMBAT_LOCK;
        this.noteActivity();
        // 闪避在减防御**之前**判定，闪掉的是整次咬击。
        // 但"挨打后 6 秒不能休息"的锁照常上 —— 闪开了也还是在战斗里。
        if (armor.dodge > 0 && this.random() < armor.dodge) {
          this.events.push({ type: "dodge" });
          return;
        }
        const damage = Math.max(1, wolf.attack - this.getDefense());
        this.player.health -= damage;
        this.player.hurtFlash = 0.3;
        this.events.push({ type: "player-hit", amount: damage });
        // 反伤按狼**未经防御削减**的原始攻击力算 —— 它咬的是一身铁，
        // 崩到几颗牙跟你穿得多厚没关系。
        if (armor.thorns > 0) {
          const reflected = Math.max(1, Math.round(wolf.attack * armor.thorns));
          wolf.health -= reflected;
          wolf.hurtFlash = 0.18;
          wolf.provoked = true;
          this.events.push({ type: "thorns", wolfId: wolf.id, amount: reflected });
          if (wolf.health <= 0) {
            wolf.mode = "dead";
            this.killWolf(wolf);
          }
        }
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
      // 杀死头狼**不再直接通关** —— 还得撑到天亮。
      //
      // 原先它一倒下就结算胜利，于是整局游戏的终点是一次 DPS 检查：走过去按住攻击。
      // 而剑三阶满层 220 DPS 打 836 血只要 3.8 秒，这个终点会短到不存在。
      // 改成"击杀 + 活到天亮"之后，头狼从终点变成高潮 —— 它倒下时你正站在
      // 四五十只狼中间、劳力见底，后面还有一整段残局要打，三阶装备也才有用武之地。
      // 这同时和 docs/survival-systems.md §0.1 为生化篇写好的胜利条件对齐了。
      this.alphaSlain = true;
      this.events.push({ type: "message", key: "msg.39" });
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
      // 狼牙：三阶装备的共同门槛，**只有白天的大狼**掉。
      //
      // 大狼占比是 min(0.58, 0.22 + (天数−1)×0.09)，第 1 天只有 22%、第 5 天才 58%，
      // 这把三阶自动锁到第 3 天以后 —— 不需要写任何天数判定。而大狼（血 95 /
      // 护甲 5 / 攻击 13）拿一阶装备去打是有风险的：三阶的门票是"你得敢主动
      // 找大狼打"，这比"再挖十块矿"有意思得多。
      if (wolf.kind === "large") this.createDrop(wolf, "wolf-fang", 0, 1);
    }
    this.events.push({ type: "wolf-killed", wolfId: wolf.id });
    this.maybeSpawnAlpha();
  }

  /** 累计击杀达标后，头狼在夜晚从地图边缘登场；白天达标则等到入夜。 */
  /**
   * 头狼登场。
   *
   * 除了累计击杀，还加了一道**时间闸** `day >= ALPHA_MIN_DAY`。
   * 原因：三阶装备卡在狼牙上，而狼牙只从白天的大狼掉、大狼占比要到第 3 天才爬上来；
   * 光靠击杀数当门槛的话，头狼可能在玩家还穿着一阶装备时就登场，
   * 二阶三阶整条阶梯没有使用场景 —— 十二件装备里有八件成了装饰品。
   */
  private maybeSpawnAlpha(): void {
    if (this.alphaSpawned || this.victorySent) return;
    if (this.player.kills < ALPHA_KILL_REQUIREMENT) return;
    if (this.day < ALPHA_MIN_DAY) return;
    if (this.phase !== "night") return;
    this.alphaSpawned = true;
    this.spawnWolf({ role: "raider", forceKind: "alpha" });
    this.events.push({ type: "alpha-spawned" });
    this.events.push({ type: "message", key: "msg.40" });
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
    if (tutorialWolf) this.events.push({ type: "message", key: "msg.41" });
    if (kind === "large" && role === "raider" && !this.largeWolfAnnounced) {
      this.largeWolfAnnounced = true;
      this.events.push({ type: "message", key: "msg.42" });
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
    // 长角羚是唯一会掉水的猎物：沙漠里猎杀大型有蹄类取体液是真实做法。
    if (spec.water > 0) this.createDrop(critter, "water", 1.8, spec.water);
    this.events.push({ type: "critter-killed", critterId: critter.id, kind: critter.kind });
  }

  getCritterLabel(kind: CritterKind): LocalizedText {
    return loc(`critter.${kind}.name`);
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
        key: litAtDusk && litAtDusk.fuel >= this.phaseTime ? "msg.duskFireOk" : "msg.duskFireShort",
      });
      // 白天打满击杀数的话，头狼会在入夜的这一刻登场。
      this.maybeSpawnAlpha();
      return;
    }
    // 头狼死了、而你撑到了天亮 —— 这才是通关。
    if (this.alphaSlain) {
      this.endGameWithVictory();
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
    this.events.push(fuel <= 0
      ? { type: "message", key: "msg.duskNoFire", params: { night, logs } }
      : { type: "message", key: "msg.duskLowFire", params: { fuel: Math.round(fuel), night, logs } });
  }

  private updateObjectives(): void {
    // 每一天都预警，不再只有第 1 天。
    if (!this.duskWarningSent && this.phase === "day" && this.phaseTime <= 30) {
      this.duskWarningSent = true;
      this.warnDuskFuel();
      if (this.day === 1) {
        this.events.push({ type: "message", key: "msg.45" });
      }
    }
    // 枯木改为进背包之后，这一阶不能再只看 carrying —— 否则捡了柴也不算数，
    // 玩家会永远卡在"拿起身边的枯木"。
    if (this.objectiveStage === 0 && (this.player.carrying || this.getInventoryCount("wood") > 0)) {
      this.objectiveStage = 1;
      this.events.push({ type: "message", key: "msg.46" });
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
    item.hp = kind === "stone" ? 220 : 70;
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
