import { describe, expect, it } from "vitest";
import { createWorld, pickStartCamp } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";

const d = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z);

/*
 * 出生营地轮换的三条约束。它们互相咬着，少一条软重启就会悄悄坏掉。
 */
describe("出生营地轮换", () => {
  /**
   * 首局必须是蓝图那座。
   *
   * 整条开场节奏（40 秒白天、46 秒第一次挨咬、最近野外桶 32 米）都是照它调的，
   * 而平台判定最看重的就是这前三分钟 —— 换图只能发生在玩家已经点了"再来一局"之后。
   */
  it("首局落在蓝图指定的营地，之后才轮换", () => {
    const first = pickStartCamp(0);
    expect(createWorld().startCampId).toBe(first);
    const rotated = [1, 2, 3, 4].map((run) => pickStartCamp(run));
    expect(rotated).not.toContain(first);
    expect(new Set(rotated).size).toBe(4);
    // 第 5 局绕回去，不是越界成 undefined。
    expect(pickStartCamp(5)).toBe(rotated[0]);
  });

  /**
   * **这条是软重启的地基。**
   *
   * GameRenderer.resetRun 只换 world/simulation 引用，不重建地形、树、仙人掌、
   * 矿脉、井、地标 —— 它赌的就是这些东西在各营地之间完全相同（见 createWorld 里
   * BARREL_STREAM_DRAWS 那段）。这条断言一旦挂掉，重开之后画面上的树和寻路用的树
   * 就不是同一批，而且不会报错，只会"看着能走的地方走不过去"。
   */
  it("换营地不动散落物 —— 只有卡车、油桶和出生营地脚边那几根柴会变", () => {
    const base = createWorld(undefined, pickStartCamp(0));
    const j = (v: unknown): string => JSON.stringify(v);
    for (const run of [1, 2, 3, 4]) {
      const camp = pickStartCamp(run);
      const other = createWorld(undefined, camp);
      const where = `营地 #${camp}`;
      for (const key of ["terrain", "camps", "dens", "trees", "initialCacti", "ironNodes", "wells", "landmarks"] as const) {
        expect(j(other[key]), `${where} 的 ${key} 变了 —— resetRun 不重建它`).toBe(j(base[key]));
      }
      // 该变的确实变了，否则说明营地压根没换。
      expect(j(other.truck), `${where} 的卡车没跟着挪`).not.toBe(j(base.truck));
      expect(other.startCampId).toBe(camp);
    }
  });

  /**
   * 每座营地都要能跑完开场那十秒：脚边看得见一桶油，野外那桶在白天搬得回来。
   * 32 米是原图调出来的单趟 12 秒；上限放到 45 米，再远 40 秒的白天就塞不下一趟。
   */
  it("五座营地的开场距离都在可玩范围内", () => {
    for (const run of [0, 1, 2, 3, 4]) {
      const camp = pickStartCamp(run);
      const world = createWorld(undefined, camp);
      const spawn = new GameSimulation(world).player;
      const sorted = world.barrels.map((b) => d(spawn, b)).sort((a, b) => a - b);
      const where = `营地 #${camp}`;
      expect(sorted[0], `${where} 开场那一帧里看不到油桶`).toBeLessThan(12);
      expect(sorted[1], `${where} 最近的野外桶太远，白天搬不回来`).toBeLessThan(45);
      expect(d(spawn, world.truck), `${where} 的卡车离出生点太远`).toBeLessThan(20);
    }
  });

  it("投石成为战斗动作后，五张出生轮换都保有足够石头和柴", () => {
    for (const run of [0, 1, 2, 3, 4]) {
      const camp = pickStartCamp(run);
      const items = createWorld(undefined, camp).initialItems;
      const stones = items.filter((item) => item.kind === "stone").length;
      const wood = items.filter((item) => item.kind === "wood").length;
      expect(stones, `营地 #${camp} 的投石供给不足`).toBeGreaterThanOrEqual(45);
      expect(wood, `营地 #${camp} 的生火资源被换得太少`).toBeGreaterThanOrEqual(40);
    }
  });
});
