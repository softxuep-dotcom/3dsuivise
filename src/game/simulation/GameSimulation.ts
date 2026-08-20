import {
  clamp,
  direction,
  distance,
  distanceSquared,
  dot,
  mulberry32,
  normalize,
  rotateToward,
  segmentIntersectsCircle,
  TAU,
} from "./geometry";
import { campGatePosition, campLocalToWorld, isTerrainWalkable, terrainHeightAt, terrainSlopeAt } from "../terrain/TerrainModel";
import { NavigationGrid } from "./NavigationGrid";
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
  RetrofitId,
  SaltCrustState,
} from "./types";
import { PLAYER_RADIUS, STONE_COLLIDE_RADIUS, WOLF_RADIUS, BARRIER_STATS, CRITTER_SPECS, FUEL_REQUIRED, INVENTORY_CAPACITY, INVENTORY_STACK_LIMITS, STRUCTURE_SPECS,
  RETROFIT_DRAW, RETROFIT_IDS, RETROFIT_LOG_SECONDS, RETROFIT_MEDKIT_HEAL, RETROFIT_MEDKIT_TRIGGER,
  RETROFIT_SLOW_SCALE, RETROFIT_TRUCK_RADIUS, RETROFIT_FIRE_RADIUS, RETROFIT_COOLDOWN_SCALE } from "./types";
import type { Difficulty, DifficultyTuning } from "./difficulty";
import { DEFAULT_DIFFICULTY, tuningFor } from "./difficulty";

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

/*
 * 第一天 90 → 40 秒。
 *
 * Poki 实测 11 场会话时长中位数 **52 秒**，而入夜原本在第 90 秒 —— 也就是
 * **73% 的玩家从没见过夜**，而夜袭是这个游戏的全部。四条装备线、体温双向夹逼、
 * 井的回蓄、狗巢，全都住在他们看不到的地方。
 *
 * 40 而不是 35：出生点脚边就有 4 根枯木，捡 3 根 + 添柴实测要十几秒，
 * 再留一点给"囤水"那步，35 秒会把引导链压得没法完成。40 秒下中位玩家
 * 仍然能在离开前看到天黑。
 *
 * 这条只缩白天，不动 FIRST_NIGHT_DURATION：第一昼夜因此从 240 秒降到 190 秒，
 * 而开局口粮是按 240 秒配的（见 STARTING_RATION 那段），所以只会更宽松，不会饿死人。
 *
 * ---
 *
 * **1.0.23：40/150 → 55/120。第一个黎明从 3m10s 提到 2m55s。**
 *
 * 1.0.20 通过 Fit Test 之后，瓶颈从"没人见到夜"变成了"没人翻得过第一夜"。
 * 模拟层扫过第一夜长度（每档同一画像抖动 6 次）：
 *
 *   150s（原值）→ 黎明 3m10s → 活到黎明 1/6
 *   110s        → 黎明 2m30s → 活到黎明 3/6
 *    90s        → 黎明 2m10s → 活到黎明 5/6
 *
 * 取 120 而不是 90：90 秒的夜太短，夜袭是这游戏的全部内容，砍到只剩一波半
 * 等于把主菜端走。120 落在扫描表 110 与 150 之间，保住压迫感又让黎明够得着。
 *
 * 白天 40 → 55 是**配套的另一半**，不能只改夜：
 *   · 第 1 天原本是全游戏唯一收支倒挂的一天（40 昼 / 150 夜 = 1:3.75，
 *     而第 2 天起是 180/180 = 1:1），而它恰好是绝大多数玩家唯一经历的一天。
 *   · 多出的 15 秒正好够多搬一趟油桶（最近的野外桶 32 米，单趟实测 12 秒），
 *     所以第一昼夜的通关进度从"最多 1 格"变成"能推到 2 格"。
 *
 * **上面那张扫描表是把白天钉死在 40 秒扫出来的，加了白天这一版必须重测**，
 * 不能直接引用——白天变长会同时改变备柴量、体温起点和装备进度。
 */
const FIRST_DAY_DURATION = 55;
const FIRST_NIGHT_DURATION = 120;
const LATER_DAY_DURATION = 180;
const SECOND_NIGHT_DURATION = 180;
const LATER_NIGHT_DURATION = 180;
/** 地形拒绝整步移动时依次尝试的缩短比例，见 stepAxis()。 */
const MOVE_STEP_FALLBACKS = [1, 0.5, 0.25];
/** 挨打后多少秒内不能休息（原本是"附近有狼"，夜里几乎恒为真）。 */
/**
 * 站定多久开始休息。5 → 4 → 3 秒。
 *
 * 这个门槛是"休息"这件事的全部成本 —— 它换来的是劳力和生命的快速回复，
 * 而战斗封锁（REST_COMBAT_LOCK = 6 秒）本来就挡住了"边打边回"。
 * 5 秒在实战里常常等不到：夜里几乎每 6 秒就会被摸一下，等于永远进不去。
 *
 * 降到 3 秒还有个手感上的理由：站定是移动端玩家**唯一放开摇杆的时刻**，
 * 门槛越高，手就被按得越久。文案里写死了这个秒数（hud.drain.hint，六个语言），
 * 改这里记得一起改。
 */
const REST_IDLE_SECONDS = 3;

/** 猎物降频更新的距离与步长，和狼一套口径，见 WolfDirector 的 LOD_DISTANCE。 */
const CRITTER_LOD_DISTANCE = 50;
const CRITTER_LOD_STRIDE = 4;

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
 *
 * ## 一阶**不再全都要兽皮**
 *
 * 原先四件一阶（砍刀Ⅰ / 剑Ⅰ / 铁甲Ⅰ / 皮甲Ⅰ）**每一件都要兽皮**，而兽皮只从
 * 白天的野狗和长角羚身上来 —— 于是"能不能开始变强"这件事被一条线卡死了：
 * 没打到猎物之前，挖再多矿、捡再多柴，四件里一件也造不出来。玩家手里攒着材料
 * 却什么都点不了，那是最难受的一种卡关，而且它卡的正是第一天。
 *
 * 现在每个槽位各有一条**不要兽皮**的路：
 *
 *   武器  砍刀Ⅰ = 铁矿 ×4          剑Ⅰ   = 兽皮 ×1 + 枯木 ×2
 *   护甲  铁甲Ⅰ = 铁矿 ×4          皮甲Ⅰ = 兽皮 ×4
 *
 * 换掉的兽皮按 1:1 折成铁矿（砍刀 3+1皮 → 4，铁甲 2+2皮 → 4），
 * 所以铁线的总成本没变松，只是把"要打猎"换成了"要挖矿"——
 * 而挖矿是随时能做的事。二三阶不动：那时候你早该出过门了。
 */
const WEAPON_TIERS: EquipTier[] = [
  { id: "survival-knife", line: "none", tier: 0, cost: [], needsFire: false, attack: 30 },

  { id: "saber-1", line: "saber", tier: 1, needsFire: true, attack: 34,
    cost: [["iron-ore", 4]] },
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
 * 30.0 / 35.2 / 35.9（逐阶）。后期精英狼的攻击已经过线，普通狼群则更适合用重甲扛。
 * 所以**重甲是守夜的甲，皮甲是扛精英重击的甲**，这不是平衡说辞，是公式的形状。
 */
const ARMOR_TIERS: EquipTier[] = [
  { id: "none", line: "none", tier: 0, cost: [], needsFire: false, defense: 2 },

  { id: "scale-1", line: "scale", tier: 1, needsFire: true, defense: 8,
    cost: [["iron-ore", 4]] },
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
  /** 刀线击退：推开的米数。精英狼免疫。 */
  knockback: number;
  /** 刀线击退真正值钱的部分：把目标的咬击往后推多少秒。 */
  knockbackStun: number;
  /** 剑线连击：每段加多少伤害。0 表示这把武器吃不到连击。 */
  comboStep: number;
  comboMax: number;
  /** 一次挥砍只要命中至少一个目标，就恢复固定体力；群攻不会按目标数叠加。 */
  healthOnHit: number;
}

/**
 * 武器属性表。冷却全线统一（见 ATTACK_COOLDOWN），分化靠下面这些不依赖动画的轴。
 *
 * 刀线与剑线的关系不是强弱，是两个方向各自约两倍：
 *   被围（6 只均匀分布）——  刀三扫到 77.8%，剑三只扫到 30.6%，刀线领先 1.75×
 *   单体持久战          ——  剑三满层 228 DPS 对刀三 104.5，剑线领先 2.18×
 *
 * 早先的版本让刀线**同时**拥有大面积、低劳力、破甲与击退，剑线只有 +33% 单击，
 * 而单击优势只在"面前恰好一个目标"时兑现 —— 主要用于大狼与精英狼。
 * 于是刀线全面压制。修正有两处：劳力两线拉平（刀一次打好几个还收费更低等于白送），
 * 以及给剑线一个**刀线结构上吃不到**的机制 —— 连击。刀每一刀都换目标，永远停在 0 段。
 */
const WEAPON_STATS: Record<WeaponKind, WeaponStat> = {
  "survival-knife": { range: 3.1, arcDot: 0.174, stamina: 4, pierce: 0, critChance: 0, critMult: 1, moveScale: 1.00, knockback: 0, knockbackStun: 0, comboStep: 0, comboMax: 0, healthOnHit: 0 },

  "saber-1": { range: 3.4, arcDot: -0.342, stamina: 5, pierce: 2, critChance: 0, critMult: 1, moveScale: 0.98, knockback: 0.35, knockbackStun: 0.20, comboStep: 0, comboMax: 0, healthOnHit: 3 },
  "saber-2": { range: 3.6, arcDot: -0.574, stamina: 6, pierce: 5, critChance: 0.12, critMult: 1.8, moveScale: 0.95, knockback: 0.50, knockbackStun: 0.30, comboStep: 0, comboMax: 0, healthOnHit: 5 },
  "saber-3": { range: 3.8, arcDot: -0.766, stamina: 7, pierce: 8, critChance: 0.15, critMult: 2.0, moveScale: 0.92, knockback: 0.70, knockbackStun: 0.40, comboStep: 0, comboMax: 0, healthOnHit: 10 },

  "sword-1": { range: 3.2, arcDot: 0.643, stamina: 5, pierce: 0, critChance: 0.20, critMult: 1.8, moveScale: 1.00, knockback: 0, knockbackStun: 0, comboStep: 0.10, comboMax: 3, healthOnHit: 3 },
  "sword-2": { range: 3.3, arcDot: 0.643, stamina: 6, pierce: 0, critChance: 0.30, critMult: 2.0, moveScale: 1.03, knockback: 0, knockbackStun: 0, comboStep: 0.12, comboMax: 4, healthOnHit: 5 },
  "sword-3": { range: 3.4, arcDot: 0.574, stamina: 7, pierce: 0, critChance: 0.40, critMult: 2.2, moveScale: 1.06, knockback: 0, knockbackStun: 0, comboStep: 0.15, comboMax: 4, healthOnHit: 10 },
};

interface ArmorStat {
  /** 命中判定前掷骰，闪掉整次咬击。只有皮甲线有。 */
  dodge: number;
  /** 把狼**未经防御削减**的原始攻击力的这个比例弹回去。只有铁甲线有。 */
  thorns: number;
  moveScale: number;
  /** 乘在三档劳力回复上。皮甲提供加成，铁甲保持基础回复速度。 */
  staminaScale: number;
}

const ARMOR_STATS: Record<ArmorKind, ArmorStat> = {
  none: { dodge: 0, thorns: 0, moveScale: 1.00, staminaScale: 1.00 },

  "scale-1": { dodge: 0, thorns: 0.12, moveScale: 0.97, staminaScale: 1.00 },
  "scale-2": { dodge: 0, thorns: 0.22, moveScale: 0.93, staminaScale: 1.00 },
  "scale-3": { dodge: 0, thorns: 0.35, moveScale: 0.88, staminaScale: 1.00 },

  "hide-1": { dodge: 0.12, thorns: 0, moveScale: 1.02, staminaScale: 1.12 },
  "hide-2": { dodge: 0.24, thorns: 0, moveScale: 1.05, staminaScale: 1.22 },
  "hide-3": { dodge: 0.38, thorns: 0, moveScale: 1.09, staminaScale: 1.35 },
};

/**
 * 连击窗口：换目标、或这么久没有命中，层数清零。
 * 冷却是 0.55 秒，正常连打够用；被打断走位一次就断 —— 这正是"咬住一个目标"的代价。
 */
const COMBO_WINDOW = 1.2;

/*
 * 精英狼登场的夜数**跟着难度走**（简单 3 / 普通 2 / 令人发狂 1），
 * 见 difficulty.ts 的 eliteMinDay。之后逐日提高出现率，但永远只是少数。
 */

// 肉的两级。生肉顶饿不回体力，烤肉才回 —— 烤肉的价值全在体力那一条上。
const RAW_HUNGER: readonly [number, number] = [12, 18];
const RAW_WATER: readonly [number, number] = [2, 6];
const COOKED_HUNGER: readonly [number, number] = [26, 38];
const COOKED_WATER: readonly [number, number] = [5, 10];
/**
 * 熟肉回的体力，14 → 26。
 *
 * 这一刀是在给"休息"让路。体力原先只有一条真正管用的回复途径 —— 站定 3 秒进入
 * 休息，净 +2.6/s。但**站着不动本身不是玩法**：这是个动作游戏，静止的那 38 秒里
 * 玩家什么也没在做，还得盯着别被狗打断（挨一口就锁 6 秒）。实际结果是大部分人
 * 根本不用这条路，于是他们的体力只出不进，被 HEALTH_DECAY 慢慢磨死。
 *
 * 26 点 ≈ 108 秒的恒定流失，一块熟肉从"够撑一分钟"变成"够撑两分钟"。
 * 打猎 → 烤肉 → 回体力这条主动循环因此变成体力的**主路**，休息退成一个
 * 安全时才用得上的加速手段。上限仍然是 100，所以囤肉不会变成囤血。
 */
 // 导出：烤肉按钮上要写"回体力多少"，而那个数**只能有一个来源**。
 // 曾经在 HudController 里另抄了一份字面量 14，这次把 14 改成 26 时它没跟着动，
 // 背包里于是出现一句和实际收益对不上的说明 —— 那种错正是玩家最信不过的一类。
export const COOKED_HEALTH = 26;
/**
 * 生肉回的体力，取熟肉的一半。
 *
 * 原先是 0 —— "生肉完全不回体力"。那条设计的意图是让烤肉有存在理由，但它把
 * 生肉变成了一个几乎没有反馈的物品：吃下去只有饥饿条动，而饥饿是五条轴里
 * 最不容易要命的一条（中位玩家 75 秒阵亡时饱食还有 52）。
 *
 * 改成一半之后取舍还在 —— 走一趟火边仍然能把收益翻倍 —— 但生吞至少是一个
 * 看得见效果的动作，而"看得见效果"正是新玩家判断一个物品有没有用的唯一依据。
 */
const RAW_HEALTH = Math.round(COOKED_HEALTH / 2);


// --- 体温调节动作 ---
// 降温的主力从来不该是喝水（饮品只给 -5~12），而是这类**零资源消耗**的动作。
// 它们的存在保证了玩家再穷也有自救手段，不会被锁死在中暑/失温里。
//
// 冷却 40 → 120 秒。基准版本用**劳力成本**（10 / 15）限制它们，我们改成零消耗 +
// 长冷却，那冷却就必须真的长：40 秒时一个白天能按三次，把中暑线从 123 秒推到 188 秒，
// 而白天只有 180 秒 —— 等于零代价地抹掉了"白天必定中暑"这条压力，喝水降温也
// 失去存在理由。120 秒把它压回**每相位一次**的自救阀门：白天中暑推迟到 145 秒、
// 夜里失温推迟到 95 秒，两者都仍然会在相位内发生。
//
// 90 秒以上其实结果相同（舒适区门槛卡着，第二次永远来不及按），取 120 是为了留出余量，
// 又不像 180 那样让白天用掉的那次连夜里也一起锁死。
const COOL_ACTION_WARMTH = 15;    // 就地降温：固定 -15
const COOL_ACTION_COOLDOWN = 120;
const WARM_ACTION_WARMTH = 25;    // 就地取暖：固定 +25
const WARM_ACTION_COOLDOWN = 120;
/** 落在这个区间内两个方向都不给按，避免玩家在舒适区里空转 CD。 */
const THERMAL_COMFORT_LOW = 35;
const THERMAL_COMFORT_HIGH = 62;

// --- 仙人掌汁：随机区间而不是固定值 ---
// 补水 8~16 → 11~20、降温 5~10 → 8~14。仙人掌是满地都有的散装水源，
// 但一趟只回一格多水的话，玩家宁可绕远路去井；抬一点让"顺手割一根"真的顶用。
const JUICE_WATER: readonly [number, number] = [11, 20];
const JUICE_HUNGER: readonly [number, number] = [1, 5];
const JUICE_WARMTH: readonly [number, number] = [8, 14];
const DROP_LIFETIME = 180;

/**
 * 教学猎物：拾骨鸦，三只，出生点前方 5.5~7.0 米。
 *
 * 为什么是拾骨鸦而不是铠甲虫：它是除长角羚外体型最大的一种（scale 1.15 对
 * 铠甲虫 0.68），而长角羚太快、不能当教学目标。个头是这一步的全部意义 ——
 * 玩家要在第一眼就看见"那儿有个东西可以砍"，一个半米高的色块做不到这件事。
 *
 * 它的逃速 / 游荡 / 警觉都为此重配过（见 CRITTER_SPECS.corvid），所以站得住。
 * 顺带一提，教学期间世界是冻结的（updateCritters 在时钟闸之后），它连动都不会动；
 * 调慢是为了教学**结束之后**玩家回头还找得到它。
 *
 * 落点半径 6.3~7.8：**必须真的留出余量**，不能贴着警觉半径 5.5 摆。
 * 第一版取 5.5，实测最近那只落在 5.4999…，正好压线 —— 开局它就处在将逃未逃的状态，
 * 玩家一挪脚它就开始跑。现在最近的一只留 0.8 米余量，最远的留 2.3 米。
 * 上限受相机约束：拉近后横屏焦点平面横向可见 43 米，7.8 米还在画面正中。
 */
export const TUTORIAL_PREY: CritterKind = "corvid";
const TUTORIAL_PREY_COUNT = 3;
const TUTORIAL_PREY_SPREAD: readonly number[] = [0.08, -0.58, 0.66];
const TUTORIAL_PREY_RADIUS: readonly number[] = [6.3, 7.8, 7.0];

/**
 * 教学枯木：教「行动键」用的那一根，撒在出生点侧后方 6.5 米。
 *
 * 为什么非得新加一根：全图 53 根枯木最近的一根在 18 米外，而教学的四个目标
 * 都该在一屏之内。角度特意岔开甲虫那三只（它们在 −0.55~+0.62 弧度），
 * 于是"打虫"和"捡柴"是两个方向，玩家不会一次站定就把两步都做完。
 *
 * 选枯木而不是别的：枯木 → 生火 → 活过第一夜是唯一一条真救命的链，而且教学一结束，
 * objectiveStage 因为背包里有柴会直接跳到第 1 阶「走到篝火旁添柴」，交接是无缝的。
 */
const TUTORIAL_WOOD_SPREAD = 1.15;
const TUTORIAL_WOOD_RADIUS = 6.5;

// ============================================================================
// 五轴生存模型
//
//   体力(health)  恒定流失，是"该吃饭了"的硬心跳
//   劳力(stamina) 采集与攻击的预算，休息回得快、行动回得慢
//   体温(warmth)  白天有地板、夜晚有天花板 ⇒ 中暑只在白天、失温只在夜晚
//   水分(water)   归零立即死亡
//   饥饿(hunger)  归零立即死亡
//
// 基准版本昼夜周期 750 秒，我们是 240~255 秒，所以速率不是简单等比缩放，
// 而是按"在一个昼夜内应该发生几次危机"重新配平，偏离处见下方注释。
// ============================================================================

// --- 体温 ---
const WARMTH_MIN = 0;
const WARMTH_MAX = 100;
const WARMTH_INITIAL = 22;
/** 白天地板：低于此值会被拉回，所以白天冻不死。（基准值 15） */
const WARMTH_DAY_FLOOR = 15;
/** 夜晚天花板：高于此值会被压回，所以夜晚中不了暑。（基准值 80） */
const WARMTH_NIGHT_CEILING = 80;
/** 中暑触发/解除阈值，迟滞避免在边界反复横跳。（基准值 100 / 95） */
const WARMTH_HEAT_ENTER = 100;
const WARMTH_HEAT_EXIT = 92;
/** 失温触发/解除阈值。（基准值 5 / 5，我们放宽解除以免瞬间反复） */
const WARMTH_COLD_ENTER = 5;
const WARMTH_COLD_EXIT = 14;
// 昼夜各 180 秒，与基准的 375/375 同为对称结构，所以时间压缩系数是全局统一的
// ×2.083（= 750/360）。下面三条体温速率都是基准值 ×2.083 得来，
// 结果是各阶段占相位的比例与基准完全一致。
/** 白天 +0.69/s：从白天地板 15 爬到中暑线 100 需 123 秒，占白天的 68% —— 白天必定中暑。 */
const WARMTH_DAY_BASE = 0.69;
/**
 * 夜间 -1.05/s：从天花板 80 掉到失温线 5 需 71 秒，占夜晚的 40%。
 *
 * 这一条**故意偏离** ×2.083 的等比换算（严格换算是 1.39）。原因是时间压缩保住了
 * 比例却保不住手感：基准夜损 0.667 给玩家 118 秒的外出窗口，等比压缩后只剩 54 秒 ——
 * 比例同样是三成，但人做决策、导航、应对突发所需要的是**绝对秒数**，它不随游戏时钟缩放。
 * 54 秒的窗口玩家根本不敢出门，夜晚就退化成"蹲在火边发呆"。
 * 所以换算规则在这里有例外：凡是玩家必须在其内做出反应的时长，都要额外放宽。
 */
const WARMTH_NIGHT_LOSS = 1.05;
// 劳作产热已移除。基准版本根本没有这一项，而我们曾把它设成 +0.9/s
// —— 是白天基线的 2.7 倍，直接导致"正常采集必然中暑且无法自救"。
/** 篝火 +3.16/s：夜晚静止净 +1.77/s，约 45 秒从 0 回满到天花板 80。 */
const WARMTH_FIRE_GAIN = 3.16;
/**
 * 篝火有效半径 10.0。
 * 基准版本里火堆光环半径是 320 游戏单位；按移速换算（基准主角 240 / 我们 8.2，
 * 约 29.3 单位 = 1 米）折合 **10.9 米**，我们此前只有 5.5，不到一半。
 * 放大之后语义从"必须贴着火站"变成"待在营地里就算烤着火" —— 这正是基准版本的行为，
 * 也让添柴、烤肉、升级装备这些营地事务不必再挤在火堆脚下完成。
 */
const FIRE_WARMTH_RADIUS = 10.0;

// --- 体力：恒定流失（基准 600HP / -0.7/s ≈ 857 秒） ---
const HEALTH_DECAY = 0.24; // 100 / 0.24 ≈ 417 秒 ≈ 1.16 个昼夜（基准 857/750 = 1.14）

/**
 * 吃饱喝足时的自然回复。0.30 → 0.60。
 *
 * 原来是**止损**而不是回血：净 0.30 − 0.24 = +0.06/s，回满要 1000 秒，
 * 也就是玩家永远看不见它动。现在净 +0.36/s，回满 278 秒 ≈ 一个半白天 ——
 * 慢得不可能拿来当战斗续航，但"我一直吃饱喝足"这件事终于有了看得见的回报。
 *
 * 门槛仍然卡在饱食**和**水分都高于 70，而两条轴都按 0.42/s 掉：从满值掉到 70
 * 只要 71 秒。所以这不是"什么都不做就回血"，而是"持续维持双满才回血"，
 * 它奖励的正是那个一直在找水找肉的玩家。任一掉下去立刻回到净流失。
 *
 * 刻意不做成随时间递增或按比例回复：那会变成真正的自动回血，
 * 把打猎→烤肉→回体力整条循环的压力抽掉。
 */
const HEALTH_PASSIVE_REGEN = 0.60;
const HEALTH_PASSIVE_NEED = 70;

/**
 * 开局口粮。**这是新手能不能活过第一夜的分水岭**，不是送温暖。
 *
 * 把两条时间轴对齐就明白了 —— 开局饱食 82、水分 90，两者都按 0.42/s 掉，
 * 且**归零即死**（见 update() 里的结算）：
 *
 *   饿死 195s · 渴死 214s · 而第二天黎明在 90 + 150 = 240s
 *
 * 也就是说背包空着出门的玩家，算术上撑不到第二个黎明。而第一个白天只有 90 秒，
 * 这 90 秒里 getObjective() 的引导链正把他按在"捡枯木→添柴→封门"上，
 * "去囤水"（sim.29）排在这三步**全部做完之后**；入夜之后游戏又明确让他守着火别出门
 * （sim.20 / sim.nightHold）。照着游戏自己的指引走，第一夜必死。
 *
 * 2 水 + 1 熟肉刚好把人送过那道线。注意**两条需求轴都封顶 100**，所以口粮值多少
 * 不看给了几份，只看**什么时候吃** —— 按提示在预警线（饱食<18，t≈152s）吃下熟肉：
 *
 *   饱食 18 → 44~56（COOKED_HUNGER 是 26~38 的随机） → 黎明 240s 时剩 7~19
 *
 * 也就是天亮那一刻饱食条正在闪红：玩家不是被送过关，是被准点推到
 * "天亮了我得去弄吃的"这个认知上。水那一路更宽松（渴死推到 337s）。
 *
 * 顺带逼他开一次背包 —— 那是吃、烤、造装备的总入口，不开就什么都学不会。
 *
 * **没有被这份口粮解决的事**：满值 100 ÷ 0.42 = 238s，而第一昼夜是 90+150 = 240s。
 * 也就是说哪怕开局两条轴都是满的、中途一口不吃，也差 2 秒撑不到黎明。
 * 开局就把口粮一次吃光的玩家（浪费掉溢出部分）仍然会在 238s 倒下。
 * 真要堵死这个口子得动 FIRST_NIGHT_DURATION 或衰减率，那是另一笔账。
 */
const STARTING_RATION: ReadonlyArray<readonly [InventoryItemKind, number]> = [
  ["water", 2],
  ["cooked-meat", 1],
  /*
   * 一根枯木。**这不是补给，是第一夜教学的道具。**
   *
   * 入夜那一段教学的第二拍是"走到火塘边点火"，而它是整段里唯一可能做不到的一拍 ——
   * 第一个白天只有 40 秒，捡一根柴要 30 劳力、还得先找到，玩家很可能天黑时两手空空。
   * 那时这一拍只能换成一句"白天要先捡枯木"然后跳过，等于最该教的那件事没教成。
   *
   * 送一根之后，"点火 → 火边取暖"这条链在第一夜必定走得通；而它也只够烧 95 秒，
   * 第一夜有 150 秒 —— 火仍然会在天亮前灭一次，"柴要自己囤"这一课半点没松。
   */
  ["wood", 1],
];

// --- 水分与饥饿（基准两者都是 -0.2/s，满值 500 秒） ---
const WATER_DECAY = 0.42;  // 238 秒 ≈ 0.66 个昼夜（基准 500/750 = 0.67）
const HUNGER_DECAY = 0.42; // 238 秒 ≈ 0.66 个昼夜（同水分，两轴等速）
/** 水分低于此值时，取水会抢占所有其它交互，避免玩家被拾取挡着渴死。 */
const WATER_URGENT = 32;

// --- 劳力（基准 225 上限、几乎不回复，靠睡觉补） ---
const STAMINA_MAX = 100;
const STAMINA_REST_REGEN = 7.5;   // 休息中
const STAMINA_IDLE_REGEN = 1.6;   // 站着不动但没进入休息
const STAMINA_ACTIVE_REGEN = 1.1; // 移动中：仍只有休息的 1/7，但走路不再是完全的死区
                                  // （0.5 时走满全图 200 秒才回满，而游戏大部分时间在走）
const STAMINA_COST_CACTUS = 10;
const STAMINA_COST_MINE = 15;
/**
 * 砍树 30，是捡柴（12）的两倍半。
 *
 * 这个价差就是"柴从哪来"的全部经济：地上现成的便宜、砍树贵。玩家自然会先捡光
 * 触手可及的，等那些没了再去砍树 —— 而砍树本来就该是后期的路，它是唯一
 * 在营地附近保底存在的燃料（每座营地保底两棵，见 createWorld）。
 */
const STAMINA_COST_CHOP = 30;
/** 一棵树砍两次砍空。 */
const TREE_WOOD = 2;
/** 砍树的够得着距离。比铁矿脉（2.8）远一点：树的树冠本来就占地方。 */
const TREE_REACH = 3.2;
/**
 * 捡一根枯木 12 劳力（原先 30）。
 *
 * 30 是全游戏最贵的常规动作 —— 等于砍倒一整棵树、两倍挖矿、三倍割仙人掌，
 * 而它只是弯腰捡一根棍子。一管劳力只够捡三根，提示上还明晃晃写着"劳力 30/根"：
 * 少数真去读提示的玩家，读到的是"这事很贵"。
 *
 * 实测两轮，20 个人里只有 3~4 个捡过柴，而带教学那一轮也没好转 ——
 * 也就是说这不是"不知道怎么捡"，是这个动作本身在劝退。而柴是唯一决定
 * 能不能活过第一夜的东西。
 *
 * 原注释给 30 的理由是"木头进背包后会变成免费无限，用采集成本接住稀缺性"。
 * 那条理由现在不成立了：**稀缺已经由存量兜住** —— 全图 56 根地上柴 + 26 棵树
 * 各两份，一根都不再生。再收 30 劳力是重复收税。
 *
 * 现在的价差改成表达"这根柴好不好拿"：地上现成的 12，砍树 30。
 * 于是玩家会先把地上的捡光，再开始考虑砍树 —— 这正是想要的顺序。
 */
const STAMINA_COST_WOOD = 12;
/**
 * 随身枯木每根 +2 攻击，最多两根生效。
 * 沿用「一块木头也能当武器使」的设计 —— 背包里的材料同时是个边际武器，
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
// 基准版本是「建造干枯的井」+「提水」两级技能，我们省掉建造直接预置几口井。
// 因此井是**地标**：它不产生"挖不挖"的赌博，而产生"今晚在哪过夜"的空间决策。
/** 井口有效交互半径。 */
const WELL_REACH = 3.2;

/**
 * 点击移动时，直线走法的最远验证距离。
 *
 * 上限存在的理由是**开销**而不是正确性：验一条直线要按 0.35 米逐段问地形和碰撞，
 * 60 米就是一百七十多段，而这件事每帧都要做一次。40 米已经比横屏可见宽度
 * （约 43 米）还长 —— 屏幕上点得到的地方基本都在里面，再远的点击本来就该
 * 交给流场去规划路线。
 */
const STRAIGHT_WALK_MAX = 40;

/** 每口井的蓄水上限，以及回蓄一次所需秒数。 */
const WELL_CHARGES_MAX = 3;
/**
 * 井的初始存量只有 1 格，不是满的。
 * 基准版本的井是多人分摊、而且要自己造（木头+石头+石头）；我们是单人还白送 5 口，
 * 所以必须在别处收紧。开局满存量意味着白送 20 份水 = 3.4 个昼夜，
 * 而一局才 2~3 天 —— 那样缺水压力整局都不会出现。
 * 回蓄速度没动：逛 1 口井覆盖需求的 29%、逛 2 口 59%，剩下的交给仙人掌和长角羚。
 */
const WELL_CHARGES_INITIAL = 1;
// 210 秒 = 一口井每昼夜再生 1.7 格，只覆盖一个玩家约 30% 的饮水需求，
// 和基准（500 容量 / +0.1/s ⇒ 1.5 次提水每昼夜）的比例一致。
// 曾经是 50 秒，那意味着单独一口井就够你活，井的空间决策等于不存在。
const WELL_REFILL_SECONDS = 210;
const WATER_RESTORE = 26;
/** 一份水降 14 点体温：正好能把刚中暑的 100 拉到解除线 92 以下。 */
const WATER_WARMTH_COST = 14;

/**
 * 复活后的无敌时长与清场半径。
 *
 * 两个都不能省：只清场不无敌，夜里几十只狗，推开 12 米也就两秒的事；
 * 只无敌不清场，无敌一结束你还站在犬群正中间。
 */
const REVIVE_GRACE_SECONDS = 3.5;
const REVIVE_CLEAR_RADIUS = 12;

/** 走到几米内可以搬起一桶油。 */
const FUEL_PICKUP_REACH = 2.6;
/** 扛着桶走到车尾几米内就算装车。半径给得比拾取宽，免得对着车找角度。 */
const TRUCK_LOAD_REACH = 4.5;
/**
 * 空着手站在车边几米内可以发车（油加满时）。
 * 和装车用同一个半径：卡车本身是半径 2.4 的实体障碍，玩家半径 0.72，
 * 也就是最近只能贴到 3.12 米 —— 判定再收紧一点就会出现"贴着车按不动"。
 */
const TRUCK_BOARD_REACH = 4.5;
/** 驶离速度与最长驶离时间（到边界就结算，这个上限只是保险）。 */
const TRUCK_DEPART_SPEED = 11;
const TRUCK_DEPART_MAX_SECONDS = 12;

/*
 * 脆盐壳承重。
 *
 * 数字按 10.4 米的短轴跨度校准：空手直穿只积约 23%，油桶直穿约 89%，
 * 大石会把环推入最后两秒，但路线走得直仍来得及撤出或把石头放下做落脚点。
 * 风险只收时间，不碰五轴，也不吞玩家手上的货物。
 */
const SALT_PRESSURE_RATE: Record<"empty" | "stake" | "fuel" | "stone", number> = {
  empty: 0.18,
  stake: 0.30,
  fuel: 0.38,
  stone: 0.52,
};
const SALT_PRESSURE_RECOVERY = 0.25;
const SALT_SUPPORT_RECOVERY = 0.62;
const SALT_WARNING_PRESSURE = 0.42;
const SALT_CRITICAL_PRESSURE = 0.72;
const SALT_GRACE_SECONDS = 2;
const SALT_COLLAPSED_SECONDS = 5;
// 放下的大石自身有 1.18m 碰撞半径；3.2m 支撑圈给玩家留出约 1.3m 的侧绕空间，
// 不会出现“石头明明稳住了地面，却被自己的碰撞卡死”的窄环。
const SALT_SUPPORT_RADIUS = 3.2;

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
  /** 狼群本体现在归 WolfDirector 管；这里保留同名入口，渲染层和 HUD 不用改。 */
  get wolves(): WolfState[] { return this.wolfDirector.wolves; }
  readonly critters: CritterState[] = [];
  readonly drops: WorldDrop[] = [];
  readonly barrels: FuelBarrelState[];
  /** 脆盐壳状态；渲染层只读这里，不从 Three.js 反推任何玩法。 */
  readonly saltCrusts: SaltCrustState[];
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
  private critterId = 0;
  private critterRespawnCountdown = 4;
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
  /** 玩家正扛着的那桶油；放下时要把同一个对象放回地面，而不是新建一桶。 */
  private carriedBarrel: FuelBarrelState | null = null;
  /** 入区提示每块只说一次，反复进出只保留环、裂纹和声音。 */
  private readonly visitedSaltCrusts = new Set<number>();
  /** >0 表示卡车正在驶离，玩家已经在车上，只剩结算动画。 */
  private departTimer = 0;
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
    this.saltCrusts = world.saltCrusts.map((site) => ({
      ...site,
      pressure: 0,
      stage: "stable" as const,
      inside: false,
      supported: false,
      graceRemaining: 0,
      collapsedRemaining: 0,
      entry: null,
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
      kills: 0,
    };
    for (const [kind, count] of STARTING_RATION) this.addInventory(kind, count);
    this.navigation.rebuild(this.player, this.getFlowFieldObstacles());
    this.wolfDirector = new WolfDirector(this.createWolfWorld());
  }

  /** 鹿模型下载完成后一次性启用猎物种群；重复调用不会重复撒怪。 */
  enableCritters(): void {
    if (this.crittersEnabled) return;
    this.crittersEnabled = true;
    this.seedCritters();
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
        sim.player.health -= amount;
        sim.healthDamageCause = "killed";
        sim.healthDamageAttacker = attacker.kind;
      },
      setCombatTimer: (seconds) => { sim.combatTimer = seconds; },
      noteActivity: () => sim.noteActivity(),
      getDefense: () => sim.getDefense(),
      hasRetrofit: (id) => sim.retrofits.has(id),
      getWolfSpeedScale: (x, z) => sim.getWolfSpeedScaleAt(x, z),
      getPhaseDuration: () => sim.getPhaseDuration(),
      getPlayerShelter: () => sim.getPlayerShelter(),
      getPlayerArmor: () => ARMOR_STATS[sim.player.armor],
      createDrop: (position, kind, angleOffset, count) => sim.createDrop(position, kind, angleOffset, count),
      moveEntity: (entity, dx, dz, radius, collideWithItems, terrainSlopeAllowance) =>
        sim.moveEntity(entity, dx, dz, radius, collideWithItems, terrainSlopeAllowance),
      canStepToward: (from, dir, radius, collideWithItems) => sim.canStepToward(from, dir, radius, collideWithItems),
      findSteppableDirection: (from, desired, collideWithItems) =>
        sim.findSteppableDirection(from, desired, collideWithItems),
      findNearestWalkablePoint: (origin) => sim.findNearestWalkablePoint(origin),
      lineOfSightBlocked: (start, end) => sim.lineOfSightBlocked(start, end),
      hasMeleeLine: (start, end) => sim.hasMeleeLine(start, end),
      distanceToWorldEdge: (point) => sim.distanceToWorldEdge(point),
      getSteeredDirection: (entity, desired) => sim.getSteeredDirection(entity, desired),
      getBarrierDamage: (wolf, armor) => sim.getBarrierDamage(wolf, armor),
      isBlockingGroundItem: (item) => sim.isBlockingGroundItem(item),
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
    const previousPlayerPosition = { x: this.player.x, z: this.player.z };
    this.updatePlayerMovement(delta, movement, isMoving);
    // 放在时钟闸之前：教学暂停的是昼夜与生存轴，不是脚下会不会塌。
    this.updateSaltCrusts(delta, previousPlayerPosition);
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
    if (!isMoving) this.player.idleTime += delta;
    this.navigationCountdown -= delta;
    if (this.navigationCountdown <= 0) {
      this.navigation.rebuild(this.player, this.getFlowFieldObstacles());
      this.navigationCountdown = 0.65;
    }

    this.updateNeeds(delta);
    this.updateFires(delta);
    this.updateCacti();
    this.updateWells();
    this.updateStructures(delta);
    if (this.crittersEnabled) this.updateCritters(delta);
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

  /** 本局已拥有的改装。软重启会新建 GameSimulation，不用手动清。 */
  readonly retrofits = new Set<RetrofitId>();
  /** 急救包只触发一次。 */
  private medKitUsed = false;

  /**
   * 这一点上的狼移速倍率。加固车厢（卡车 8m）与火圈（点着的篝火 6m）各给一个减速区。
   *
   * **算在 GameSimulation 而不是 WolfDirector**：卡车位置和篝火燃料都住在这边，
   * 狼那头只需要问"我站的地方慢不慢"。两个区重叠时不叠加 —— 取一次 0.7 就够，
   * 叠成 0.49 会让"把营地扎在卡车边"变成唯一解，把选择压成定式。
   */
  getWolfSpeedScaleAt(x: number, z: number): number {
    if (this.retrofits.has("reinforced-bed")
      && Math.hypot(x - this.truck.x, z - this.truck.z) <= RETROFIT_TRUCK_RADIUS) return RETROFIT_SLOW_SCALE;
    if (this.retrofits.has("fire-ring")
      && this.nearLitFire(x, z, RETROFIT_FIRE_RADIUS)) return RETROFIT_SLOW_SCALE;
    return 1;
  }

  hasRetrofit(id: RetrofitId): boolean {
    return this.retrofits.has(id);
  }

  /**
   * 从未拥有的改装里抽 RETROFIT_DRAW 个。池子空了就返回空数组（调用方据此不发面板）。
   * 用 this.random() 而不是 Math.random()：同一个种子要能复现整局。
   */
  private drawRetrofits(): RetrofitId[] {
    const pool = RETROFIT_IDS.filter((id) => !this.retrofits.has(id));
    const picked: RetrofitId[] = [];
    while (picked.length < RETROFIT_DRAW && pool.length > 0) {
      picked.push(...pool.splice(Math.floor(this.random() * pool.length), 1));
    }
    return picked;
  }

  /** 玩家在面板上点了一件。不在待选列表里的一律忽略，防止 UI 传错。 */
  chooseRetrofit(id: RetrofitId): boolean {
    if (this.retrofits.has(id) || !RETROFIT_IDS.includes(id)) return false;
    this.retrofits.add(id);
    this.events.push({ type: "retrofit-taken", id });
    return true;
  }

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
    if (this.player.carrying === "fuel" && this.carriedBarrel
      && distance(this.player, this.truck) <= TRUCK_LOAD_REACH) {
      this.loadCarriedBarrel();
      return;
    }

    if (this.player.carrying) {
      this.dropCarriedItem();
      return;
    }

    // 空手站在加满油的车边 = 发车。放在拾取之前，否则车边掉了根柴就永远上不了车。
    if (this.truck.loaded >= FUEL_REQUIRED && distance(this.player, this.truck) <= TRUCK_BOARD_REACH) {
      this.departWithTruck();
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
        // 备用油罐把单根柴从 95 秒抬到 130 秒，见 RETROFIT_LOG_SECONDS。
        const logSeconds = this.retrofits.has("fuel-can") ? RETROFIT_LOG_SECONDS : 95;
        this.camps[hearth.campId].fuel = clamp(this.camps[hearth.campId].fuel + logSeconds, 0, 300);
        this.events.push({ type: "feed-fire", campId: hearth.campId });
        return;
      }
    }

    const barrel = this.findNearestBarrel(FUEL_PICKUP_REACH);
    if (barrel) {
      barrel.placement = "carried";
      this.carriedBarrel = barrel;
      this.player.carrying = "fuel";
      this.events.push({ type: "pickup", kind: "fuel" });
      return;
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
    const barrel = this.carriedBarrel;
    if (!barrel) return;
    barrel.placement = "loaded";
    this.carriedBarrel = null;
    this.player.carrying = null;
    this.truck.loaded += 1;
    this.events.push({ type: "fuel-loaded", loaded: this.truck.loaded, required: FUEL_REQUIRED });
    this.events.push({
      type: "message",
      key: this.truck.loaded >= FUEL_REQUIRED ? "msg.fuelFull" : "msg.fuelLoaded",
      params: { loaded: this.truck.loaded, required: FUEL_REQUIRED },
    });
    // 每装一桶给一次改装三选一。装满那一桶不发 —— 那一刻玩家该上车走人，
    // 弹面板会打断通关动作，而且拿到的东西也用不上了。
    if (this.truck.loaded < FUEL_REQUIRED) {
      const options = this.drawRetrofits();
      if (options.length > 0) this.events.push({ type: "retrofit-offer", options });
    }
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
    this.carriedBarrel = null;
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

  requestAttack(): void {
    if (!this.running || this.departTimer > 0 || this.player.attackCooldown > 0 || this.player.carrying) return;
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
    // 磨刃石：冷却 ×0.82，对任何武器都生效。见 types.ts 的 RETROFIT_COOLDOWN_SCALE。
    this.player.attackCooldown = ATTACK_COOLDOWN * this.getConditionCooldownScale()
      * (this.retrofits.has("whetstone") ? RETROFIT_COOLDOWN_SCALE : 1);
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
      && this.hasMeleeLine(this.player, target);

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
      if (critter.health <= 0) this.killCritter(critter);
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
  /**
   * 任意一点附近有没有点着的火。
   *
   * 和 findNearestLitFire 分开写：那个是从**玩家**量的，而火圈要问的是
   * "这只狼站的地方慢不慢"，起点不同。
   */
  nearLitFire(x: number, z: number, radius: number): boolean {
    const limit = radius * radius;
    for (const camp of this.world.camps) {
      if (this.camps[camp.id].fuel <= 0) continue;
      const dx = x - camp.x, dz = z - camp.z;
      if (dx * dx + dz * dz < limit) return true;
    }
    return false;
  }

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
    if (!this.carriedBarrel) {
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
      carrying: this.carriedBarrel !== null,
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
      this.clickRoute.rebuild(target, this.getFlowFieldObstacles());
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
      if (!this.canTraverseTerrain(previous, corner) || !this.canTraverseTerrain(corner, point)) return false;
      if (this.stepCrossesCollision(previous, corner, PLAYER_RADIUS, true)) return false;
      if (this.stepCrossesCollision(corner, point, PLAYER_RADIUS, true)) return false;
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
    this.moveEntity(this.player, movement.x * speed * delta, movement.z * speed * delta, PLAYER_RADIUS, true);
  }

  /** 点是否落在这块盐壳的椭圆边界内。 */
  private pointInSaltCrust(point: Vec2, site: SaltCrustState, padding = 0): boolean {
    const dx = point.x - site.x;
    const dz = point.z - site.z;
    const cosine = Math.cos(-site.rotation);
    const sine = Math.sin(-site.rotation);
    const localX = dx * cosine - dz * sine;
    const localZ = dx * sine + dz * cosine;
    const radiusX = Math.max(0.1, site.radiusX + padding);
    const radiusZ = Math.max(0.1, site.radiusZ + padding);
    return localX * localX / (radiusX * radiusX) + localZ * localZ / (radiusZ * radiusZ) < 1;
  }

  /**
   * 从椭圆内部沿 `toward` 找到边缘外的安全点。
   * 正常进入时直接记上一帧坐标；这个函数只兜测试传送、断口二次闯入等没有上一帧边界的情况。
   */
  private saltCrustRimPoint(site: SaltCrustState, toward: Vec2): Vec2 {
    const dx = toward.x - site.x;
    const dz = toward.z - site.z;
    const cosine = Math.cos(-site.rotation);
    const sine = Math.sin(-site.rotation);
    let localX = dx * cosine - dz * sine;
    let localZ = dx * sine + dz * cosine;
    if (Math.hypot(localX, localZ) < 0.001) localZ = site.radiusZ;
    const scale = 1 / Math.sqrt(
      localX * localX / (site.radiusX * site.radiusX)
      + localZ * localZ / (site.radiusZ * site.radiusZ),
    );
    localX *= scale * 1.12;
    localZ *= scale * 1.12;
    const worldCosine = Math.cos(site.rotation);
    const worldSine = Math.sin(site.rotation);
    return this.findNearestWalkablePoint({
      x: site.x + localX * worldCosine - localZ * worldSine,
      z: site.z + localX * worldSine + localZ * worldCosine,
    });
  }

  private saltCrustStageForPressure(pressure: number): SaltCrustState["stage"] {
    if (pressure >= SALT_CRITICAL_PRESSURE) return "critical";
    if (pressure >= SALT_WARNING_PRESSURE) return "warning";
    return "stable";
  }

  /** 玩家亲手放下的大石会形成安全落脚点；地图天然散石不算，避免无意中白送答案。 */
  private saltCrustHasSupport(site: SaltCrustState): boolean {
    const radiusSquared = SALT_SUPPORT_RADIUS * SALT_SUPPORT_RADIUS;
    return this.items.some((item) => item.active && item.placed && item.kind === "stone"
      && this.pointInSaltCrust(item, site)
      && distanceSquared(this.player, item) <= radiusSquared);
  }

  private ejectFromSaltCrust(site: SaltCrustState, fallback: Vec2, useStoredEntry = true): Vec2 {
    const anchor = useStoredEntry && site.entry && !this.pointInSaltCrust(site.entry, site)
      ? site.entry
      : this.saltCrustRimPoint(site, fallback);
    this.player.x = anchor.x;
    this.player.z = anchor.z;
    // 不调用 dropCarriedItem：油桶、大石和树桩都继续由原引用持有，零损失。
    this.clickTarget = null;
    site.inside = false;
    site.supported = false;
    return anchor;
  }

  /** 玩家先把桶放下也不能钻规则空子：塌陷把壳面上的地面油桶一起送到入口外侧。 */
  private rescueSaltCrustBarrels(site: SaltCrustState, anchor: Vec2): void {
    const barrels = this.barrels.filter((barrel) => barrel.placement === "ground" && this.pointInSaltCrust(barrel, site));
    if (barrels.length === 0) return;
    let outward = normalize({ x: anchor.x - site.x, z: anchor.z - site.z });
    if (outward.x === 0 && outward.z === 0) outward = { x: 0, z: 1 };
    const tangent = { x: -outward.z, z: outward.x };
    barrels.forEach((barrel, index) => {
      const spread = (index - (barrels.length - 1) / 2) * 1.15;
      const target = this.findNearestWalkablePoint({
        x: anchor.x + outward.x * 1.25 + tangent.x * spread,
        z: anchor.z + outward.z * 1.25 + tangent.z * spread,
      });
      barrel.x = target.x;
      barrel.z = target.z;
      barrel.rotation = Math.atan2(tangent.z, tangent.x);
    });
  }

  private collapseSaltCrust(site: SaltCrustState, fallback: Vec2): void {
    const anchor = this.ejectFromSaltCrust(site, fallback);
    this.rescueSaltCrustBarrels(site, anchor);
    site.pressure = 1;
    site.stage = "collapsed";
    site.graceRemaining = 0;
    site.collapsedRemaining = SALT_COLLAPSED_SECONDS;
    this.events.push({ type: "salt-crust", siteId: site.id, stage: "collapse" });
  }

  /**
   * 承重 → 裂纹 → 最后两秒 → 弹回。
   *
   * 这段只改盐壳自己的状态和玩家坐标，绝不碰 health / water / hunger / warmth / stamina。
   * 塌陷恢复 5 秒后可以再试，失败成本因此始终只是绕回入口的时间。
   */
  private updateSaltCrusts(delta: number, previousPlayerPosition: Vec2): void {
    for (const site of this.saltCrusts) {
      const insideNow = this.pointInSaltCrust(this.player, site);

      if (site.stage === "collapsed") {
        site.collapsedRemaining = Math.max(0, site.collapsedRemaining - delta);
        if (insideNow) {
          // 断口恢复前从另一侧误踩进去，只退回“这一次”跨入的边，不横穿整块地面
          // 瞬移回第一次塌陷时保存的旧入口。
          this.ejectFromSaltCrust(site, previousPlayerPosition, false);
          // simulation.clickTarget 已在上面清空；这个无声事件只负责让 main 同步清掉
          // InputController 的外部点击目标，免得接下来 5 秒每帧都把玩家重新拉回断口。
          this.events.push({ type: "salt-crust", siteId: site.id, stage: "eject" });
        }
        if (site.collapsedRemaining <= 0) {
          site.pressure = 0;
          site.stage = "stable";
          site.entry = null;
        }
        continue;
      }

      if (!insideNow) {
        if (site.stage === "grace") {
          // 跨出边界就立刻解除倒计时，但保留裂纹；马上折返仍然危险。
          site.graceRemaining = 0;
          site.pressure = Math.min(site.pressure, 0.94);
        }
        site.inside = false;
        site.supported = false;
        site.pressure = Math.max(0, site.pressure - delta * SALT_PRESSURE_RECOVERY);
        site.stage = this.saltCrustStageForPressure(site.pressure);
        if (site.pressure === 0) site.entry = null;
        continue;
      }

      if (!site.inside) {
        site.entry = this.pointInSaltCrust(previousPlayerPosition, site)
          ? this.saltCrustRimPoint(site, previousPlayerPosition)
          : { ...previousPlayerPosition };
        if (!this.visitedSaltCrusts.has(site.id)) {
          this.visitedSaltCrusts.add(site.id);
          this.events.push({ type: "salt-crust", siteId: site.id, stage: "enter" });
        }
      }
      site.inside = true;

      const wasSupported = site.supported;
      site.supported = this.saltCrustHasSupport(site);
      if (site.supported) {
        if (!wasSupported) this.events.push({ type: "salt-crust", siteId: site.id, stage: "support" });
        site.graceRemaining = 0;
        site.pressure = Math.max(0, Math.min(site.pressure, 0.9) - delta * SALT_SUPPORT_RECOVERY);
        site.stage = this.saltCrustStageForPressure(site.pressure);
        continue;
      }

      if (site.stage === "grace") {
        site.graceRemaining = Math.max(0, site.graceRemaining - delta);
        if (site.graceRemaining <= 0) this.collapseSaltCrust(site, previousPlayerPosition);
        continue;
      }

      const before = site.pressure;
      const load = this.player.carrying ?? "empty";
      site.pressure = Math.min(1, site.pressure + delta * SALT_PRESSURE_RATE[load]);
      if (site.pressure >= 1) {
        site.pressure = 1;
        site.stage = "grace";
        site.graceRemaining = SALT_GRACE_SECONDS;
        this.events.push({ type: "salt-crust", siteId: site.id, stage: "grace" });
      } else if (before < SALT_CRITICAL_PRESSURE && site.pressure >= SALT_CRITICAL_PRESSURE) {
        site.stage = "critical";
        this.events.push({ type: "salt-crust", siteId: site.id, stage: "critical" });
      } else if (before < SALT_WARNING_PRESSURE && site.pressure >= SALT_WARNING_PRESSURE) {
        site.stage = "warning";
        this.events.push({ type: "salt-crust", siteId: site.id, stage: "warning" });
      } else {
        site.stage = this.saltCrustStageForPressure(site.pressure);
      }
    }
  }

  /** HUD 与渲染层共同读取的当前承重；一次只可能站在一块互不重叠的盐壳里。 */
  getActiveSaltCrust(): SaltCrustState | null {
    return this.saltCrusts.find((site) => site.inside && site.stage !== "collapsed") ?? null;
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
    /*
     * 急救包：血首次跌破 30% 时自动回 40，一局一次。
     *
     * 放在被动回复**之前**，因为它要在同一帧就把血抬上去 —— 晚一帧的话玩家
     * 已经看到血条见底了，那一下"差点死但活了"的高光就没了。
     */
    if (!this.medKitUsed && this.retrofits.has("med-kit")
      && this.player.health > 0 && this.player.health < this.player.maxHealth * RETROFIT_MEDKIT_TRIGGER) {
      this.medKitUsed = true;
      this.player.health = Math.min(this.player.health + RETROFIT_MEDKIT_HEAL, this.player.maxHealth);
      this.events.push({ type: "message", key: "retrofit.medkit.fired" });
    }
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

  /** LOD 错峰用的帧计数。 */
  private critterLodFrame = 0;

  private updateCritters(delta: number): void {
    this.critterRespawnCountdown -= delta;
    if (this.critterRespawnCountdown <= 0) {
      this.critterRespawnCountdown = 6;
      this.replenishCritters();
    }
    /*
     * 和狼同一套降频，理由见 WolfDirector 的 LOD_DISTANCE。
     * 猎物比狼更该降：它们不追人、不攻击，远处那几十只纯粹在自己溜达。
     * 半径同样取 50 米，压过渲染层 45 米的剔除线。
     */
    this.critterLodFrame += 1;
    const lodCutoff = CRITTER_LOD_DISTANCE * CRITTER_LOD_DISTANCE;
    for (const critter of this.critters) {
      if (distanceSquared(critter, this.player) > lodCutoff) {
        critter.lodAccum += delta;
        if ((critter.id + this.critterLodFrame) % CRITTER_LOD_STRIDE !== 0) continue;
      }
      this.updateCritter(critter, critter.lodAccum > 0 ? critter.lodAccum + delta : delta);
      critter.lodAccum = 0;
    }
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
        // 头几只教学猎物撒在出生点脚边（见 tutorialPreySpot），其余照旧满图散。
        // 它们**算在自己那一种的 population 里面**，所以 replenishCritters 的账不变：
        // 教学猎物被打死之后由常规补充在远处补回，脚边不会源源不断地刷。
        const point = kind === TUTORIAL_PREY && index < TUTORIAL_PREY_COUNT
          ? this.tutorialPreySpot(index)
          // 开局允许离玩家近一些，否则第一天要跑很远才见得到活物。
          : this.findCritterSpawnPoint(14);
        if (point) this.spawnCritter(kind, point);
      }
    }
  }

  /**
   * 教学猎物的落点：出生点前方 5.5~7.0 米，散在初始朝向的左中右。
   *
   * 一只在正前方（玩家开局面朝卡车，它必定在画面里），左右各一只岔开约 35°，
   * 于是无论玩家先转向哪边都会撞见一只。
   *
   * 这一步要教的不是"这游戏能打猎"，是"按这个键，眼前的东西就没了" ——
   * 拾骨鸦 10 血、初始匕首 30 伤害，和入夜后扑上来那只教学犬（28 血 / 防御 0）
   * 完全相同的结算。玩家在鸟身上学会的那一下，正是 30 秒后救他命的那一下。
   *
   * 改之前最近的可攻击目标在 27 米外，一直挥刀的玩家第一次命中要到第 43 秒 ——
   * 而第一天白天只有 40 秒，考试比课先到。
   *
   * 角度和半径都是写死的常量，不走 this.random()：一是这三只本来就该稳定出现在
   * 同一个地方，二是不额外消费随机流，免得整张地图的布局跟着抖。
   */
  private tutorialPreySpot(index: number): Vec2 {
    const spread = TUTORIAL_PREY_SPREAD[index] ?? 0;
    const radius = TUTORIAL_PREY_RADIUS[index] ?? 6;
    const angle = this.spawnFacing + spread;
    return {
      x: this.spawnAnchor.x + Math.cos(angle) * radius,
      z: this.spawnAnchor.z + Math.sin(angle) * radius,
    };
  }

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
    const facingAngle = this.random() * TAU;
    this.critters.push({
      id: this.critterId++,
      kind,
      ...spawn,
      // 一个角度、一次取样。原先是 `{ cos(random()), sin(random()) }` —— **两次**取样，
      // 出来的根本不是单位向量（实测长度 0.68）。渲染只看 atan2(z, x) 所以一直没露馅，
      // 直到朝向开始参与转向限速的插值：非单位向量会让第一步的转角算错。
      facing: { x: Math.cos(facingAngle), z: Math.sin(facingAngle) },
      lodAccum: 0,
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

    // 转向限速，**而且移动跟着限速后的朝向走**，不是跟着 desired 走。
    //
    // 分开的话（朝向平滑、位移瞬时）动物会侧着身子滑行，比甩头还怪。
    // 合起来之后逃跑变成画弧：长角羚 2.6 rad/s 掉个头要 1.2 秒，
    // 这 1.2 秒就是玩家抄近路截它的窗口 —— 它 10.5 的移速比玩家 8.2 快，
    // 但快不代表甩得掉。
    const steered = this.getSteeredDirection(critter, desired);
    critter.facing = rotateToward(critter.facing, steered, spec.turnRate * delta);
    this.moveEntity(critter, critter.facing.x * pace * delta, critter.facing.z * pace * delta, 0.4, false);
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
   * 近战必须真的处在同一层地面上。
   *
   * 旧判定只有水平距离，玩家站在巢穴土垄上仍能隔着两三米落差砍到下面的守卫，
   * 守卫却找不到能爬上去的路。高度差与遮挡一起判定后，卡在崖边不再等于无伤输出位。
   */
  private hasMeleeLine(start: Vec2, end: Vec2): boolean {
    const heightDelta = Math.abs(terrainHeightAt(this.world, start) - terrainHeightAt(this.world, end));
    return heightDelta <= 1.65 && !this.lineOfSightBlocked(start, end);
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
      if (this.isBlockingGroundItem(item)
        && segmentIntersectsCircle(start, end, item, item.kind === "stone" ? 1.48 : 0.65)) return true;
    }
    return false;
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



  /**
   * 天然石头从生成时就是实体障碍；枯木只有被玩家放下后才组成路障。
   * `placed` 表示“被玩家布置过”，不能再被误用成“有没有碰撞”。
   */
  /**
   * 要让流场绕开的圆形障碍。
   *
   * 只收**天然**石头：它有碰撞却不该被啃（见 findBlockingItem），所以寻路必须自己绕。
   * 玩家布置的路障故意**不**收 —— 那是专门给狗啃的，流场绕开它，布防就白做了。
   *
   * 半径按"狗的圆心能到哪儿"算（石头半径 + 狗半径），这样流场给出的路线
   * 和 resolveCollisions 的判断是同一套，不会出现"寻路说能走、物理说不能"。
   */
  private getFlowFieldObstacles(): { x: number; z: number; radius: number }[] {
    const out: { x: number; z: number; radius: number }[] = [];
    for (const item of this.items) {
      if (!this.isBlockingGroundItem(item) || item.placed) continue;
      out.push({ x: item.x, z: item.z, radius: STONE_COLLIDE_RADIUS + WOLF_RADIUS });
    }
    return out;
  }

  private isBlockingGroundItem(item: GroundItem): boolean {
    return item.active && (item.kind === "stone" || item.placed);
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
      if (!this.isBlockingGroundItem(item) || distanceSquared(entity, item) > 3.2 * 3.2) continue;
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
    const dropPosition = {
      x: this.player.x + this.player.facing.x * 2.05,
      z: this.player.z + this.player.facing.z * 2.05,
    };
    if (kind === "fuel") {
      const barrel = this.carriedBarrel;
      if (!barrel) {
        this.player.carrying = null;
        return;
      }
      barrel.x = dropPosition.x;
      barrel.z = dropPosition.z;
      barrel.rotation = Math.atan2(this.player.facing.z, this.player.facing.x);
      barrel.placement = "ground";
      this.carriedBarrel = null;
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
  private stepAxis(
    entity: Vec2,
    axis: "x" | "z",
    amount: number,
    radius: number,
    collideWithItems: boolean,
    terrainSlopeAllowance = 1,
  ): void {
    const origin = entity[axis];
    for (const scale of MOVE_STEP_FALLBACKS) {
      entity[axis] = origin + amount * scale;
      const from = axis === "x" ? { x: origin, z: entity.z } : { x: entity.x, z: origin };
      if (this.canTraverseTerrain(from, entity, terrainSlopeAllowance)
        && !this.stepCrossesCollision(from, entity, radius, collideWithItems)) return;
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
    this.stepAxis(entity, "x", dx, radius, collideWithItems, terrainSlopeAllowance);
    this.resolveCollisions(entity, radius, collideWithItems);
    this.stepAxis(entity, "z", dz, radius, collideWithItems, terrainSlopeAllowance);
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
        if (!this.isBlockingGroundItem(item)) continue;
        this.pushOutsideCircle(entity, radius, item, item.kind === "stone" ? STONE_COLLIDE_RADIUS : 0.62);
      }
      for (const structure of this.structures) {
        if (!structure.active) continue;
        this.pushOutsideCircle(entity, radius, structure, STRUCTURE_SPECS[structure.kind].radius);
      }
    }
  }

  /**
   * 连续碰撞：检查这一小步的整条线段，而不只检查落点。
   *
   * 原来的 resolveCollisions 只能修正“走完以后还压在圆里”的情况。如果一步从圆的一侧
   * 走到另一侧，或多个路障依次把实体推出，落点可能已经在圆外，于是完全检测不到。
   * 石头和树桩因此看着有碰撞，快速追击或击退时却能偶发穿过。
   */
  private stepCrossesCollision(from: Vec2, to: Vec2, radius: number, collideWithItems: boolean): boolean {
    for (const wall of this.world.walls) {
      if (this.stepEntersCircle(from, to, wall, radius + wall.radius)) return true;
    }
    if (!collideWithItems) return false;
    for (const item of this.items) {
      if (!this.isBlockingGroundItem(item)) continue;
      const obstacleRadius = item.kind === "stone" ? STONE_COLLIDE_RADIUS : 0.62;
      if (this.stepEntersCircle(from, to, item, radius + obstacleRadius)) return true;
    }
    for (const structure of this.structures) {
      if (!structure.active) continue;
      if (this.stepEntersCircle(from, to, structure, radius + STRUCTURE_SPECS[structure.kind].radius)) return true;
    }
    return false;
  }

  private stepEntersCircle(from: Vec2, to: Vec2, obstacle: Vec2, expandedRadius: number): boolean {
    const startDistance = distanceSquared(from, obstacle);
    const endDistance = distanceSquared(to, obstacle);
    const radiusSquared = expandedRadius * expandedRadius;

    // 如果放置物刚好生成在实体脚下，允许实体往外脱离，但不许继续往深处走。
    if (startDistance < radiusSquared - 0.0001) return endDistance < startDistance;

    const moveX = to.x - from.x;
    const moveZ = to.z - from.z;
    const toward = moveX * (obstacle.x - from.x) + moveZ * (obstacle.z - from.z);
    if (toward <= 0) return false;
    return segmentIntersectsCircle(from, to, obstacle, expandedRadius);
  }

  /**
   * 以 desired 为中心向两侧张开，找第一个迈得动的方向；一圈都不行返回 null。
   * 先试小角度，让它尽量还朝着原来想去的地方走，而不是掉头。
   */
  private findSteppableDirection(from: Vec2, desired: Vec2, collideWithItems = true): Vec2 | null {
    const base = Math.atan2(desired.z, desired.x);
    for (const offset of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.4, -2.4, Math.PI]) {
      const angle = base + offset;
      const candidate = { x: Math.cos(angle), z: Math.sin(angle) };
      if (this.canStepToward(from, candidate, WOLF_RADIUS, collideWithItems)) return candidate;
    }
    return null;
  }

  /**
   * 沿 dir 迈一步会不会被拒掉。探针取 0.45 米 —— 比一帧的位移长（狗最快约 0.1 米/帧），
   * 这样它在真正贴上障碍之前就已经改道，而不是先撞上去再纠正。
   *
   * **必须和 stepAxis 用同一组判定**，否则整套解卡机制会建立在错误的答案上：
   * findSteppableDirection 问它"这个方向行不行"，它说行，stepAxis 却拒绝，
   * 于是狗每帧都在"找到一个能走的方向"和"走不动"之间空转，站着不动。
   *
   * 这条不变式被破坏过一次：stepAxis 后来加了 stepCrossesCollision（连续碰撞），
   * 这里没跟着加，于是探针只问地形、stepAxis 却还要过碰撞这一关，两边可能给出
   * 相反的答案。补齐是为了让不变式重新成立 —— **但要说清楚：补齐之后，
   * tests/wolfPathing 里那批"狗僵住 143 秒"的失败一条都没变**，所以那个 bug
   * 另有原因，别把这次改动当成它的修复。
   * 改这两个函数中的任何一个，都要同时改另一个。
   */
  private canStepToward(from: Vec2, dir: Vec2, radius = WOLF_RADIUS, collideWithItems = true): boolean {
    /*
     * **分轴问**，不要问对角线。
     *
     * moveEntity 是分轴推进的（stepAxis 先走 x 再走 z，一轴被挡另一轴仍然生效，
     * 这正是贴墙滑行的来源）。探针若按对角线问，就会在墙角处答错：对角线方向畅通，
     * 可 x 和 z 各自都会撞角，于是探针说"这个方向能走"、stepAxis 三档 fallback
     * 全被拒，狗一步不动。实测岩壁洞窟外一只巡逻犬就这么定住 10 秒。
     *
     * 只要有一个轴迈得动，moveEntity 就会产生位移 —— 判据必须和它一致。
     */
    const REACH = 0.45;
    const axisClear = (target: Vec2): boolean => this.canTraverseTerrain(from, target)
      && !this.stepCrossesCollision(from, target, radius, collideWithItems);
    if (Math.abs(dir.x) > 1e-6 && axisClear({ x: from.x + dir.x * REACH, z: from.z })) return true;
    if (Math.abs(dir.z) > 1e-6 && axisClear({ x: from.x, z: from.z + dir.z * REACH })) return true;
    return false;
  }

  private canTraverseTerrain(from: Vec2, to: Vec2, terrainSlopeAllowance = 1): boolean {
    const limit = this.world.terrain.maxWalkableSlope * terrainSlopeAllowance;
    const toSlope = terrainSlopeAt(this.world, to);
    // 落点坡度是一条**站得住吗**的判据，这里却被拿来当**迈得过去吗**用。
    // 实体已经站在坡度 0.776 的地面上（贴着营地的墙走，被完全不看地形的
    // pushOutsideCircle 推上去的 —— 实测好几只狗被同一堵墙推到同一个坐标后一起定住），
    // 此时它横向挪一步、爬升比只有 0.036，几乎是平着走，却因为落点坡度 0.784
    // 微微过线而被拒；而另一个轴的落点坡度合格、爬升比却有 1.003，同样被拒。
    // 两条判据一边卡一个方向，实体就被钉死在原地，站着看玩家，一整夜不动。
    //
    // 所以：脚下本来就在线上时，只要新落点不比脚下**明显**更陡就放行，让它挪得回去。
    // 爬崖不受影响 —— 那件事从头到尾由下面的 rise/travel 把关，这里一个字没动。
    if (toSlope > limit && toSlope > terrainSlopeAt(this.world, from) + 0.05) return false;
    const travel = Math.hypot(to.x - from.x, to.z - from.z);
    if (travel < 0.0001) return true;
    const rise = Math.abs(terrainHeightAt(this.world, to) - terrainHeightAt(this.world, from));
    return rise / travel <= limit * 1.12;
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
