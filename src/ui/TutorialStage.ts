/**
 * 两段教学共用的舞台。
 *
 * 拆出来的原因很具体：第一夜教学要的东西和开场教学**一模一样** —— 压暗、
 * 在场景里挖亮洞、点亮某几颗 UI 键、一行主文案一行副文案、右上角一颗跳过。
 * 不拆的话这三十来行 DOM 操作会被抄第二遍，而抄完之后每一条"踩过的坑"
 * （挖洞为什么用 SVG 遮罩、点亮为什么不能靠 z-index）都变成两处要维护。
 *
 * 舞台只管**怎么显示**，一步都不知道自己在教什么 —— 步骤、完成判定、
 * 时钟闸全部留在各自的教学类里。
 *
 * ## 两类高亮走两套机制
 *
 *   场景里的（角色、猎物、枯木、营火）  画在 canvas 里，抬不出来 → 幕布上挖洞
 *   UI（那几颗键、摇杆、体温条）        是 DOM，可以点名 → 单独提亮，不挖洞
 *
 * UI 那一路一开始也是挖洞的，实测是错的：洞得比按钮大，而右下四颗键排在半径
 * 140px 的弧上、彼此只隔 77~89px —— 照亮背包的洞半径 97px，会把攻击、行动、
 * 体温一起照进去。最需要精确指认的那一步反而指不准。详见 styles.css 里
 * .tutorial-lit 那段。
 *
 * 场景那一路走 SVG 遮罩而不是 CSS 渐变 —— 一条渐变只挖得动一个洞，
 * 而"角色"和"猎物"这类目标可能不止一个。见 index.html。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** 屏幕坐标上的一个亮洞。 */
export interface Hole {
  x: number;
  y: number;
  radius: number;
}

const required = <T extends Element>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as unknown as T;
};

export class TutorialStage {
  private readonly root = required<HTMLElement>("tutorial");
  /** 幕布单独一层，排在 #hud **之前**（见 index.html 那段注释）。 */
  private readonly veilLayer = required<HTMLElement>("tutorial-veil-layer");
  private readonly hud = required<HTMLElement>("hud");
  private readonly veil = required<SVGElement>("tutorial-veil");
  private readonly holeGroup = required<SVGGElement>("tutorial-holes");
  private readonly caption = required<HTMLElement>("tutorial-caption");
  private readonly line = required<HTMLElement>("tutorial-line");
  private readonly sub = required<HTMLElement>("tutorial-sub");
  private readonly dots = required<HTMLElement>("tutorial-dots");
  private readonly skipButton = required<HTMLButtonElement>("tutorial-skip");

  /** 复用的 <circle>，不每帧重建 —— 增删节点会让软边缘闪。 */
  private readonly circles: SVGCircleElement[] = [];
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
    this.veilLayer.classList.remove("hidden");
    this.hud.classList.add("tutorial-dim");
  }

  hide(): void {
    // 高亮是加在 HUD 自己的元素上的，不随幕布一起消失 —— 必须逐个收回来，
    // 否则教学结束后那颗键会一直发着光。
    this.setLit([]);
    this.setHoles([]);
    this.root.classList.add("hidden");
    this.root.classList.remove("over-pack");
    this.caption.classList.remove("over-pack");
    this.veilLayer.classList.add("hidden");
    this.hud.classList.remove("tutorial-dim");
  }

  setCaption(line: string, sub: string): void {
    this.line.textContent = line;
    this.sub.textContent = sub;
    this.veil.style.opacity = "";
  }

  /** 卡了太久就把提示加重。**不换文案** —— 玩家这时缺的是更显眼，不是更多字。 */
  setUrgent(urgent: boolean): void {
    this.caption.classList.toggle("urgent", urgent);
  }

  setSkipVisible(visible: boolean): void {
    this.skipButton.classList.toggle("hidden", !visible);
  }

  /** 收掉幕布与压暗，只留字幕。背包那一步和第一夜的收尾都要这个状态。 */
  setVeilVisible(visible: boolean): void {
    this.veilLayer.classList.toggle("hidden", !visible);
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
   * 把这一帧的亮洞写进 SVG 遮罩。
   *
   * `<circle>` 复用而不是每帧重建：重建会让浏览器重新解析渐变引用，软边缘因此闪一下。
   * 多出来的圆半径归零藏起来，不从 DOM 里摘掉。
   */
  setHoles(targets: Hole[]): void {
    while (this.circles.length < targets.length) {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("fill", "url(#tutorial-hole-fade)");
      this.holeGroup.appendChild(circle);
      this.circles.push(circle);
    }
    this.circles.forEach((circle, index) => {
      const hole = targets[index];
      if (!hole) {
        circle.setAttribute("r", "0");
        return;
      }
      circle.setAttribute("cx", String(Math.round(hole.x)));
      circle.setAttribute("cy", String(Math.round(hole.y)));
      circle.setAttribute("r", String(Math.round(hole.radius)));
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
