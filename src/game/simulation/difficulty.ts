/**
 * 难度。
 *
 * ## 难度改变决策，不只增加敌人
 *
 * 旋钮分成两组：
 *
 *   狼群压力 —— 攻营配额、刷新节奏、波次铺开的时段、精英狼登场日
 *   生存压力 —— 生命/体温/饱食/水分/劳力这五条轴
 *
 * 简单档仍然是原始平衡，五轴和狼群全部保持 1.0。普通/困难才会轻度收紧五轴，
 * 而且是**非对称**的：水和饱食略快、体温更容易被昼夜拉走、劳力回复变慢，
 * 生命的恒定流失只做最小幅度调整。这样玩家需要换一套出行/休息节奏，
 * 而不是面对同一套打法下更多、更厚的狼。
 *
 * 这里仍然不改昼夜时长、开局口粮和资源产量。第一昼夜 175 秒无补给时，
 * 普通剩约 12 水 / 6 饱食，困难剩约 8 水 / 2 饱食；开局自带的 2 水 + 1 熟肉
 * 仍足够安全过夜，但从普通开始，玩家不能再把补给当成可有可无。
 *
 * ## 简单是默认
 *
 * 现有平衡就是简单档（全部倍率 1.0）。普通/困难是通关后的主动选择 ——
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
  /** 攻营波次铺在整夜的比例；越大，后续波次来得越晚。 */
  raidReleaseWindow: number;
  /** 精英狼最早出现在第几夜。 */
  eliteMinDay: number;
  /** 狼的生命倍率。教学犬不吃这个 —— 它是写死的剧本。 */
  wolfHealth: number;
  /** 狼的咬伤倍率。同样不含教学犬。 */
  wolfAttack: number;
  /** 生命恒定流失倍率。 */
  healthDecay: number;
  /** 水分衰减倍率。 */
  waterDecay: number;
  /** 饱食衰减倍率。 */
  hungerDecay: number;
  /** 昼夜环境对体温的推拉倍率；篝火和玩家主动调温不受影响。 */
  thermalPressure: number;
  /** 劳力回复倍率；小于 1 表示更需要主动安排休息。 */
  staminaRegen: number;
}

export const DIFFICULTY_TUNING: Record<Difficulty, DifficultyTuning> = {
  /** 原始平衡，一个数都没动 —— 新手与老存档的手感保持一致。 */
  easy: {
    raid: 1.0, spawnInterval: 1.0, raidReleaseWindow: 0.60,
    eliteMinDay: 3, wolfHealth: 1.0, wolfAttack: 1.0,
    healthDecay: 1.0, waterDecay: 1.0, hungerDecay: 1.0,
    thermalPressure: 1.0, staminaRegen: 1.0,
  },
  /** 攻营 [5,9,14] → [6,11,17]；数量只小幅增加，主要考验五轴调度。 */
  normal: {
    raid: 1.2, spawnInterval: 0.95, raidReleaseWindow: 0.68,
    eliteMinDay: 2, wolfHealth: 1.05, wolfAttack: 1.08,
    healthDecay: 1.06, waterDecay: 1.06, hungerDecay: 1.04,
    thermalPressure: 1.08, staminaRegen: 0.92,
  },
  /** 攻营 [5,9,14] → [7,13,20]；第一夜有精英狼，五轴进入真正的困难节奏。 */
  insane: {
    raid: 1.4, spawnInterval: 0.90, raidReleaseWindow: 0.78,
    eliteMinDay: 1, wolfHealth: 1.10, wolfAttack: 1.16,
    healthDecay: 1.12, waterDecay: 1.12, hungerDecay: 1.09,
    thermalPressure: 1.16, staminaRegen: 0.84,
  },
};

export function tuningFor(difficulty: Difficulty): DifficultyTuning {
  return DIFFICULTY_TUNING[difficulty] ?? DIFFICULTY_TUNING[DEFAULT_DIFFICULTY];
}

/** 收窄任意输入到合法档位；存储和 URL 参数都要过这一关。 */
export function normalizeDifficulty(value: unknown): Difficulty {
  return DIFFICULTIES.includes(value as Difficulty) ? value as Difficulty : DEFAULT_DIFFICULTY;
}
