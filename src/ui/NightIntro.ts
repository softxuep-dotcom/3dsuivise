import type { GameSimulation } from "../game/simulation/GameSimulation";
import type { CampDefinition, GameEvent, Vec2 } from "../game/simulation/types";
import { t } from "../i18n";
import { readTutorialFlag, writeTutorialFlag } from "./TutorialStage";
import type { TutorialStage } from "./TutorialStage";

/**
 * 第一夜：**一次推镜，三秒半，没有别的。**
 *
 * ## 它教什么
 *
 * 只教一条因果，而且是用镜头教的，不是用字教的：
 *
 *     天黑了 → 去把那堆篝火点起来
 *
 * 时间冻住、镜头从人物推到营火、一句「点燃篝火」加一句理由、镜头收回、放行。
 * 玩家不需要在这段里做任何操作。
 *
 * ## 为什么从三拍砍成一拍
 *
 * 原先是三拍二十秒：推镜 → 指着行动键教点火 → 盯着体温条教取暖，配一个跳过按钮
 * 和三颗进度圆点。问题是后两拍在**替玩家做决定**：它们把行动键锁成"点燃"、
 * 把体温条挑出来高亮，还要等玩家照做才肯往下走（做不到就超时 14 秒 / 16 秒）。
 * 一段教学在天刚黑、狗正在出巢的时候占着屏幕二十秒，本身就是最贵的东西。
 *
 * 而那两拍要教的事，游戏里已经各有出口在教：行动键走到火边自己会写"点燃"
 * （见 HudController 的 actionOverride），体温掉到阈值下目标行会说 sim.17。
 * 教学只留下它唯一无可替代的那一件：**把镜头指过去**。
 *
 * 跳过按钮跟着一起没了 —— 三秒半的东西不需要给人跳过的负担，
 * 而那颗按钮是整个 TutorialStage 里唯一需要接事件的部件。
 */

// v3：从三拍砍成一拍。看过 v1 / v2 的玩家应当再看到这一版一次。
const STORAGE_KEY = "desert-survivor.nightIntro.v3";
/** 推镜停留多久。整段就这么长。 */
const HOLD_SECONDS = 3.4;

export interface NightIntroDeps {
  simulation: GameSimulation;
  stage: TutorialStage;
  /** 把聚光灯打到某个世界坐标上；null = 收灯。 */
  spotlight: (target: Vec2 | null) => void;
  /** 把镜头推到某点 / 收回来。渲染层提供。 */
  focusCamera: (target: Vec2 | null) => void;
  /** 时钟闸。见 GameSimulation.setTutorialHold。 */
  setHold: (active: boolean) => void;
  /** 广告 / 暂停期间冻结计时。 */
  isTimerFrozen: () => boolean;
}

export class NightIntro {
  private elapsed = 0;
  private running = false;

  constructor(private readonly deps: NightIntroDeps) {}

  /** 这一局要不要播。看过一次就永久熄灭。 */
  static shouldRun(): boolean {
    return !readTutorialFlag(STORAGE_KEY);
  }

  get active(): boolean {
    return this.running;
  }

  /**
   * 软重启：退回未开始。
   *
   * 第二局起它多半根本不会跑（shouldRun 查的是 localStorage 那面旗），
   * 但玩家完全可能在这三秒半里死掉再重开，那时 elapsed 还停在半路。
   */
  reset(): void {
    this.elapsed = 0;
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
    this.running = true;
    this.elapsed = 0;
    this.deps.stage.show();
    this.deps.stage.setCaption(t("night.lightFire"), t("night.lightFire.sub"));
    this.deps.spotlight(camp);
    this.deps.focusCamera(camp);
    this.deps.setHold(true);
  }

  update(delta: number): void {
    if (!this.running) return;
    if (this.deps.isTimerFrozen()) return;
    this.elapsed += delta;
    if (this.elapsed >= HOLD_SECONDS) this.finish();
  }

  /** 走完就从这里出去：收镜头、收灯、放时钟、收界面、写盘。 */
  private finish(): void {
    if (!this.running) return;
    this.running = false;
    this.deps.spotlight(null);
    this.deps.focusCamera(null);
    this.deps.setHold(false);
    this.deps.stage.hide();
    writeTutorialFlag(STORAGE_KEY);
  }

  /**
   * 今晚看哪座营地 —— 离玩家最近的那座。
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
