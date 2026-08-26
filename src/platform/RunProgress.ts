import type { GameEvent } from "../game/simulation/types";
import type { GameSimulation } from "../game/simulation/GameSimulation";
import type { ProgressAction } from "./GamePlatform";

/**
 * 把这一局的关键节点报给 Poki 的 **Progress Events**。
 *
 * ## 为什么要有这个文件
 *
 * 后台那张表原先**只有一行** `game / loading` —— 而那一行还不是我们报的，
 * 是 SDK 的引导脚本自己调的（`PokiSDK.measure("game","loading","start")`）。
 * 也就是说这个面板从来没被用过。
 *
 * 而我们一直在猜的那几个数，它每一个都能直接给：
 *
 *     有多少人活过第一夜？        ← 之前只能靠自动机的代理指标，而那个指标
 *                                   一度因为机器人自己的策略 bug 恒等于 55%
 *     装车中位停在第几桶？        ← 之前只有机器人的 1~2/6
 *     死了之后有多少人按重开？    ← 之前完全没有。而 Poki 的平均时长是把
 *                                   一个会话里所有局加起来算的，所以这个
 *                                   转化率是**乘进读数**的，比什么都值钱
 *     有多少人造出第一件装备？    ← 剪刀差填平没有
 *
 * 而且它不吃 Fit Test 那 40~60 秒的噪声：这是直接计数，还能按设备和版本筛。
 *
 * ## 口径
 *
 * `measure(category, what, action)`，表里显示成 `category / what`。
 * 一次尝试**只能收口一次**（complete 和 fail 不能都报），没收口的落进 Left 列。
 * 于是三种结局天然分开：
 *
 *     complete  做到了
 *     fail      死了（在这一节点上失败）
 *     Left      没做到也没死 —— 关页面走人
 *
 * 「死」和「走」分开是这里最值钱的一点：它们要用完全不同的办法去修。
 */

/** 一个节点的名字。`/` 和 `^` 会被适配层换掉，所以这里不要用。 */
type Node = string;

const NIGHT_ONE: Node = "night|1";
const EQUIP_FIRST: Node = "equip|first";
const RESTART: Node = "run|restart";

/*
 * 材料侧的四个节点。
 *
 * 731 局实测 equip/first 的 Completed 只有 5.9% —— 94% 的人整局没造出过任何装备。
 * 而 UI 早就不是瓶颈：QuickCraftController 只在"此刻真的能造"时才出现。
 * 所以卡点在材料，但**卡在哪一步完全不知道**，只能靠猜。这四个节点是来拆开它的：
 *
 *   mat|hide     拿到第一张兽皮   —— 兽皮只有两个来源（长角羚 4 只、狼），都要打
 *   mat|wood2    攒到 2 根柴      —— 开局给 0 根，而柴同时是唯一的燃料
 *   equip|ready  皮≥1 且 柴≥2     —— sword-1 的料**同时**齐了
 *   ui|pack      打开过背包       —— 吃、烤、合成、建造的唯一入口
 *
 * equip|ready 和 equip|first 是**成对读**的：
 *   ready 低              → 材料就没凑齐，该降造价或改掉落
 *   ready 高而 first 低   → 凑齐了却没造，那是认知问题
 * 这两种要用完全不同的办法修，混在一起就什么都读不出来。
 */
const MAT_HIDE: Node = "mat|hide";
const MAT_WOOD2: Node = "mat|wood2";
const EQUIP_READY: Node = "equip|ready";
const CAMP_FIRE: Node = "camp|fire";
const UI_PACK: Node = "ui|pack";

/** sword-1 = 兽皮×1 + 枯木×2，是全部一阶里最便宜、且不要火的一件。 */
const READY_HIDE = 1;
const READY_WOOD = 2;

const split = (node: Node): [string, string] => {
  const at = node.indexOf("|");
  return [node.slice(0, at), node.slice(at + 1)];
};

export interface RunProgressWorld {
  /** getter 而不是值：软重启会换掉 simulation。 */
  readonly simulation: GameSimulation;
  measure(category: string, what: string, action: ProgressAction): void;
}

export class RunProgress {
  /** 已经 start、还没收口的节点。 */
  private readonly open = new Set<Node>();
  /** 这一局已经收过口的节点；防止同一个节点报两次结局。 */
  private readonly done = new Set<Node>();
  /**
   * 「死了之后要不要再来」这一节点**跨局**存在：start 在上一局的结算页，
   * complete 在玩家点下重开、也就是新的一局 beginRun() 之前。
   * 所以它不能跟着 beginRun() 一起清掉，单独拿一个字段记。
   */
  private restartPending = false;

  constructor(private readonly ctx: RunProgressWorld) {}

  private send(node: Node, action: ProgressAction): void {
    const [category, what] = split(node);
    this.ctx.measure(category, what, action);
  }

  private start(node: Node): void {
    if (this.open.has(node) || this.done.has(node)) return;
    this.open.add(node);
    this.send(node, "start");
  }

  private close(node: Node, action: "complete" | "fail"): void {
    if (this.done.has(node)) return;
    /*
     * 没 start 过就先补一个。
     *
     * 正常流程里不会发生（fuel|6 的 start 一定在 fuel|5 收口时发出去了），
     * 但**静默丢弃**是更坏的失败方式：后台那张表会少一次尝试，Completed 的
     * 分母跟着少，而这种错在数据上是看不出来的 —— 只会让漏斗悄悄偏乐观。
     * 补一个 start 最多让某次尝试的 start 和 complete 挨在同一毫秒，无害。
     */
    if (!this.open.delete(node)) this.send(node, "start");
    this.done.add(node);
    this.send(node, action);
  }

  /**
   * 新的一局开始。
   *
   * 调用点是 main.ts 的 `enterGame()` —— 玩家**迈第一步**那一刻，不是加载完那一刻。
   * 加载完就报等于把"打开页面看一眼就走"的人算成"开始装第一桶然后放弃了"，
   * 而那批人 SDK 已经在 game/loading 那一行记过一次，重复计数还会让装车漏斗
   * 凭空显得更差。
   *
   * `enterGame` 自带 started 闸，一局只进来一次；软重启把 started 退回 false，
   * 新的一局自动再报一次。所以 softRestart 里**不需要也不应该**再调它，
   * 那里只留 {@link noteRestart}（收口的是上一局结算页开出来的那个节点，
   * 必须赶在新一局 beginRun() 之前）。
   */
  beginRun(): void {
    this.open.clear();
    this.done.clear();
    // 第一桶从开局就算在跑：他一进场就有机会去装，没装成就是漏在这一级。
    this.start("fuel|1");
    this.start(EQUIP_FIRST);
    this.start(MAT_HIDE);
    this.start(MAT_WOOD2);
    this.start(EQUIP_READY);
    this.start(CAMP_FIRE);
    this.start(UI_PACK);
  }

  /**
   * 打开过背包。
   *
   * 幂等，所以调用方不用自己判"是不是刚打开" —— 背包开着的每一帧调都行。
   * 这很重要：背包有**两个入口**（键盘 B/Tab，和 HUD 上那颗键各自挂的监听），
   * 挂在其中一个上会漏掉另一个。调用方改成看状态翻转，覆盖才是全的。
   */
  notePackOpened(): void {
    this.close(UI_PACK, "complete");
  }

  /**
   * 按背包里的存货收口材料节点。
   *
   * 每个事件都跑一次，而不是挂在某几个 pickup 事件上 —— 兽皮是从掉落物捡的、
   * 枯木是从地上捡的、还有别的路径会改背包，逐个去认容易漏。
   * 这几个检查都是读三个整数 + Set 查找，一局几百次事件也无所谓。
   */
  private checkMaterials(): void {
    const sim = this.ctx.simulation;
    const hide = sim.getInventoryCount("hide");
    const wood = sim.getInventoryCount("wood");
    if (hide >= 1) this.close(MAT_HIDE, "complete");
    if (wood >= READY_WOOD) this.close(MAT_WOOD2, "complete");
    // 注意是**同时**齐：兽皮夜里到手、柴白天才捡得到，而柴还随时可能被烧掉。
    // 这个时序错配正是 equip|ready 要量的东西，分开看两个节点会漏掉它。
    if (hide >= READY_HIDE && wood >= READY_WOOD) this.close(EQUIP_READY, "complete");
  }

  /** 玩家在结算页点了重开。 */
  noteRestart(): void {
    if (!this.restartPending) return;
    this.restartPending = false;
    this.open.add(RESTART);
    this.close(RESTART, "complete");
  }

  handle(event: GameEvent): void {
    switch (event.type) {
      case "phase":
        // 第一夜是这个游戏的闸门，单独立一个节点。
        if (event.phase === "night" && event.day === 1) this.start(NIGHT_ONE);
        else if (event.phase === "day" && event.day === 2) this.close(NIGHT_ONE, "complete");
        break;

      case "fuel-loaded": {
        this.close(`fuel|${event.loaded}`, "complete");
        // 装完这一桶，下一桶立刻开始计。装满了就不再往下开。
        if (event.loaded < event.required) this.start(`fuel|${event.loaded + 1}`);
        break;
      }

      case "craft-weapon":
      case "craft-coat":
        this.close(EQUIP_FIRST, "complete");
        break;

      case "feed-fire":
        // 添柴和点火发的是同一个事件（GameSimulation 只有那一处 emit），
        // 而我们要问的是"这一局有没有烧起来过火"，两者都算。
        this.close(CAMP_FIRE, "complete");
        break;

      case "game-over":
        /*
         * 死亡把所有还开着的节点收成 fail —— 死在半路和关页面走人是两回事，
         * 分开之后 Failed 和 Left 两列各自有意义。
         *
         * 复活（revive 事件）不重开这些节点：那一局还是同一局，
         * 只是没死成；节点已经报了 fail，再报一次就违反"只收口一次"。
         * 代价是复活之后剩下的进度不再计入，换来的是口径干净。
         */
        for (const node of [...this.open]) this.close(node, "fail");
        this.restartPending = true;
        this.send(RESTART, "start");
        break;

      case "victory":
        /*
         * 通关时故意**不**把剩下的节点收成 complete —— 比如 night|3 还开着，
         * 他确实没走完那一夜。留着让它落进 Left 才是实话。
         */
        this.restartPending = false;
        break;

      default:
        break;
    }
    this.checkMaterials();
  }
}
