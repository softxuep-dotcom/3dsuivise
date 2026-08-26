import { describe, it, expect, beforeEach } from "vitest";
import { RunProgress } from "../src/platform/RunProgress";
import type { ProgressAction } from "../src/platform/GamePlatform";
import type { GameSimulation } from "../src/game/simulation/GameSimulation";
import type { GameEvent } from "../src/game/simulation/types";

/**
 * 进度节点上报的口径。
 *
 * 这一段在浏览器里验不了 —— 本地不加载 Poki SDK，NullPlatform 的 measure()
 * 是个空函数，而真机上出没出错要等后台那张表填出来才看得见（而它一天才刷一次）。
 * 所以判据只能写成测试。
 *
 * 锁住的是**口径**，不是节点名：谁在什么时候被报、以及那条
 * 「一次尝试只能收口一次」的硬规矩。改节点名不该让这些用例红。
 */
describe("Poki 进度节点上报", () => {
  let calls: string[];
  let progress: RunProgress;

  /** 假背包：材料节点只读 getInventoryCount，别的都用不到。 */
  let bag: Record<string, number>;
  /** 白天节点只在 day 1 的白天收口，所以假 sim 要能表达相位。 */
  let phase: { day: number; phase: "day" | "night"; clockStarted: boolean; elapsed: number };
  const world = {
    get simulation() {
      return {
        getInventoryCount: (k: string) => bag[k] ?? 0,
        get day() { return phase.day; },
        get phase() { return phase.phase; },
        get clockStarted() { return phase.clockStarted; },
        get elapsed() { return phase.elapsed; },
      } as unknown as GameSimulation;
    },
    measure(category: string, what: string, action: ProgressAction) {
      calls.push(`${category}/${what} ${action}`);
    },
  };

  const feed = (...events: GameEvent[]): void => {
    for (const event of events) progress.handle(event);
  };
  const night1 = { type: "phase", phase: "night", day: 1 } as const;
  const dawn2 = { type: "phase", phase: "day", day: 2 } as const;
  const died = { type: "game-over", cause: "killed", condition: "normal", killer: null } as const;

  beforeEach(() => {
    calls = [];
    bag = {};
    phase = { day: 1, phase: "day", clockStarted: false, elapsed: 0 };
    progress = new RunProgress(world);
    progress.beginRun(0);   // 0 = 本次会话的第一局 → r1 前缀
    calls = [];   // 开局那一批 start 各用例自己按需检查，别污染后面的断言
  });

  it("开局把整套节点挂上 —— 没做到才叫漏在这一级", () => {
    calls = [];
    progress.beginRun(0);
    expect(calls).toEqual([
      // 不分局次的：装车漏斗与装备门槛
      "fuel/1 start", "equip/first start",
      "mat/hide start", "mat/wood2 start", "equip/ready start",
      // 分局次的。r1 挂全套
      "r1/t15 start", "r1/pack start", "r1/fuel1 start", "r1/night1 start",
      "r1/fire start", "r1/attack start", "r1/kill start", "r1/wood start",
    ]);
  });

  it("第一个白天的三拍：攻击、击杀、捡柴", () => {
    phase.clockStarted = true;
    feed({ type: "attack" });
    expect(calls).toContain("r1/attack complete");
    feed({ type: "critter-killed", critterId: 1, kind: "beetle" });
    expect(calls).toContain("r1/kill complete");
    feed({ type: "pickup", kind: "wood" });
    expect(calls).toContain("r1/wood complete");
  });

  it("入夜之后再做到就不算 —— 那 40 秒没做到就是没做到", () => {
    // 天黑：还开着的白天节点全部收成 fail
    feed({ type: "phase", phase: "night", day: 1 });
    expect(calls).toContain("r1/attack fail");
    expect(calls).toContain("r1/kill fail");
    calls = [];
    phase.phase = "night";
    feed({ type: "attack" }, { type: "pickup", kind: "wood" });
    expect(calls.some((c) => c.startsWith("r1/attack") || c.startsWith("r1/wood"))).toBe(false);
  });

  /**
   * 「加载完看了一眼就走」是这次改造要捞的那批人。
   *
   * 这个节点跟别的都不一样：start 在 gameInteractive（还没迈第一步），
   * complete 在 beginRun（他动了）。没动就关页面 → 永远不收口 → 落进 Left。
   * 它也不跟着 beginRun 清空，因为它是**整个页面**只有一次的事。
   */
  it("r1/enter：可玩了就 start，迈第一步才 complete", () => {
    const fresh = new RunProgress(world);
    calls = [];
    fresh.noteInteractive();
    expect(calls).toEqual(["r1/enter start"]);
    calls = [];
    fresh.beginRun(0);
    expect(calls[0]).toBe("r1/enter complete");
  });

  it("r1/enter：没迈第一步就关页面 —— 不报 complete，让它落进 Left", () => {
    const fresh = new RunProgress(world);
    calls = [];
    fresh.noteInteractive();
    calls = [];
    // 他就是没动。什么都不该再发出去。
    expect(calls).toEqual([]);
  });

  it("r1/enter 幂等，而且重开不会再报一次 —— 一个页面只有一次", () => {
    const fresh = new RunProgress(world);
    fresh.noteInteractive();
    fresh.noteInteractive();
    fresh.beginRun(0);
    calls = [];
    fresh.beginRun(1);
    expect(calls.some((c) => c.startsWith("r1/enter"))).toBe(false);
  });

  /**
   * 时间阶梯：Progress Events 不记时间，所以"多久离开"只能问成
   * "第 15 秒还活着的人有多少"。见 RunProgress 里 ALIVE_SECONDS 那段。
   */
  it("活过 15 秒收 r1/t15；没到就死了收 fail", () => {
    phase.elapsed = 14.9;
    feed({ type: "attack" });
    expect(calls.some((c) => c.startsWith("r1/t15"))).toBe(false);
    phase.elapsed = 15;
    feed({ type: "attack" });
    expect(calls).toContain("r1/t15 complete");
  });

  it("15 秒之前就死了，r1/t15 收 fail 而不是挂着", () => {
    phase.elapsed = 6;
    feed(died);
    expect(calls).toContain("r1/t15 fail");
  });

  it("拿到兽皮就收口 mat/hide；但只有皮没柴，equip/ready 不收", () => {
    bag = { hide: 1 };
    feed({ type: "attack" });
    expect(calls).toContain("mat/hide complete");
    expect(calls).not.toContain("equip/ready complete");
  });

  it("皮和柴**同时**齐了才收 equip/ready —— 时序错配正是要量的东西", () => {
    bag = { wood: 2 };
    feed({ type: "attack" });
    expect(calls).toContain("mat/wood2 complete");
    expect(calls).not.toContain("equip/ready complete");
    bag = { wood: 2, hide: 1 };
    feed({ type: "attack" });
    expect(calls).toContain("equip/ready complete");
  });

  it("点着火收 camp/fire（添柴和点火是同一个事件，都算）", () => {
    feed({ type: "feed-fire", campId: 0 });
    expect(calls).toContain("r1/fire complete");
  });

  it("打开背包收 ui/pack，而且幂等 —— 开着的每一帧调都不会重复报", () => {
    progress.notePackOpened();
    progress.notePackOpened();
    progress.notePackOpened();
    expect(calls.filter((c) => c === "r1/pack complete")).toHaveLength(1);
  });

  it("活过第一夜收 complete", () => {
    feed(night1, dawn2);
    expect(calls).toContain("r1/night1 complete");
    expect(calls).not.toContain("r1/night1 fail");
  });

  it("死在第一夜：收的是 fail，不是 complete", () => {
    feed(night1, died);
    expect(calls).toContain("r1/night1 fail");
    expect(calls).not.toContain("r1/night1 complete");
  });

  it("死亡把所有还开着的节点一起收成 fail —— 死在半路和关页面走人要分开", () => {
    feed(night1, died);
    // 开局挂上的这两个也没做到，同样算 fail（关页面走人才落进 Left 列）
    expect(calls).toContain("fuel/1 fail");
    expect(calls).toContain("equip/first fail");
  });

  it("装桶是一级一级的漏斗：这一桶 complete，下一桶立刻 start", () => {
    feed({ type: "fuel-loaded", loaded: 1, required: 6 });
    expect(calls).toContain("fuel/1 complete");
    expect(calls).toContain("fuel/2 start");
    feed({ type: "fuel-loaded", loaded: 2, required: 6 });
    expect(calls).toContain("fuel/2 complete");
    expect(calls).toContain("fuel/3 start");
  });

  it("装满之后不再往下开一级", () => {
    // 走完整条漏斗，和真机上的次序一致
    for (let n = 1; n <= 6; n += 1) feed({ type: "fuel-loaded", loaded: n, required: 6 });
    expect(calls).toContain("fuel/6 complete");
    expect(calls.some((c) => c.startsWith("fuel/7"))).toBe(false);
  });

  it("万一收到一个没 start 过的节点的 complete，补一个 start 而不是丢掉", () => {
    // 静默丢弃会让后台的分母少一次尝试，而那种偏差在数据上看不出来
    feed({ type: "fuel-loaded", loaded: 3, required: 6 });
    expect(calls).toContain("fuel/3 start");
    expect(calls).toContain("fuel/3 complete");
    expect(calls.indexOf("fuel/3 start")).toBeLessThan(calls.indexOf("fuel/3 complete"));
  });

  it("同一个节点只收口一次 —— complete 之后再死也不补 fail", () => {
    feed(night1, dawn2, died);
    expect(calls.filter((c) => c.startsWith("r1/night1 ")).filter((c) => !c.endsWith("start")))
      .toEqual(["r1/night1 complete"]);
  });

  it("造出第一件装备就收口，之后再升级也不重复报", () => {
    feed({ type: "craft-weapon" }, { type: "craft-coat" }, { type: "craft-weapon" });
    expect(calls.filter((c) => c === "equip/first complete")).toHaveLength(1);
  });

  it("死了会开一个「要不要再来」的节点；按了重开就 complete", () => {
    feed(died);
    expect(calls).toContain("run/restart start");
    calls = [];
    progress.noteRestart();
    expect(calls).toEqual(["run/restart complete"]);
  });

  it("死了不按重开、直接关页面 —— 不报 complete，让它落进 Left", () => {
    feed(died);
    calls = [];
    progress.beginRun(0);   // 假设他没点重开（真机上这一步根本不会发生）
    expect(calls.some((c) => c.startsWith("run/restart"))).toBe(false);
  });

  it("noteRestart 必须排在 beginRun 之前，否则上一局的重开收不了口", () => {
    feed(died);
    calls = [];
    progress.noteRestart();
    progress.beginRun(0);
    // 锁的是**次序**不是节点清单：上一局的收口必须排在新一局的任何 start 之前。
    // 加新节点不该让这条红。
    expect(calls[0]).toBe("run/restart complete");
    expect(calls.slice(1).every((c) => c.endsWith(" start"))).toBe(true);
  });

  it("看广告续命也算「他回来了」，收 complete 而不是挂着落进 Left", () => {
    feed(died);
    expect(calls).toContain("run/restart start");
    calls = [];
    feed({ type: "revive" });
    expect(calls).toEqual(["run/restart complete"]);
  });

  /**
   * 这条锁的是**修一半会漏掉的那一半**。
   *
   * 只在 switch 里加一句 close(RESTART, "complete") 是不够的：那会把 RESTART 记进
   * done，于是同一局里第二次死亡发出去的 start 再也收不了口，静默落进 Left ——
   * 表面上"续命的 bug 修好了"，实际上换了个地方继续漏。
   *
   * 所以 RESTART 整个不走 open/done 那套记账，只由 restartPending 一个字段管。
   */
  it("续命之后再死一次，第二个「要不要再来」照样能收口", () => {
    feed(died);
    feed({ type: "revive" });
    calls = [];
    feed(died);
    expect(calls).toContain("run/restart start");
    calls = [];
    progress.noteRestart();
    expect(calls).toEqual(["run/restart complete"]);
  });

  it("续命之后一路通关：不该再冒出任何「要不要再来」的报告", () => {
    feed(died);
    feed({ type: "revive" });
    calls = [];
    feed({ type: "victory" });
    progress.noteRestart();
    expect(calls.some((c) => c.startsWith("run/restart"))).toBe(false);
  });

  it("没死过就收到 revive（不该发生）不发任何东西 —— 幂等，不凭空造一次 complete", () => {
    feed({ type: "revive" });
    expect(calls.some((c) => c.startsWith("run/restart"))).toBe(false);
  });

  /**
   * 重开局只报四个。这是整套改造的目的：**别把重开的人算进第一局**。
   *
   * 混着看的话，"第一次玩的人"和"已经死过三次、知道该干嘛的人"落在同一行里，
   * 而重开的人越多，第一局的数字看起来越好 —— 首次印象永远读不到。
   */
  it("重开局只挂四个对照节点，前缀是 rr", () => {
    calls = [];
    progress.beginRun(1);
    expect(calls).toEqual([
      "fuel/1 start", "equip/first start",
      "mat/hide start", "mat/wood2 start", "equip/ready start",
      "rr/t15 start", "rr/pack start", "rr/fuel1 start", "rr/night1 start",
    ]);
  });

  it("重开局里按攻击键不会凭空造出一个 rr/attack", () => {
    progress.beginRun(1);
    phase.clockStarted = true;
    calls = [];
    feed({ type: "attack" }, { type: "critter-killed", critterId: 1, kind: "beetle" });
    // close() 有一条"没 start 过就补一个"的兜底，那是给 fuel 链用的。
    // 局次节点必须走 closeRun 的守卫，否则这里会无中生有两个节点。
    expect(calls.some((c) => c.startsWith("rr/attack") || c.startsWith("rr/kill"))).toBe(false);
  });

  it("前缀整局固定：beginRun 定完之后，同一节点的 start 和 complete 落在同一行", () => {
    progress.beginRun(1);
    calls = [];
    feed({ type: "fuel-loaded", loaded: 1, required: 6 });
    expect(calls).toContain("rr/fuel1 complete");
    expect(calls.some((c) => c.startsWith("r1/"))).toBe(false);
  });

  it("首局装上第一桶：聚合的 fuel/1 和局次的 r1/fuel1 各收各的", () => {
    feed({ type: "fuel-loaded", loaded: 1, required: 6 });
    expect(calls).toContain("fuel/1 complete");
    expect(calls).toContain("r1/fuel1 complete");
    // 聚合漏斗继续往下开一级；局次口径只问"有没有摸到"，不往下开。
    expect(calls).toContain("fuel/2 start");
    expect(calls.some((c) => c.startsWith("r1/fuel2"))).toBe(false);
  });

  it("通关之后不给「要不要再来」收口 —— 那一局他是赢了走的，不是死了走的", () => {
    feed({ type: "victory" });
    calls = [];
    progress.noteRestart();
    expect(calls).toEqual([]);
  });
});
