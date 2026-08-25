import type { GameSimulation } from "../game/simulation/GameSimulation";
import type { CampDefinition, GameEvent, LocalizedText, Vec2 } from "../game/simulation/types";
import { t } from "../i18n";
import { readTutorialFlag, writeTutorialFlag } from "./TutorialStage";
import type { TutorialStage } from "./TutorialStage";

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
 *   2. 点火 —— 镜头收回，同时恢复时间与正常光照；行动键提示点火，但不再挡住游戏
 *   3. 取暖 —— 维持正常时间与光照，只照亮体温条，等他在火边站够 2.6 秒
 *
 * 只有第 1 拍冻结世界：推镜时玩家看不见自己，不能让战斗趁机发生。镜头一开始
 * 返回玩家，第 2、3 拍就必须同时恢复时间和光照。否则画面已经把控制权还给玩家，
 * 系统却仍逼他在压暗的世界里找路，视觉信号与实际状态互相矛盾。
 *
 * ## 没有柴怎么办
 *
 * 第 2 拍是唯一可能做不到的一拍（背包里没柴就添不了火）。开局口粮里因此
 * **白送一根枯木**（见 STARTING_RATION），第一夜这条链必定走得通。
 *
 * 但保底的分支仍然留着 —— 玩家完全可能在白天就把那根烧了，或者干脆跳过开场教学
 * 一路乱走。那时这一拍换成一句"白天要先捡枯木"、缩短超时、并把第 3 拍整拍跳过：
 * 对着一堆冷灰说"待在火边"是句假话。
 */

interface Beat {
  /** 主/副文案键。副文案给函数是为了按当下的处境换说法（比如包里有没有柴）。 */
  line: string;
  sub: () => string;
  /** 这一拍聚光灯打在哪（世界坐标）；null = 收灯。 */
  spot: () => Vec2 | null;
  /** 要提亮的 UI 元素 id。 */
  lit: () => string[];
  /** 这一拍期间镜头看哪；null = 看玩家。 */
  focus: () => Vec2 | null;
  /** 这一拍要不要继续冻着世界。 */
  hold: boolean;
  /** 这一拍期间"行动"键显示成什么；不给就照常显示当前可交互物。 */
  actionLabel?: "ignite";
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

// v2：镜头返回时会同步恢复时间和光照。旧版看过 v1 的玩家也应看到修正版一次。
const STORAGE_KEY = "desert-survivor.nightIntro.v2";
/** 第三拍要在火边站够多久才算学会。累计，不要求连续。 */
const WARM_SECONDS = 2.6;
/** 整段的硬上限。 */
const TOTAL_TIMEOUT_SECONDS = 46;

export interface NightIntroDeps {
  simulation: GameSimulation;
  stage: TutorialStage;
  /** 把聚光灯打到某个世界坐标上；null = 收灯。 */
  spotlight: (target: Vec2 | null) => void;
  /** 把镜头推到某点 / 收回来。渲染层提供。 */
  focusCamera: (target: Vec2 | null) => void;
  /** 时钟闸。和开场教学共用同一道，见 GameSimulation.setTutorialHold。 */
  setHold: (active: boolean) => void;
  /** 临时改写"行动"键的显示；传 null 还原。 */
  setActionLabel: (hint: { action: "ignite"; text: LocalizedText } | null) => void;
  /** 舞台是不是正被开场教学占着。理论上不会撞（教学期间时钟停着，天黑不了）。 */
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
    const { simulation } = deps;

    const hasWood = (): boolean => simulation.getInventoryCount("wood") > 0;

    this.beats = [
      {
        line: "night.howl",
        sub: () => "night.howl.sub",
        // 镜头这时正推向营火，灯也打在营火上 —— 玩家的眼睛和镜头看同一个地方。
        spot: () => this.camp,
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
        // 推镜结束就收灯：镜头、时间、光照在同一个状态边界恢复给玩家。
        spot: () => null,
        lit: () => ["action-button"],
        focus: () => null,
        hold: false,
        // 这一拍指的那颗键上写的得是"点燃"，不能是通用的"行动" ——
        // 教学正指着它，而它此刻还没写上答案。见 HudController.actionOverride。
        actionLabel: "ignite",
        done: () => simulation.getNearestLitCamp() !== null,
        minSeconds: 0.9,
        // 这只是非阻塞的观察窗口，不再冻结时间或压暗世界：玩家在 14 秒内点着火，
        // 就继续展示取暖反馈；没有点着则自动收掉教学。没柴时只让说明停留 5 秒。
        timeoutSeconds: () => (hasWood() ? 14 : 5),
      },
      {
        line: "night.warm",
        sub: () => "night.warm.sub",
        // 镜头已经还给玩家，世界光照保持正常；只用 HUD 高亮说明体温正在恢复。
        spot: () => null,
        lit: () => ["warmth-meter"],
        focus: () => null,
        // 时钟继续正常走：体温要真的往回涨，这一拍才有东西可看。
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

  /**
   * 软重启：把这段教学退回未开始。
   *
   * 实际上第二局起它多半根本不会跑 —— shouldRun() 查的是 localStorage 里那面旗，
   * 看过一次就永久熄灭。但玩家完全可能在第一夜教学演到一半时死掉再重开，
   * 那时 index/beatTime 还停在半路上。
   */
  reset(): void {
    this.index = 0;
    this.beatTime = 0;
    this.totalTime = 0;
    this.warmedTime = 0;
    this.running = false;
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
    if (this.running || !NightIntro.shouldRun()) return;
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
    this.deps.spotlight(beat.spot());
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
    this.deps.setActionLabel(beat.actionLabel
      ? { action: beat.actionLabel, text: { key: "night.fire.hint" } }
      : null);
  }

  /** 走完或跳过都从这里出去：收镜头、放时钟、收界面、写盘。 */
  private finish(): void {
    if (!this.running) return;
    this.running = false;
    this.deps.spotlight(null);
    this.deps.focusCamera(null);
    this.deps.setHold(false);
    this.deps.setActionLabel(null);
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
