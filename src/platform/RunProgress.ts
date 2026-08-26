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

/*
 * 第一个白天的四拍。
 *
 * 731 局实测：645 局开跑，只有 412 局撑到入夜 —— **36% 在第一个白天就结束了**。
 * 而第一个白天只有 **40 秒**（FIRST_DAY_DURATION），我们对这 40 秒内部零分辨率：
 * 漏斗里最靠前的节点是 fuel|1，它整局挂着，说不出人卡在哪一拍。
 *
 * 这四个把那 40 秒拆开，都是现成事件，纯观测不改行为：
 *
 *   day1|move    迈第一步     —— 分开"根本没进游戏"和"进了但走了"
 *   day1|attack  按过攻击键   —— 知不知道有攻击这回事
 *   day1|kill    打死过东西   —— 按了，但打得中吗
 *   day1|wood    捡到第一根柴 —— 唯一的燃料，也是 sword-1 缺的那两根
 *
 * 全部在**第一个白天之内**收口：入夜之后再做到就不算了（见 handle 里的相位判断），
 * 否则它们会退化成"整局有没有做过"，失去"这 40 秒够不够用"的意义。
 */
const DAY1_MOVE: Node = "day1|move";
const DAY1_ATTACK: Node = "day1|attack";
const DAY1_KILL: Node = "day1|kill";
const DAY1_WOOD: Node = "day1|wood";
const DAY1_NODES = [DAY1_MOVE, DAY1_ATTACK, DAY1_KILL, DAY1_WOOD] as const;

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
   * complete 在玩家回来继续玩的那一刻（点重开，或者看广告续命）。
   * 所以它不能跟着 beginRun() 一起清掉，单独拿一个字段记。
   *
   * 这个字段**本身就是它的"开着没有"** —— 见 {@link closeRestart}，
   * 那里解释了为什么它不能走 open/done 那套记账。
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
    for (const node of DAY1_NODES) this.start(node);
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
  /**
   * 收口一个白天节点。只在**第一个白天之内**算数 —— 入夜之后再做到就不收，
   * 让它落进 fail（那正是"这 40 秒没做到"）。
   */
  private closeDay1(node: Node): void {
    const sim = this.ctx.simulation;
    if (sim.day !== 1 || sim.phase !== "day") return;
    this.close(node, "complete");
  }

  /**
   * 玩家迈出了第一步。
   *
   * 用 clockStarted 而不是"有没有位移"：世界时钟就是被第一次真实移动打开的
   * （见 GameSimulation.noteActivity），语义正好是"他真的开始玩了"。
   * 每个事件查一次，幂等。
   */
  private checkStarted(): void {
    if (this.ctx.simulation.clockStarted) this.closeDay1(DAY1_MOVE);
  }

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

  /**
   * 收口「死了之后要不要再来」。
   *
   * ## 为什么它不走 open/done 那套记账
   *
   * 那套的规矩是"一局之内只收口一次"，而这一节点跟它对不上：它**跨局**，
   * 而且一局之内可能开合好几次 —— 死 → 看广告续命 → 又死 → 点重开。
   *
   * 之前它是半走半不走的（start 直接 send、收口时手动 open.add），
   * 于是续命一旦收口就把 RESTART 记进了 done，同一局里第二次死亡发出去的 start
   * 就再也收不了口，静默落进 Left。这种错在表上看不出来，只会让 Left 慢慢变胖。
   *
   * 现在整个节点只由 restartPending 一个字段管：为真就是开着，收口就置假。
   */
  private closeRestart(): void {
    if (!this.restartPending) return;
    this.restartPending = false;
    this.send(RESTART, "complete");
  }

  /** 玩家在结算页点了重开。 */
  noteRestart(): void {
    this.closeRestart();
  }

  handle(event: GameEvent): void {
    switch (event.type) {
      case "phase":
        // 第一夜是这个游戏的闸门，单独立一个节点。
        if (event.phase === "night" && event.day === 1) {
          this.start(NIGHT_ONE);
          // 白天那四拍到此为止：还开着的就是"这 40 秒没做到"，收成 fail。
          for (const node of DAY1_NODES) this.close(node, "fail");
        }
        else if (event.phase === "day" && event.day === 2) this.close(NIGHT_ONE, "complete");
        break;

      case "pickup":
        if (event.kind === "wood") this.closeDay1(DAY1_WOOD);
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

      case "attack":
        this.closeDay1(DAY1_ATTACK);
        break;

      case "critter-killed":
      case "wolf-killed":
        this.closeDay1(DAY1_KILL);
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

      case "revive":
        /*
         * 看广告续命 —— 他回来继续玩了，「要不要再来」这一节点收成 complete。
         *
         * 不修的后果是这一行同时被两种噪声污染：续命的人永远不收口、落进 Left
         * （而 Left 的语义是"关页面走了"，他明明还在玩）；而且续命之后再死一次，
         * 会发出第二个 start，最多只可能有一次 complete。
         *
         * 收 complete 不收 fail：这一节点问的是"他回来继续玩了吗"，
         * 续命的回答就是"是"，只不过花的是一支广告而不是一次重开。
         * 收成 fail 会把"续命成功"记成"失败"，那才是真的读不懂。
         *
         * 注意别去动 open 里那些已经在 game-over 时收成 fail 的节点 ——
         * 那一局还是同一局，只是没死成；节点已经报过结局，再报一次就违反"只收口一次"。
         */
        this.closeRestart();
        break;

      case "victory":
        /*
         * 通关时故意**不**把剩下的节点收成 complete —— 比如 night|3 还开着，
         * 他确实没走完那一夜。留着让它落进 Left 才是实话。
         *
         * restartPending 置假是兜底：接上 revive 之后，"死过但没收口"到通关
         * 这条路已经走不通了（要么重开、要么续命，两条都会收口）。
         */
        this.restartPending = false;
        break;

      default:
        break;
    }
    this.checkStarted();
    this.checkMaterials();
  }
}
