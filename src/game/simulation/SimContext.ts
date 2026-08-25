import type { GameEvent, Phase, PlayerState, WorldDefinition } from "./types";

/**
 * 各子系统共用的那一小片模拟层。**GameSimulation 实现它。**
 *
 * ## 为什么要有这个东西
 *
 * WolfDirector 抽出去时配的 `WolfWorld` 有 **30 个成员** —— 那是"先抽出来、
 * 端口跟着长成那样"的结果。如果后面每个子系统都长一个三十成员的接口，
 * 八份加起来会比拆之前更难读：读者要在八张互相重叠的清单之间对照，
 * 才能回答"这个系统到底看得见什么"。
 *
 * 所以先把**每个系统都要的那几样**收在这里，各系统的端口从它继承，
 * 只声明自己额外需要的那一两个。看一个系统的端口，就等于看它比别人多要了什么。
 *
 * ## 加成员之前先问一句
 *
 * 这张表长一个成员，八个系统的可见范围就一起变大一圈。只有**三个以上**系统
 * 真的需要才往里加；只有一两个要的，写进那个系统自己的端口里。
 *
 * 对照 movement/CollisionKernel.ts：它的端口只有三个成员，而且**不继承这里** ——
 * 它连玩家是谁都不需要知道，那是抽得最干净的一块，能不继承就不继承。
 */
export interface SimContext {
  readonly world: WorldDefinition;
  readonly player: PlayerState;
  /** 游戏是否还在进行。死亡或通关之后为 false，此时绝大多数动作都该直接返回。 */
  readonly running: boolean;
  readonly phase: Phase;
  readonly day: number;
  /** 时钟起表以来的模拟秒数。教学冻结期间不累加。 */
  readonly elapsed: number;
  /** 刚挨过打之后的倒计时。休息和撤退判定都看它。 */
  readonly combatTimer: number;

  /** 事件出口。HUD 每帧用 drainEvents() 取走。 */
  emit(event: GameEvent): void;
  /** 本局的确定性随机源（mulberry32，实例私有）。 */
  random(): number;
  /** 玩家动了：起表、清静止计时、打断休息。 */
  noteActivity(): void;
  /** 原地动作（吃喝、合成）：**只起表**，不打断休息、不清静止计时。 */
  noteInPlaceAction(): void;
  /** 身边有没有点着的火。判定半径统一走 FIRE_WARMTH_RADIUS。 */
  hasLitFireNearby(): boolean;
}
