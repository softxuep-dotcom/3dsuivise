import type { ArmorKind, WeaponKind } from "../game/simulation/types";

export interface ReviveCandidate {
  day: number;
  truck: { loaded: number };
  player: { weapon: WeaponKind; armor: ArmorKind };
}

/** 只有玩家已经积累了值得保存的进度时，才用激励视频打断死亡页。 */
export const isRunWorthReviving = (run: ReviveCandidate): boolean => run.day >= 2
  || run.truck.loaded > 0
  || run.player.weapon !== "survival-knife"
  || run.player.armor !== "none";

/** 第一次死亡后的立即重开零摩擦；第二次起再让平台 SDK 决定是否展示插屏。 */
export const shouldBreakBeforeRestart = (restartNumber: number): boolean => restartNumber > 1;
