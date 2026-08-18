import type { GameSimulation } from "../game/simulation/GameSimulation";
import type { CampDefinition, GameEvent, Vec2 } from "../game/simulation/types";
import { t } from "../i18n";
import { readTutorialFlag, writeTutorialFlag } from "./Tutorial";
import type { TutorialStage, Hole } from "./TutorialStage";

/**
 * 第一夜教学：三拍，二十秒。
 *
 * ## 为什么夜晚需要单独一段
 *
 * 开场教学教的是四个**输入**（走、砍、拿、开包）。夜晚要教的完全不是输入 ——
 * 那三颗键都已经会按了 —— 而是一条只在夜里成立的**因果**：
 *
 *     天黑 → 体温开始掉（−1.05/s） → 篝火是唯一的天花板 → 所以先去把火烧起来
 *
 * 这条链上每一环都不在屏幕上：体温条在掉但没人会盯着它；火焰半径 10 米，
 * 边界完全不可见；而"柴要在白天捡"这件事，等你冷到发抖时已经来不及学了。
 * 实测第一天白天只有 40 秒，玩家往往在还没意识到夜晚是什么之前天就黑了。
 *
 * ## 三拍
 *
 *   1. 停 —— 时间冻住，一声狼嚎，镜头从人物推到营火上（3.4 秒，不需要操作）
 *   2. 点火 —— 镜头收回，照亮火塘和行动键，等玩家添一根柴
 *   3. 取暖 —— **放开时钟**，照亮体温条，等他在火边站够 2.6 秒
 *
 * 第 3 拍必须放开时钟，因为那一拍要看的正是体温条往回涨 —— 冻着的话
 * 这一课的证据本身不会发生。前两拍则必须冻着：狼在第 0.45 秒就开始出巢，
 * 一边讲课一边挨咬的话，这段教学只会变成一次不明不白的死亡。
 *
 * ## 没有柴怎么办
 *
 * 第 2 拍是唯一可能做不到的一拍（背包里没柴就添不了火）。所以它同时有
 * 超时放行和一句专门的副文案 —— 这种情况下这一拍教的是"下次白天要先捡柴"，
 * 它仍然是这段教学里最该说的话。
 */

type Projector = (x: number, z: number) => { x: number; y: number; behind: boolean };

interface Beat {
  /** 主/副文案键。副文案给函数是为了按当下的处境换说法（比如包里有没有柴）。 */
  line: string;
  sub: () => string;
  /** 场景里要挖的亮洞。 */
  targets: () => Hole[];
  /** 要提亮的 UI 元素 id。 */
  lit: () => string[];
  /** 这一拍期间镜头看哪；null = 看玩家。 */
  focus: () => Vec2 | null;
  /** 这一拍要不要继续冻着世界。 */
  hold: boolean;
  /** 完成判定。第一拍没有操作，靠 minSeconds 自己走完。 */
  done: () => boolean;
  /** 最短停留：不到这个时长就算 done() 成立也不推进，避免一闪而过。 */
  minSeconds: number;
  /**
   * 硬超时，卡住也要放行。给函数是因为它得看处境 ——
   * 一拍**做不到**（没柴可添）和一拍**没做**（在犹豫）该等的时间完全不一样。
   */
  timeoutSeconds: () => number;
  /** 进这一拍之前先问一句：这一拍现在还有意义吗？没有就整拍跳过。 */
  skip?: () => boolean;
}

const STORAGE_KEY = "desert-survivor.nightIntro.v1";
/** 第三拍要在火边站够多久才算学会。累计，不要求连续。 */
const WARM_SECONDS = 2.6;
/** 整段的硬上限。 */
const TOTAL_TIMEOUT_SECONDS = 46;

export interface NightIntroDeps {
  simulation: GameSimulation;
  stage: TutorialStage;
  project: Projector;
  /** 把镜头推到某点 / 收回来。渲染层提供。 */
  focusCamera: (target: Vec2 | null) => void;
  /** 时钟闸。和开场教学共用同一道，见 GameSimulation.setTutorialHold。 */
  setHold: (active: boolean) => void;
  /** 舞台是不是正被开场教学占着。理论上不会撞（教学期间时钟停着，天黑不了）。 */
  isStageBusy: () => boolean;
  /** 广告 / 暂停期间冻结计时。 */
  isTimerFrozen: () => boolean;
}

export class NightIntro {
  private readonly beats: Beat[];
  private index = 0;
  private beatTime = 0;
  private totalTime = 0;
  private running = false;
  private warmedTime = 0;
  /** 这一夜要守的那座营地。开播时定死 —— 中途换成别的会让镜头和亮洞跳。 */
  private camp: CampDefinition | null = null;

  constructor(private readonly deps: NightIntroDeps) {
    const { simulation, project } = deps;

    const worldHole = (point: Vec2 | null, radius: number): Hole[] => {
      if (!point) return [];
      const screen = project(point.x, point.z);
      if (screen.behind) return [];
      return [{ x: screen.x, y: screen.y, radius }];
    };

    const hasWood = (): boolean => simulation.getInventoryCount("wood") > 0;

    this.beats = [
      {
        line: "night.howl",
        sub: () => "night.howl.sub",
        // 镜头这时正推向营火，洞跟着营火走 —— 玩家的眼睛和镜头看同一个地方。
        targets: () => worldHole(this.camp, 128),
        lit: () => [],
        focus: () => this.camp,
        hold: true,
        done: () => true,
        minSeconds: 3.4,
        timeoutSeconds: () => 3.4,
      },
      {
        line: "night.fire",
        // 包里没柴时这一拍教的是另一件事，文案必须跟着换。
        sub: () => (hasWood() ? "night.fire.sub" : "night.fire.noWood"),
        targets: () => worldHole(this.camp, 104),
        lit: () => ["action-button"],
        focus: () => null,
        hold: true,
        done: () => simulation.getNearestLitCamp() !== null,
        minSeconds: 0.9,
        // 有柴：给足 14 秒走过去按一下。没柴：这一拍**做不到**，说完那句
        // "白天要先捡枯木"就该放人走 —— 让他对着一颗按不出结果的键干等
        // 十四秒，只会教会他这套教学不值得看。
        timeoutSeconds: () => (hasWood() ? 14 : 5),
      },
      {
        line: "night.warm",
        sub: () => "night.warm.sub",
        // 这一拍照的是玩家自己：要看的是他脚下那圈取暖光环亮起来。
        targets: () => worldHole(simulation.player, 108),
        lit: () => ["warmth-meter"],
        focus: () => null,
        // **放开时钟**：体温要真的往回涨，这一拍才有东西可看。
        hold: false,
        done: () => this.warmedTime >= WARM_SECONDS,
        minSeconds: 1.2,
        timeoutSeconds: () => 16,
        // 上一拍没能把火点起来（没柴）的话，这一拍要教的东西根本不存在 ——
        // 对着一堆冷灰说"待在火边"是句假话，不如闭嘴把屏幕还给玩家。
        skip: () => simulation.getNearestLitCamp() === null,
      },
    ];
  }

  /** 这一局要不要播。和开场教学各记各的：跳过开场的人仍然会看到这一段。 */
  static shouldRun(): boolean {
    return !readTutorialFlag(STORAGE_KEY);
  }

  get active(): boolean {
    return this.running;
  }

  handle(event: GameEvent): void {
    // 死了或通关了就立刻收摊。结算页在这两层之上（z 20+ 对 14/1），
    // 留着不收的话玩家会隔着结算卡看到一块还压着暗的 HUD。
    if (event.type === "game-over" || event.type === "victory") {
      this.finish();
      return;
    }
    if (event.type !== "phase" || event.phase !== "night" || event.day !== 1) return;
    this.start();
  }

  private start(): void {
    if (this.running || this.deps.isStageBusy() || !NightIntro.shouldRun()) return;
    const camp = this.findHomeCamp();
    if (!camp) return;
    this.camp = camp;
    this.running = true;
    this.index = 0;
    this.beatTime = 0;
    this.totalTime = 0;
    this.warmedTime = 0;
    this.deps.stage.onSkip(() => this.finish());
    this.deps.stage.buildDots(this.beats.length);
    this.deps.stage.show(t("tutorial.skip"));
    this.enterBeat();
  }

  update(delta: number): void {
    if (!this.running) return;
    if (this.deps.isTimerFrozen()) return;
    this.totalTime += delta;
    this.beatTime += delta;
    // 第三拍的计时器：累计而不是连续，走出去一下再回来不用从头再站。
    if (this.deps.simulation.isWarmedByFire()) this.warmedTime += delta;

    if (this.totalTime >= TOTAL_TIMEOUT_SECONDS) {
      this.finish();
      return;
    }

    const beat = this.beats[this.index];
    if (!beat) {
      this.finish();
      return;
    }
    this.deps.stage.setHoles(beat.targets());
    this.deps.stage.setLit(beat.lit());

    const satisfied = this.beatTime >= beat.minSeconds && beat.done();
    if (satisfied || this.beatTime >= beat.timeoutSeconds()) this.advance();
  }

  private advance(): void {
    this.index += 1;
    this.beatTime = 0;
    // 连着跳过好几拍也要走得下去，所以是 while 不是 if。
    while (this.beats[this.index]?.skip?.()) this.index += 1;
    if (this.index >= this.beats.length) {
      this.finish();
      return;
    }
    this.enterBeat();
  }

  /** 换拍：文案、圆点、镜头、时钟闸一次性对齐到这一拍的声明。 */
  private enterBeat(): void {
    const beat = this.beats[this.index];
    if (!beat) return;
    this.deps.stage.setCaption(t(beat.line), t(beat.sub()));
    this.deps.stage.setDots(this.index);
    this.deps.stage.setUrgent(false);
    this.deps.focusCamera(beat.focus());
    this.deps.setHold(beat.hold);
  }

  /** 走完或跳过都从这里出去：收镜头、放时钟、收界面、写盘。 */
  private finish(): void {
    if (!this.running) return;
    this.running = false;
    this.deps.focusCamera(null);
    this.deps.setHold(false);
    this.deps.stage.hide();
    writeTutorialFlag(STORAGE_KEY);
  }

  /**
   * 今晚守哪座营地 —— 离玩家最近的那座。
   *
   * 不用 world.startCampId：玩家完全可以在第一个白天走到另一座营地去，
   * 那时把镜头推向他早就离开的出生营地，等于指错了方向。
   */
  private findHomeCamp(): CampDefinition | null {
    const player = this.deps.simulation.player;
    let best: CampDefinition | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const camp of this.deps.simulation.world.camps) {
      const value = Math.hypot(camp.x - player.x, camp.z - player.z);
      if (value >= bestDistance) continue;
      best = camp;
      bestDistance = value;
    }
    return best;
  }
}
