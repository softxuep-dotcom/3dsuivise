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

const EQUIP_FIRST: Node = "equip|first";
const RESTART: Node = "run|restart";

/**
 * 加载完、可以玩了，但还没迈第一步。
 *
 * 这是全仓**唯一**一个在"迈第一步"之前就报的节点，故意的。别的节点一律等
 * enterGame()，因为加载完就报会把"打开页面看一眼就走"的人算进玩法漏斗里
 * （见 beginRun 的注释）。而这一个存在的理由**正是**要把那批人捞出来：
 *
 *   Completed  他动了，进游戏了
 *   Left       加载完、看了一眼、没动就走
 *
 * 现在这批人除了 SDK 自己报的 game/loading，一行记录都没有。
 *
 * 它也不走 open/done 那套记账 —— 那套按局清空，而这个节点是**整个页面**
 * 只有一次（软重启不刷页，enterInteractive 不会再来）。enterPending 就是它的开关。
 */
const ENTER: Node = "r1|enter";

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
 *
 * equip|ready 和 equip|first 是**成对读**的：
 *   ready 低              → 材料就没凑齐，该降造价或改掉落
 *   ready 高而 first 低   → 凑齐了却没造，那是认知问题
 * 这两种要用完全不同的办法修，混在一起就什么都读不出来。
 *
 * 这三个**不分局次**：它们问的是"这个游戏的装备门槛合不合理"，
 * 那本来就该把所有局次加起来看。
 */
const MAT_HIDE: Node = "mat|hide";
const MAT_WOOD2: Node = "mat|wood2";
const EQUIP_READY: Node = "equip|ready";

/*
 * ## 局次节点：第一局和重开局分开算
 *
 * 下面这些**不是完整的节点名，只是 what**。真正的名字在运行时拼上局次前缀：
 *
 *     r1|pack   本次会话的第一局
 *     rr|pack   重开局（第二局及以后）
 *
 * 为什么要分：这张表原先把所有局次混在一起，于是"第一次玩的人"和"已经死过
 * 三次、知道该干嘛的人"落在同一行里。而我们最想知道的恰恰是**首次印象** ——
 * 混着看等于永远读不到它，而且重开的人越多，第一局的数字看起来越好。
 *
 * 为什么只分两档而不是 r1/r2/rN：真正的断点在"他死过一次没有"，
 * 第二局和第三局的差别远小于此；三档要等样本量够才读得出，两档立刻可用。
 *
 * 第一局报**全套**（首次印象是要问的东西），重开局只报 {@link RESTART_NODES}
 * 那四个当对照 —— 够回答"重开之后是在学习，还是在重复撞同一堵墙"。
 */
const PACK = "pack";
const FIRE = "fire";
const FUEL_ONE = "fuel1";
const NIGHT_ONE = "night1";
const ATTACK = "attack";
const KILL = "kill";
const WOOD = "wood";

/**
 * 时间阶梯：第 15 秒还活着的人有多少。
 *
 * Progress Events **不记时间**，只会数 Started / Completed / Failed / Left。
 * 所以"多久离开"必须换个问法：在第 N 秒还活着的人有多少。开局 start，
 * elapsed 越过就 complete。于是三种结局天然分开 ——
 * Completed 活过了、Failed 之前死了、**Left 之前关页面走了**。
 *
 * 为什么是 15 秒，而且只有这一个刻度：
 *
 * 15 秒是一遍教学循环的长度（脚边就有桶、有猎物、有柴，够走完"看见 → 拿起 → 用掉"）。
 * 而 0 到 40 秒这一段原本是全黑的，那正是最大的一次流失：731 局里 645 局开跑、
 * 只有 412 局撑到入夜，**36% 死在这 40 秒内**。行为节点只能说"他什么都没做就走了"，
 * 分不出第 8 秒走的和第 38 秒走的 —— 而这两种要用完全不同的办法修：
 * 8 秒是游戏还没来得及开口，38 秒是他听懂了然后放弃了。
 *
 * 夜里不再加刻度：night1 已经把 40→190 兜住，而"他为什么没撑住"这个问题
 * fire（点没点着火，夜里唯一的回温手段）答得比时间戳好得多。
 */
const ALIVE_SECONDS = 15;

/** 重开局只报这四个。加一个都要想清楚它换来什么。 */
const RESTART_NODES = [PACK, FUEL_ONE, NIGHT_ONE] as const;

/**
 * 只在第一个白天之内算数的三拍。
 *
 * 第一个白天只有 40 秒（FIRST_DAY_DURATION），我们对这 40 秒内部零分辨率。
 * 这三个把它拆开，都是现成事件，纯观测不改行为：
 *
 *   attack  按过攻击键   —— 知不知道有攻击这回事
 *   kill    打死过东西   —— 按了，但打得中吗
 *   wood    捡到第一根柴 —— 唯一的燃料，也是 sword-1 缺的那两根
 *
 * 入夜之后再做到就不算（见 closeDay1），否则它们会退化成"整局有没有做过"，
 * 失去"这 40 秒够不够用"的意义。
 *
 * 原先还有一拍 day1|move（迈第一步）。它被 {@link ENTER} 取代了 ——
 * 收口条件是同一件事，而 ENTER 的 start 更早，信息严格更多。
 */
const DAY1_NODES = [ATTACK, KILL, WOOD] as const;

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
  /** {@link ENTER} 的"开着没有"。同 restartPending，不走 open/done。 */
  private enterPending = false;
  /**
   * 这一局的局次前缀，`r1` 或 `rr`。**由 beginRun 定一次，整局不再变。**
   *
   * 不要在 send() 里现算：万一中途变了，同一个节点的 start 和 complete 会落到
   * 两行上，两行都变成永远收不了口 —— 而这种错在后台表上看不出来，
   * 只会让 Left 两边一起变胖。
   */
  private prefix: "r1" | "rr" = "r1";

  constructor(private readonly ctx: RunProgressWorld) {}

  /** 局次节点的完整名字。前缀整局固定，所以这里现拼是安全的。 */
  private runNode(what: string): Node {
    return `${this.prefix}|${what}`;
  }

  /**
   * 收口一个局次节点。**这一局没挂这个节点就直接跳过。**
   *
   * 重开局只报四个（见 RESTART_NODES），所以重开局里按攻击键时，
   * 不能让 close() 那条"没 start 过就补一个"的兜底凭空造出一个 rr|attack ——
   * 那条兜底是给 fuel 链用的，在这里会无中生有。
   */
  private closeRun(what: string, action: "complete" | "fail"): void {
    const node = this.runNode(what);
    if (!this.open.has(node) && !this.done.has(node)) return;
    this.close(node, action);
  }

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
  beginRun(restartsThisSession: number): void {
    // 上一局的"看了一眼就走"节点在这里收口：他动了，所以他没走。
    // 必须排在 open/done 清空之前 —— 不过 ENTER 本来就不走那套，这里只是次序上顺手。
    this.closeEnter();
    this.open.clear();
    this.done.clear();
    this.prefix = restartsThisSession === 0 ? "r1" : "rr";

    // 不分局次的：装车漏斗与装备门槛，问的都是整个游戏的事。
    // 第一桶从开局就算在跑：他一进场就有机会去装，没装成就是漏在这一级。
    this.start("fuel|1");
    this.start(EQUIP_FIRST);
    this.start(MAT_HIDE);
    this.start(MAT_WOOD2);
    this.start(EQUIP_READY);

    // 分局次的。重开局只挂四个当对照，第一局挂全套。
    this.start(this.runNode(`t${ALIVE_SECONDS}`));
    for (const what of RESTART_NODES) this.start(this.runNode(what));
    if (this.prefix === "r1") {
      this.start(this.runNode(FIRE));
      for (const what of DAY1_NODES) this.start(this.runNode(what));
    }
  }

  /**
   * 页面加载完、可以玩了。**调用点是 main.ts 的 gameInteractive()**，
   * 比别的节点都早 —— 理由见 {@link ENTER}。
   *
   * 幂等：一次页面生命周期只报一次，软重启不会再来。
   */
  noteInteractive(): void {
    if (this.enterPending) return;
    this.enterPending = true;
    this.send(ENTER, "start");
  }

  private closeEnter(): void {
    if (!this.enterPending) return;
    this.enterPending = false;
    this.send(ENTER, "complete");
  }


  /**
   * 打开过背包。
   *
   * 幂等，所以调用方不用自己判"是不是刚打开" —— 背包开着的每一帧调都行。
   * 这很重要：背包有**两个入口**（键盘 B/Tab，和 HUD 上那颗键各自挂的监听），
   * 挂在其中一个上会漏掉另一个。调用方改成看状态翻转，覆盖才是全的。
   */
  notePackOpened(): void {
    this.closeRun(PACK, "complete");
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
  private closeDay1(what: string): void {
    const sim = this.ctx.simulation;
    if (sim.day !== 1 || sim.phase !== "day") return;
    this.closeRun(what, "complete");
  }

  /**
   * 活到第 15 秒了没有。
   *
   * 挂在每个事件之后统一查，**不要挂在某个特定事件上**：elapsed 是连续量，
   * 而事件是稀疏的，挂错地方会让刻度晚收口好几秒 —— 而这个节点量的就是秒。
   */
  private checkAlive(): void {
    if (this.ctx.simulation.elapsed >= ALIVE_SECONDS) {
      this.closeRun(`t${ALIVE_SECONDS}`, "complete");
    }
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
          // night1 在 beginRun 就挂上了（重开局也有），这里不再 start。
          // 白天那三拍到此为止：还开着的就是"这 40 秒没做到"，收成 fail。
          for (const what of DAY1_NODES) this.closeRun(what, "fail");
        }
        else if (event.phase === "day" && event.day === 2) this.closeRun(NIGHT_ONE, "complete");
        break;

      case "pickup":
        if (event.kind === "wood") this.closeDay1(WOOD);
        break;

      case "fuel-loaded": {
        this.close(`fuel|${event.loaded}`, "complete");
        // 局次口径的"首局有没有摸到通关循环"，和上面那条聚合漏斗各问各的。
        if (event.loaded === 1) this.closeRun(FUEL_ONE, "complete");
        // 装完这一桶，下一桶立刻开始计。装满了就不再往下开。
        if (event.loaded < event.required) this.start(`fuel|${event.loaded + 1}`);
        break;
      }

      case "craft-weapon":
      case "craft-coat":
        this.close(EQUIP_FIRST, "complete");
        break;

      case "attack":
        this.closeDay1(ATTACK);
        break;

      case "critter-killed":
      case "wolf-killed":
        this.closeDay1(KILL);
        break;

      case "feed-fire":
        // 添柴和点火发的是同一个事件（GameSimulation 只有那一处 emit），
        // 而我们要问的是"这一局有没有烧起来过火"，两者都算。
        this.closeRun(FIRE, "complete");
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
    this.checkAlive();
    this.checkMaterials();
  }
}
