/**
 * 横屏闸门。
 *
 * 本作的 HUD 是四角布局（左上目标、右上五条状态轴、左下摇杆、右下双按钮），
 * 竖屏下这四块会互相挤压到不可用，所以竖屏直接暂停并盖一层提示，
 * 转回横屏立刻恢复 —— 不销毁任何状态。
 */
export class OrientationGate {
  private readonly gate: HTMLElement;
  private readonly query = matchMedia("(orientation: portrait)");
  private blocked = false;

  constructor() {
    const gate = document.getElementById("rotate-gate");
    if (!gate) throw new Error("Missing UI element: rotate-gate");
    this.gate = gate;
    // orientationchange 在部分安卓上先于尺寸更新触发，所以 resize 也要监听。
    this.query.addEventListener("change", this.sync);
    window.addEventListener("resize", this.sync);
    window.addEventListener("orientationchange", this.sync);
    this.sync();
  }

  /**
   * 主循环据此跳过 simulation.update —— 竖屏期间世界完全静止。
   *
   * 这里顺手做一次同步，不只依赖 resize/orientationchange 事件：
   * 嵌在 iframe 里（Poki 等平台）被外层改尺寸时不保证有事件，
   * 而这个检查只是两次属性读取 + 状态相同就早退，每帧跑没有代价。
   */
  isBlocked(): boolean {
    this.sync();
    return this.blocked;
  }

  /**
   * 尝试把方向锁到横屏。
   * 绝大多数浏览器只在全屏下允许锁定，失败是常态，静默吞掉即可 ——
   * 遮罩本身已经是可靠的兜底。
   */
  async requestLandscapeLock(): Promise<void> {
    const orientation = screen.orientation as (ScreenOrientation & {
      lock?: (value: OrientationLockType) => Promise<void>;
    }) | undefined;
    if (!orientation?.lock) return;
    try {
      await orientation.lock("landscape");
    } catch {
      // 未全屏 / 桌面端 / 用户已锁定方向 —— 都走遮罩兜底。
    }
  }

  private readonly sync = (): void => {
    // 用实际尺寸而不是只信 media query：桌面把窗口拉窄同样会让布局崩掉。
    const portrait = this.query.matches || window.innerHeight > window.innerWidth;
    if (portrait === this.blocked) return;
    this.blocked = portrait;
    this.gate.classList.toggle("hidden", !portrait);
  };
}
