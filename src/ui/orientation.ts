/**
 * 横屏偏好。
 *
 * 本作按横屏布局设计，但**不弹提示、也不阻断游戏** ——
 * 竖屏照样能玩，只是 HUD 会挤一些。这里只做一次静默的方向锁定尝试：
 * 锁上了就自动转成横屏，锁不上就当无事发生。
 */
export async function requestLandscapeLock(): Promise<void> {
  const orientation = screen.orientation as (ScreenOrientation & {
    lock?: (value: OrientationLockType) => Promise<void>;
  }) | undefined;
  if (!orientation?.lock) return;
  try {
    await orientation.lock("landscape");
  } catch {
    // 未全屏 / 桌面端 / 用户已自行锁定方向 —— 都不影响游戏，静默忽略。
  }
}
