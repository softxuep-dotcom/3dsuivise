/** 玩家主动重开第一次零摩擦；第二次起再让平台 SDK 决定是否展示插屏。 */
export const shouldBreakBeforeRestart = (restartNumber: number): boolean => restartNumber > 1;
