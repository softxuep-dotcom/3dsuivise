import type { GameSimulation } from "../game/simulation/GameSimulation";
import { TUTORIAL_PREY } from "../game/simulation/GameSimulation";
import type { GameEvent } from "../game/simulation/types";
import { t } from "../i18n";

/**
 * 开场教学：四个动词，二十秒。
 *
 * ## 教这四个，是因为它们就是全部
 *
 * `hud.pcControls` 里列的即这游戏的完整操作表：WASD 移动 / 空格攻击 / E 互动 / B 背包。
 * 教完这四个，玩家掌握了所有输入。Q 调温**故意不进教学** —— 它有冷却、只在过热
 * 过冷时才有意义，而那颗按键本身常驻显示自己的状态（体温适宜 / 取暖 / 降温 / 读秒），
 * 不需要谁来教。
 *
 * ## 每一步都同时照亮「场景里的目标」和「要按的那颗键」
 *
 * 这是这套教学最重要的一条实现约束。只照亮场景目标，玩家知道要对谁动手却不知道
 * 用哪个键；只照亮按键，反过来。两个一起亮，那一步才是完整的一句话：
 * **对那个东西，按这颗键。**
 *
 * 两类目标走**两套机制**，因为它们的处境不一样：
 *
 *   场景里的（角色、猎物、枯木）  画在 canvas 里，抬不出来 → 幕布上挖洞
 *   UI（四颗键、摇杆）            是 DOM，可以抬 → 抬到幕布之上 + 发光，不挖洞
 *
 * UI 那一路一开始也是挖洞的，实测是错的：洞得比按钮大，而右下四颗键排在半径 140px
 * 的弧上、彼此只隔 77~89px —— 照亮背包的洞半径 97px，会把攻击、行动、体温一起照进去。
 * 最需要精确指认的那一步反而指不准。详见 styles.css 里 .tutorial-raise 那段。
 *
 * 场景那一路仍然走 SVG 遮罩而不是 CSS 渐变 —— 一条渐变只挖得动一个洞，
 * 而"角色"和"猎物"这类目标以后可能不止一个。见 index.html。
 *
 * ## 为什么每一步都能在一屏之内做完
 *
 * 三只教学猎物在出生点 6.3~7.8 米、一根教学枯木在 6.5 米，都是构造时写死撒的
 * （见 GameSimulation 的 TUTORIAL_PREY_* / TUTORIAL_WOOD_*）。在此之前最近的
 * 可攻击目标在 27 米外、最近的枯木在 18 米外，一直挥刀的玩家第一次命中要到第 43 秒
 * —— 而第一天白天只有 40 秒，等于这一课在考试之后才到。
 *
 * ## 世界是停的
 *
 * 教学全程 `simulation.setTutorialHold(true)`：五轴不掉、相位不走、狗不动。
 * 这不是为了"温柔"，是因为教学第一步教的就是移动，而 `noteActivity()` 一移动
 * 就点亮时钟 —— 不挡的话，教学做得越完整，玩家被咬死得越快。
 *
 * 注意攻击和拾取仍然是活的：`requestAttack()` / `requestInteraction()` 是独立入口，
 * 只看 `running`；掉落物的结算也特意挪到了时钟闸之前。所以"砍死一只 → 掉肉 →
 * 进包"这条反馈链在冻结状态下完整成立，那正是第二步最该给足的东西。
 */

type Projector = (x: number, z: number) => { x: number; y: number; behind: boolean };

/** 屏幕坐标上的一个亮洞。 */
interface Hole {
  x: number;
  y: number;
  radius: number;
}

type StepId = "move" | "attack" | "act" | "pack";

interface StepDefinition {
  id: StepId;
  /** 主文案键。 */
  line: string;
  /** 副文案键；触屏和键鼠不同的那一步给函数。 */
  sub: string | ((touch: boolean) => string);
  /** 这一步要在**场景里**照亮的东西（幕布挖洞）。空数组表示这一帧维持全暗。 */
  targets: () => Hole[];
  /** 这一步要点亮的 **UI 元素** id（抬层 + 发光，不挖洞）。 */
  lit: () => string[];
  /** 完成判定。事件驱动的那两步靠标记位，其余靠即时状态。 */
  done: () => boolean;
}

/** 每步的软/硬上限：10 秒把提示加重，18 秒直接放行。 */
const STEP_NUDGE_SECONDS = 10;
const STEP_TIMEOUT_SECONDS = 18;
/** 整段教学的硬上限。任何一步卡住都不至于把人锁在这里。 */
const TOTAL_TIMEOUT_SECONDS = 60;
/** 第一步要走出去多远才算学会"走"。按一下键不算。 */
const MOVE_DISTANCE = 3;
/** 最后一步（打开背包）之后，那句"东西都在这里"停留多久。 */
const PACK_CAPTION_SECONDS = 2.6;
/*
 * 亮洞只用在场景目标上（角色、猎物、枯木），半径由各步自己按体型给 ——
 * index.html 的遮罩渐变里 0~58% 是纯黑（真正挖穿的那一圈），外面才是软边，
 * 所以下面那几个半径都要按"再打个七折才是实亮区"来读。
 * UI 不走这条路，见头注释里那段"两套机制"。
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const STORAGE_KEY = "desert-survivor.tutorial.v1";

const isTouchLayout = (): boolean =>
  matchMedia("(pointer: coarse)").matches || window.innerWidth <= 760;

/** localStorage 在隐私模式 / 跨域 iframe 里会直接抛。教学是锦上添花，静默降级。 */
const readDone = (): boolean => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const writeDone = (): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* 存不下就算了，最多下次再播一遍 */
  }
};

const required = <T extends Element>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as unknown as T;
};

export interface TutorialDeps {
  simulation: GameSimulation;
  /** 世界坐标 → 画布像素。渲染层提供，和卡车边缘指示器共用同一个投影。 */
  project: Projector;
  /** 背包当前开着没有。第四步的完成判定。 */
  isInventoryOpen: () => boolean;
  /**
   * 计时是否该停住。广告和暂停期间玩家根本没在看这一屏，
   * 计时照跑的话，一次插屏广告足够把两步的超时烧光、自动放行到最后。
   *
   * **不能简单用 isGameplayBlocked()** —— 它把"背包开着"也算成阻塞，
   * 而第四步的完成条件正是背包开着，那样教学会卡在最后一步永远走不完。
   */
  isTimerFrozen: () => boolean;
  /** 教学结束（走完或跳过）时回调，用来放开时钟闸。 */
  onFinish: () => void;
}

export class Tutorial {
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

  private readonly steps: StepDefinition[];
  /** 复用的 <circle>，不每帧重建 —— 增删节点会让软边缘闪。 */
  private readonly circles: SVGCircleElement[] = [];
  /** 当前亮着的 UI 元素 id。换步和收尾时按它回收 class。 */
  private readonly litIds = new Set<string>();
  private index = 0;
  private stepTime = 0;
  private totalTime = 0;
  private running = false;
  private packCaptionTime = 0;
  /** 事件驱动的完成标记：砍死教学猎物、捡到枯木。 */
  private killedPrey = false;
  private pickedWood = false;
  private origin = { x: 0, z: 0 };
  private touch = isTouchLayout();

  constructor(private readonly deps: TutorialDeps) {
    const { simulation, project } = deps;

    const worldHole = (point: { x: number; z: number } | null, radius: number): Hole | null => {
      if (!point) return null;
      const screen = project(point.x, point.z);
      // 目标转到镜头背后时不画洞（等距视角下极少见，切屏尺寸时会短暂发生）。
      if (screen.behind) return null;
      return { x: screen.x, y: screen.y, radius };
    };

    const nearestPrey = (): { x: number; z: number } | null => {
      const alive = simulation.critters
        .filter((critter) => critter.kind === TUTORIAL_PREY && critter.mode !== "dead")
        .sort((a, b) => this.distanceToPlayer(a) - this.distanceToPlayer(b));
      return alive[0] ?? null;
    };

    const nearestWood = (): { x: number; z: number } | null => {
      const logs = simulation.items
        .filter((item) => item.active && item.kind === "wood")
        .sort((a, b) => this.distanceToPlayer(a) - this.distanceToPlayer(b));
      return logs[0] ?? null;
    };

    /** 收拢一组可能为 null 的洞。 */
    const holes = (...candidates: Array<Hole | null>): Hole[] =>
      candidates.filter((hole): hole is Hole => hole !== null);

    this.steps = [
      {
        id: "move",
        line: "tutorial.move",
        // 触屏是按下即生成的浮动摇杆，键鼠是 WASD 或点地。这一条必须分开说。
        sub: (touch) => (touch ? "tutorial.move.touch" : "tutorial.move.pc"),
        targets: () => holes(worldHole(simulation.player, this.touch ? 104 : 92)),
        // 摇杆只是"待机位"的显示件（真正的操作区是整个左半屏），但它是触屏玩家
        // 唯一看得见的"手放这里"，不点亮等于只教了走、没教怎么走。键鼠档没有对应控件。
        lit: () => (this.touch ? ["joystick"] : []),
        done: () => this.distanceFromOrigin() >= MOVE_DISTANCE,
      },
      {
        id: "attack",
        line: "tutorial.attack",
        sub: "tutorial.attack.sub",
        targets: () => holes(worldHole(nearestPrey(), 96)),
        lit: () => ["attack-button"],
        // 判定是"打死"而不是"打中"：拾骨鸦 10 血、匕首 30 伤害，一刀就死，
        // 等它死才凑得齐"挥刀 → 命中 → 掉东西 → 进包"这条完整反馈。
        done: () => this.killedPrey,
      },
      {
        id: "act",
        line: "tutorial.act",
        sub: "tutorial.act.sub",
        targets: () => holes(worldHole(nearestWood(), 92)),
        lit: () => ["action-button"],
        done: () => this.pickedWood,
      },
      {
        id: "pack",
        line: "tutorial.pack",
        sub: "tutorial.pack.sub",
        // 这一步的目标本来就是一颗按键，场景里没有东西要照。
        targets: () => [],
        lit: () => ["backpack-button"],
        done: () => deps.isInventoryOpen(),
      },
    ];

    this.buildDots();
    this.skipButton.addEventListener("click", () => this.finish());
  }

  /** 这一局要不要播。已经播过、或者玩家跳过过，就再也不播。 */
  static shouldRun(): boolean {
    return !readDone();
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.index = 0;
    this.stepTime = 0;
    this.totalTime = 0;
    this.touch = isTouchLayout();
    this.origin = { x: this.deps.simulation.player.x, z: this.deps.simulation.player.z };
    this.skipButton.textContent = t("tutorial.skip");
    this.skipButton.classList.remove("hidden");
    this.root.classList.remove("hidden");
    this.veilLayer.classList.remove("hidden");
    this.hud.classList.add("tutorial-dim");
    this.renderCaption();
  }

  handle(event: GameEvent): void {
    if (!this.running) return;
    if (event.type === "critter-killed" && event.kind === TUTORIAL_PREY) this.killedPrey = true;
    if (event.type === "pickup" && event.kind === "wood") this.pickedWood = true;
  }

  update(delta: number): void {
    if (!this.running) return;
    // 广告 / 暂停期间只冻结计时，界面照旧留在原地等玩家回来。
    if (this.deps.isTimerFrozen()) return;
    this.totalTime += delta;
    this.stepTime += delta;

    // 最后一步完成后，"东西都在这里"再停留一会儿再收尾。
    if (this.packCaptionTime > 0) {
      this.packCaptionTime -= delta;
      if (this.packCaptionTime <= 0) this.finish();
      return;
    }

    if (this.totalTime >= TOTAL_TIMEOUT_SECONDS) {
      this.finish();
      return;
    }

    const step = this.steps[this.index];
    if (!step) {
      this.finish();
      return;
    }

    this.paint(step);

    if (step.done() || this.stepTime >= STEP_TIMEOUT_SECONDS) this.advance();
  }

  /** 走完或跳过都从这里出去：收界面、写盘、放开时钟闸。 */
  private finish(): void {
    if (!this.running) return;
    this.running = false;
    // 高亮是加在 HUD 自己的元素上的，不随幕布一起消失 —— 必须逐个收回来，
    // 否则教学结束后那颗键会一直发着光、而且一直压在别的 UI 之上。
    this.syncLit([]);
    this.root.classList.add("hidden");
    this.root.classList.remove("over-pack");
    this.veilLayer.classList.add("hidden");
    this.hud.classList.remove("tutorial-dim");
    writeDone();
    this.deps.onFinish();
  }

  private advance(): void {
    const step = this.steps[this.index];
    this.index += 1;
    this.stepTime = 0;
    if (this.index >= this.steps.length) {
      // 背包那一步走完时背包正开着，玩家的眼睛在格子上 —— 那句话现在说才有人看。
      // 背包遮罩层在教学之上（z-index 35 对 12），所以这里把幕布收掉，只留文字。
      if (step?.id === "pack") {
        this.packCaptionTime = PACK_CAPTION_SECONDS;
        this.line.textContent = t("tutorial.pack.done");
        this.sub.textContent = t("tutorial.pack.sub");
        // 抬的是整个字幕层，不是这行字本身 —— .tutorial 是 fixed，子元素的
        // z-index 爬不出它自己的层叠上下文（见 styles.css 里那段注释）。
        this.root.classList.add("over-pack");
        this.caption.classList.add("over-pack");
        this.skipButton.classList.add("hidden");
        // 最后一句是"东西都在这里"，玩家的眼睛在刚打开的背包上 ——
        // 这时候幕布和压暗都该退场，别再挡着他看那八个格子。
        this.veilLayer.classList.add("hidden");
        this.hud.classList.remove("tutorial-dim");
        this.syncDots();
        return;
      }
      this.finish();
      return;
    }
    this.renderCaption();
  }

  private paint(step: StepDefinition): void {
    this.syncHoles(step.targets());
    this.syncLit(step.lit());
    // 卡了十秒还没做出来就把提示加重。**不换文案** —— 换一句等于承认第一句没写清楚，
    // 而玩家这时缺的是更显眼，不是更多字。
    this.caption.classList.toggle("urgent", this.stepTime >= STEP_NUDGE_SECONDS);

    // 触屏判定每帧复查：它同时看 pointer 和 innerWidth，而 innerWidth 会因为
    // 手机横竖屏切换而翻转。只在开播时采样一次的话，转一次屏就会一直挂着
    // 上一种输入方式的文案（"WASD" 给触屏玩家看，或者反过来）。
    const touch = isTouchLayout();
    if (touch !== this.touch) {
      this.touch = touch;
      this.renderCaption();
    }
  }

  /**
   * 把这一帧的亮洞写进 SVG 遮罩。
   *
   * `<circle>` 复用而不是每帧重建：重建会让浏览器重新解析渐变引用，软边缘因此闪一下。
   * 多出来的圆半径归零藏起来，不从 DOM 里摘掉。
   */
  private syncHoles(targets: Hole[]): void {
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
   * 点亮这一步要按的那几颗 UI 键。
   *
   * 只做一件事：给它们挂上 .tutorial-lit。压暗、发光全在 CSS 里 ——
   * `#hud.tutorial-dim` 把面板和其余按键压下去，被点名的这几颗不压、并加一圈光。
   *
   * **没有任何 z-index 操作。** 早先试过把按键抬到幕布之上，抬不动：
   * #hud 是 position: fixed，本身就创建层叠上下文，子元素爬不出去。
   * 现在幕布整层排在 #hud 之前、z 比它低，压根不需要抬。
   */
  private syncLit(ids: string[]): void {
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

  private renderCaption(): void {
    const step = this.steps[this.index];
    if (!step) return;
    this.line.textContent = t(step.line);
    this.sub.textContent = t(typeof step.sub === "function" ? step.sub(this.touch) : step.sub);
    this.caption.classList.remove("over-pack");
    this.root.classList.remove("over-pack");
    // urgent 由 paint() 每帧按 stepTime 自己决定，这里不碰 —— 转屏重排文案时
    // 顺手清掉它的话，卡住十秒的玩家会看见提示突然不闪了。
    this.veil.style.opacity = "";
    this.syncDots();
  }

  private buildDots(): void {
    this.dots.replaceChildren(...this.steps.map(() => document.createElement("i")));
  }

  private syncDots(): void {
    Array.from(this.dots.children).forEach((dot, index) => {
      dot.classList.toggle("done", index < this.index);
      dot.classList.toggle("on", index === this.index);
    });
  }

  private distanceToPlayer(point: { x: number; z: number }): number {
    const player = this.deps.simulation.player;
    return Math.hypot(player.x - point.x, player.z - point.z);
  }

  private distanceFromOrigin(): number {
    const player = this.deps.simulation.player;
    return Math.hypot(player.x - this.origin.x, player.z - this.origin.z);
  }
}
