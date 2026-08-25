/**
 * 武器与护甲双线的**数值**：四条线各三阶的属性、造价，以及攻击节奏。
 *
 * 从 GameSimulation.ts 分出来，理由同 balance/survival.ts：调平衡不该打开逻辑文件。
 * 这一份对应 `docs/装备双线设计.md`。
 *
 * 搬运时一个数字都没有改，注释原样跟过来。
 */
import type { ArmorKind, EquipLine, InventoryItemKind, WeaponKind } from "../simulation/types";

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
export const WEAPON_TIERS: EquipTier[] = [
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
export const ARMOR_TIERS: EquipTier[] = [
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
export const ATTACK_COOLDOWN = 0.55;

export interface WeaponStat {
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
export const WEAPON_STATS: Record<WeaponKind, WeaponStat> = {
  "survival-knife": { range: 3.1, arcDot: 0.174, stamina: 4, pierce: 0, critChance: 0, critMult: 1, moveScale: 1.00, knockback: 0, knockbackStun: 0, comboStep: 0, comboMax: 0, healthOnHit: 0 },

  "saber-1": { range: 3.4, arcDot: -0.342, stamina: 5, pierce: 2, critChance: 0, critMult: 1, moveScale: 0.98, knockback: 0.35, knockbackStun: 0.20, comboStep: 0, comboMax: 0, healthOnHit: 3 },
  "saber-2": { range: 3.6, arcDot: -0.574, stamina: 6, pierce: 5, critChance: 0.12, critMult: 1.8, moveScale: 0.95, knockback: 0.50, knockbackStun: 0.30, comboStep: 0, comboMax: 0, healthOnHit: 5 },
  "saber-3": { range: 3.8, arcDot: -0.766, stamina: 7, pierce: 8, critChance: 0.15, critMult: 2.0, moveScale: 0.92, knockback: 0.70, knockbackStun: 0.40, comboStep: 0, comboMax: 0, healthOnHit: 10 },

  "sword-1": { range: 3.2, arcDot: 0.643, stamina: 5, pierce: 0, critChance: 0.20, critMult: 1.8, moveScale: 1.00, knockback: 0, knockbackStun: 0, comboStep: 0.10, comboMax: 3, healthOnHit: 3 },
  "sword-2": { range: 3.3, arcDot: 0.643, stamina: 6, pierce: 0, critChance: 0.30, critMult: 2.0, moveScale: 1.03, knockback: 0, knockbackStun: 0, comboStep: 0.12, comboMax: 4, healthOnHit: 5 },
  "sword-3": { range: 3.4, arcDot: 0.574, stamina: 7, pierce: 0, critChance: 0.40, critMult: 2.2, moveScale: 1.06, knockback: 0, knockbackStun: 0, comboStep: 0.15, comboMax: 4, healthOnHit: 10 },
};

export interface ArmorStat {
  /** 命中判定前掷骰，闪掉整次咬击。只有皮甲线有。 */
  dodge: number;
  /** 把狼**未经防御削减**的原始攻击力的这个比例弹回去。只有铁甲线有。 */
  thorns: number;
  moveScale: number;
  /** 乘在三档劳力回复上。皮甲提供加成，铁甲保持基础回复速度。 */
  staminaScale: number;
}

export const ARMOR_STATS: Record<ArmorKind, ArmorStat> = {
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
export const COMBO_WINDOW = 1.2;

/*
 * 精英狼登场的夜数**跟着难度走**（简单 3 / 普通 2 / 令人发狂 1），
 * 见 difficulty.ts 的 eliteMinDay。之后逐日提高出现率，但永远只是少数。
 */

/**
 * 随身枯木每根 +2 攻击，最多两根生效。
 * 沿用「一块木头也能当武器使」的设计 —— 背包里的材料同时是个边际武器，
 * 占那一格才有回报，否则玩家只会觉得被收了格子税。
 */
export const WOOD_ATTACK_BONUS = 2;

export const WOOD_ATTACK_CAP = 2;   // 20 → 15：两级武器共需 8 块铁 = 原先两整管劳力的站桩
