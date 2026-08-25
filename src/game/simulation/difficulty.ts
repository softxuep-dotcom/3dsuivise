/**
 * 难度。
 *
 * ## 只缩放"压力轴"，绝不碰"代谢轴"
 *
 * 能调的旋钮其实分两类：
 *
 *   压力轴 —— 晚上来几只狗、多凶、精英狼哪天登场
 *   代谢轴 —— 水分/饱食/体力的衰减速度、昼夜时长
 *
 * **这里只动压力轴。** 代谢轴那几个常量是和新手第一夜的算术咬死的：
 * 开局口粮 2 水 + 1 熟肉、饱食预警线 18 在约 124 秒、第二天黎明在 190 秒
 * （见 STARTING_RATION 那段）。难度一旦改衰减速度，那条时间线在每个档位下都不一样，
 * 就得为每个档位重算一份口粮、重验一次"能不能活过第一夜"。
 *
 * 锁住代谢轴的好处是：新手那条时间线**验一次、三档通用**，难度只决定
 * "晚上来多少颗牙"。这也是为什么简单和普通之间玩家不会感到"我怎么突然更容易渴死"——
 * 生存压力恒定，变的只有狗。
 *
 * ## 简单是默认
 *
 * 现有平衡就是简单档（三个倍率全 1.0）。普通/令人发狂是主动选择 ——
 * 反过来做的话，新手留存那一整轮改动会当场作废。
 *
 * ## 重启才生效
 *
 * 倍率在 GameSimulation 构造时读一次存成实例状态，中途不重读。
 * 狼的数值是生成时算的，跑到一半换档只会让新旧狼混在同一夜里，谁也说不清。
 */

export type Difficulty = "easy" | "normal" | "insane";

/** 菜单顺序，也是从易到难的顺序。 */
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "normal", "insane"];

export const DEFAULT_DIFFICULTY: Difficulty = "easy";

export interface DifficultyTuning {
  /** 前三夜攻营配额（EARLY_NIGHT_RAID_TARGETS）的倍率。真正扑向营地的那部分。 */
  raid: number;
  /** 刷新间隔倍率，**越小刷得越快**。 */
  spawnInterval: number;
  /** 精英狼最早出现在第几夜。 */
  eliteMinDay: number;
  /** 狼的生命倍率。教学犬不吃这个 —— 它是写死的剧本。 */
  wolfHealth: number;
  /** 狼的咬伤倍率。同样不含教学犬。 */
  wolfAttack: number;
}

export const DIFFICULTY_TUNING: Record<Difficulty, DifficultyTuning> = {
  /** 现有平衡，一个数都没动 —— 改这里等于改所有老玩家的手感。 */
  easy: { raid: 1.0, spawnInterval: 1.0, eliteMinDay: 3, wolfHealth: 1.0, wolfAttack: 1.0 },
  /** 攻营 [5,9,14] → [7,13,20]，精英狼提前一夜。 */
  normal: { raid: 1.4, spawnInterval: 0.85, eliteMinDay: 2, wolfHealth: 1.15, wolfAttack: 1.15 },
  /** 攻营 [5,9,14] → [10,17,27]，**第一夜就有精英狼**。名副其实。 */
  insane: { raid: 1.9, spawnInterval: 0.7, eliteMinDay: 1, wolfHealth: 1.35, wolfAttack: 1.35 },
};

export function tuningFor(difficulty: Difficulty): DifficultyTuning {
  return DIFFICULTY_TUNING[difficulty] ?? DIFFICULTY_TUNING[DEFAULT_DIFFICULTY];
}

/** 收窄任意输入到合法档位；存储和 URL 参数都要过这一关。 */
export function normalizeDifficulty(value: unknown): Difficulty {
  return DIFFICULTIES.includes(value as Difficulty) ? value as Difficulty : DEFAULT_DIFFICULTY;
}
