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
  const world = {
    get simulation() {
      return { getInventoryCount: (k: string) => bag[k] ?? 0 } as unknown as GameSimulation;
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
    progress = new RunProgress(world);
    progress.beginRun();
    calls = [];   // 开局那一批 start 各用例自己按需检查，别污染后面的断言
  });

  it("开局把整套节点挂上 —— 没做到才叫漏在这一级", () => {
    calls = [];
    progress.beginRun();
    expect(calls).toEqual([
      "fuel/1 start", "equip/first start",
      "mat/hide start", "mat/wood2 start", "equip/ready start",
      "camp/fire start", "ui/pack start",
    ]);
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
    expect(calls).toContain("camp/fire complete");
  });

  it("打开背包收 ui/pack，而且幂等 —— 开着的每一帧调都不会重复报", () => {
    progress.notePackOpened();
    progress.notePackOpened();
    progress.notePackOpened();
    expect(calls.filter((c) => c === "ui/pack complete")).toHaveLength(1);
  });

  it("活过第一夜：start 之后收 complete", () => {
    feed(night1, dawn2);
    expect(calls).toContain("night/1 start");
    expect(calls).toContain("night/1 complete");
    expect(calls).not.toContain("night/1 fail");
  });

  it("死在第一夜：收的是 fail，不是 complete", () => {
    feed(night1, died);
    expect(calls).toContain("night/1 start");
    expect(calls).toContain("night/1 fail");
    expect(calls).not.toContain("night/1 complete");
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
    expect(calls.filter((c) => c.startsWith("night/1 ")).filter((c) => !c.endsWith("start")))
      .toEqual(["night/1 complete"]);
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
    progress.beginRun();   // 假设他没点重开（真机上这一步根本不会发生）
    expect(calls.some((c) => c.startsWith("run/restart"))).toBe(false);
  });

  it("noteRestart 必须排在 beginRun 之前，否则上一局的重开收不了口", () => {
    feed(died);
    calls = [];
    progress.noteRestart();
    progress.beginRun();
    // 锁的是**次序**不是节点清单：上一局的收口必须排在新一局的任何 start 之前。
    // 加新节点不该让这条红。
    expect(calls[0]).toBe("run/restart complete");
    expect(calls.slice(1).every((c) => c.endsWith(" start"))).toBe(true);
  });

  it("通关之后不给「要不要再来」收口 —— 那一局他是赢了走的，不是死了走的", () => {
    feed({ type: "victory" });
    calls = [];
    progress.noteRestart();
    expect(calls).toEqual([]);
  });
});
