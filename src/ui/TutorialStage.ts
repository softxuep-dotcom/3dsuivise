/**
 * 两段教学共用的舞台：字幕、进度点、跳过键，以及 UI 键的提亮。
 *
 * 拆出来的原因很具体：第一夜教学要的东西和开场教学**一模一样**。
 * 不拆的话这些 DOM 操作会被抄第二遍，而抄完之后每一条踩过的坑都变成两处要维护。
 *
 * 舞台只管**怎么显示**，一步都不知道自己在教什么 —— 步骤、完成判定、
 * 时钟闸全部留在各自的教学类里。
 *
 * ## 场景里的高亮不在这里
 *
 * 「照亮场景中的那个目标」曾经是这个类的活：一张 SVG 幕布盖住全屏，
 * 在目标位置挖一个软边亮洞。**那套已经整个删掉了**，换成渲染层的一盏聚光灯
 * （GameRenderer.spotlightOn）。两个理由：
 *
 *   1. 平台的会话录像抓画布，不抓 DOM 覆盖层 —— 幕布在回放里根本不存在，
 *      看录像的人和玩游戏的人看到的不是同一个画面；
 *   2. 一整屏 78% 的黑第一眼像加载失败，而这一屏正是新玩家的第一眼。
 *
 * 留在这里的只有 **UI 元素的提亮**，因为那本来就是 DOM 的事：
 * `#hud.tutorial-dim` 把其余面板和按键压下去，被点名的几个不压、并加一圈光。
 * 这一路不能改成挖洞 —— 右下四颗键排在半径 140px 的弧上、彼此只隔 77~89px，
 * 照亮背包的洞半径 97px 会把攻击、行动、体温一起照进去，最需要精确指认的
 * 那一步反而指不准。详见 styles.css 里 .tutorial-lit 那段。
 */

const required = <T extends Element>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as unknown as T;
};

export class TutorialStage {
  private readonly root = required<HTMLElement>("tutorial");
  private readonly hud = required<HTMLElement>("hud");
  private readonly caption = required<HTMLElement>("tutorial-caption");
  private readonly line = required<HTMLElement>("tutorial-line");
  private readonly sub = required<HTMLElement>("tutorial-sub");
  private readonly dots = required<HTMLElement>("tutorial-dots");
  private readonly skipButton = required<HTMLButtonElement>("tutorial-skip");

  /** 当前亮着的 UI 元素 id。换步和收尾时按它回收 class。 */
  private readonly litIds = new Set<string>();
  private skipHandler: (() => void) | null = null;

  constructor() {
    this.skipButton.addEventListener("click", () => this.skipHandler?.());
  }

  /** 谁在用这个舞台，就由谁接跳过。两段教学的收尾动作不一样。 */
  onSkip(handler: () => void): void {
    this.skipHandler = handler;
  }

  show(skipLabel: string): void {
    this.skipButton.textContent = skipLabel;
    this.skipButton.classList.remove("hidden");
    this.root.classList.remove("hidden");
    this.hud.classList.add("tutorial-dim");
  }

  hide(): void {
    // 高亮是加在 HUD 自己的元素上的，不随幕布一起消失 —— 必须逐个收回来，
    // 否则教学结束后那颗键会一直发着光。
    this.setLit([]);
    this.root.classList.add("hidden");
    this.root.classList.remove("over-pack");
    this.caption.classList.remove("over-pack");
    this.hud.classList.remove("tutorial-dim");
  }

  setCaption(line: string, sub: string): void {
    this.line.textContent = line;
    this.sub.textContent = sub;
  }

  /** 卡了太久就把提示加重。**不换文案** —— 玩家这时缺的是更显眼，不是更多字。 */
  setUrgent(urgent: boolean): void {
    this.caption.classList.toggle("urgent", urgent);
  }

  setSkipVisible(visible: boolean): void {
    this.skipButton.classList.toggle("hidden", !visible);
  }

  /** 收掉界面压暗，只留字幕。背包那一步要这个状态。 */
  setDimVisible(visible: boolean): void {
    this.hud.classList.toggle("tutorial-dim", visible);
  }

  /**
   * 把字幕抬到背包遮罩之上。
   * 抬的是整个字幕层，不是那行字本身 —— .tutorial 是 fixed，
   * 子元素的 z-index 爬不出它自己的层叠上下文（见 styles.css 里那段注释）。
   */
  setOverPack(over: boolean): void {
    this.root.classList.toggle("over-pack", over);
    this.caption.classList.toggle("over-pack", over);
  }

  buildDots(total: number): void {
    this.dots.replaceChildren(...Array.from({ length: total }, () => document.createElement("i")));
  }

  setDots(index: number): void {
    Array.from(this.dots.children).forEach((dot, position) => {
      dot.classList.toggle("done", position < index);
      dot.classList.toggle("on", position === index);
    });
  }

  /**
   * 点亮这一步要看的那几个 UI 元素。
   *
   * 只做一件事：给它们挂上 .tutorial-lit。压暗、发光全在 CSS 里 ——
   * `#hud.tutorial-dim` 把面板和其余按键压下去，被点名的这几个不压、并加一圈光。
   *
   * **没有任何 z-index 操作。** 早先试过把按键抬到幕布之上，抬不动：
   * #hud 是 position: fixed，本身就创建层叠上下文，子元素爬不出去。
   * 现在幕布整层排在 #hud 之前、z 比它低，压根不需要抬。
   */
  setLit(ids: string[]): void {
    const wanted = new Set(ids);
    for (const id of this.litIds) {
      if (!wanted.has(id)) document.getElementById(id)?.classList.remove("tutorial-lit");
    }
    this.litIds.clear();
    for (const id of wanted) {
      const element = document.getElementById(id);
      if (!element) continue;
      element.classList.add("tutorial-lit");
      this.litIds.add(id);
    }
  }
}
