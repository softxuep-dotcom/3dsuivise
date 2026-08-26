/**
 * 搬油三选一：卡表与数值。
 *
 * 规格见 docs/搬油三选一-开发交接.md。这个文件**只有数据**，抽卡规则和运行时
 * 效果在 simulation/FuelPerkSystem.ts —— 分开是因为这九张卡的平衡是互相定义的
 * （一条线堆满要形成一种人格），改任何一格都得对着另外八张读。
 *
 * ## 触发点是「装进卡车」，不是「拿起油桶」
 *
 * 拿起和放下同一桶可以反复做，装车不行。奖励是**完成一次危险运输之后的结算**，
 * 这条决定了整个系统接在 TruckSystem.loadCarried() 而不是拾取那一侧。
 *
 * ## 一局只有 5 次
 *
 * 装到 1/6~5/6 各一次；第 6 桶不弹 —— 那时游戏就要结束了，给了也来不及用，
 * 反而把「装满 → 上车 → 发车」那一串收尾动作拆开。
 * 5 次是整个系统的**总预算**：任何一张卡的层数上限乘以它的每层收益，
 * 都要放在「最多只能拿 5 层」这个前提下看。
 */

export type FuelPerkLine = "carry" | "combat" | "survival";

export type FuelPerkId =
  | "carry-rig" | "barrel-brace" | "empty-run"
  | "armor-plate" | "den-breaker" | "blood-rush"
  | "steady-breath" | "rationing" | "truck-supplies";

export interface FuelPerkDef {
  readonly id: FuelPerkId;
  readonly line: FuelPerkLine;
  /** 层数上限。到顶之后这张卡退出候选池。 */
  readonly maxStacks: number;
}

/**
 * 九张卡。搬运、战斗、生存各三张。
 *
 * 三条线各自的设计目的：
 *   搬运  一张缩短返程、一张提高危险路线容错、一张缩短去程
 *   战斗  允许投资战斗打开巢边三桶油的近路，但不把所有狼变成免费资源
 *   生存  减少「找补给」和「原地恢复」占掉的时间
 */
export const FUEL_PERKS: readonly FuelPerkDef[] = [
  // ── 搬运 ──
  { id: "carry-rig", line: "carry", maxStacks: 3 },
  { id: "barrel-brace", line: "carry", maxStacks: 2 },
  { id: "empty-run", line: "carry", maxStacks: 2 },
  // ── 战斗 ──
  { id: "armor-plate", line: "combat", maxStacks: 3 },
  { id: "den-breaker", line: "combat", maxStacks: 2 },
  { id: "blood-rush", line: "combat", maxStacks: 2 },
  // ── 生存 ──
  { id: "steady-breath", line: "survival", maxStacks: 3 },
  { id: "rationing", line: "survival", maxStacks: 3 },
  { id: "truck-supplies", line: "survival", maxStacks: 2 },
];

export const FUEL_PERK_BY_ID: Readonly<Record<FuelPerkId, FuelPerkDef>> =
  Object.fromEntries(FUEL_PERKS.map((perk) => [perk.id, perk])) as Record<FuelPerkId, FuelPerkDef>;

/** 每次给几张。 */
export const OFFER_SIZE = 3;

/**
 * 扛东西时的移速倍率基准。和 GameSimulation.updatePlayerMovement 里那个 0.54
 * 是同一个数 —— 提到这里是因为 carry-rig 要在它身上做文章，两处各写一份
 * 迟早会分家。
 */
export const CARRY_BASE_SCALE = 0.54;

/**
 * 军用肩带：**减少的是惩罚，不是加移速**。
 *
 * 当前惩罚是 1 − 0.54 = 0.46，每层把**剩余惩罚**乘 0.8：
 *
 *     carryScale = 1 − (1 − 0.54) × 0.8^层数
 *
 *     层数   搬运倍率   相对未升级
 *       0     0.540       100%
 *       1     0.632       117%
 *       2     0.706       131%
 *       3     0.764       142%
 *
 * 用递减而不是线性，是为了堆满三层之后扛油**仍然明显慢于空手**（0.764 < 1）。
 * 线性加成堆到三层会越过 1，那时「扛着桶跑得比空手快」，整个搬运玩法就没了。
 */
export const CARRY_RIG_PENALTY_MULT = 0.8;

/** 护桶姿势：扛油时受到的伤害乘 0.8^层数（最多两层 = 0.64）。 */
export const BARREL_BRACE_DAMAGE_MULT = 0.8;

/**
 * 熟门熟路：装车之后一段时间内空手移速 +20%。
 *
 * 只加**空手**那一段 —— 它买的是去程（跑去找下一桶），不是返程。
 * 返程归 carry-rig 管，两张卡各管一头，堆在一起才是完整的一趟。
 * 持续时间逐层延长而不是加倍率：+20% 已经很显眼，再叠会盖过 carry-rig。
 */
export const EMPTY_RUN_SPEED_BONUS = 0.2;
export const EMPTY_RUN_SECONDS: readonly number[] = [12, 18];

/** 加固内衬：最终防御 +2/层，最多三层。 */
export const ARMOR_PLATE_DEFENSE = 2;

/** 清巢老手：对**仍守着油桶**的守巢狼伤害 +25%/层。 */
export const DEN_BREAKER_DAMAGE_BONUS = 0.25;

/**
 * 见血回神：击杀狼恢复体力。
 *
 * 首层 +8、第二层 +13（不是 +8 再 +8）—— 第二层的边际收益略低于第一层，
 * 和别的线保持同一种"第一层最值钱"的形状。
 * 4 秒冷却挡的是夜袭里一次群杀连锁回满血。
 */
export const BLOOD_RUSH_HEALTH: readonly number[] = [8, 13];
export const BLOOD_RUSH_COOLDOWN = 4;

/**
 * 调匀呼吸：劳力恢复 +2/s/层，**平坦加值**。
 *
 * 要加在护甲的 staminaScale **之后**，否则皮甲玩家的一层会变成 +2.7、
 * 铁甲玩家的一层还是 +2 —— 卡面写着"+2/秒"就必须永远正好是 +2/秒。
 */
export const STEADY_BREATH_REGEN = 2;

/** 省着点吃：水分与饥饿消耗各乘 0.88^层数（三层 = 0.681）。 */
export const RATIONING_DECAY_MULT = 0.88;

/**
 * 后座补给：每次装车恢复体力/水分/饥饿。
 *
 * 选中的**当下要对刚装好的这一桶立即结算一次**，否则第一层会表现成
 * "我选了但什么都没发生" —— 而奖励的全部意义就是当场可感知。
 */
export const TRUCK_SUPPLIES_HEALTH = 15;
export const TRUCK_SUPPLIES_WATER = 12;
export const TRUCK_SUPPLIES_HUNGER = 12;
