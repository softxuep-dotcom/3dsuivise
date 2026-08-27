import { describe, it, expect } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import { isTerrainWalkable, terrainSlopeAt } from "../src/game/terrain/TerrainModel";
import { FUEL_REQUIRED } from "../src/game/simulation/types";

/**
 * 出生点那桶教学桶。
 *
 * 它和 FUEL_REQUIRED 是**一笔账的两半**：白送一桶、需求同时 +1，实际要跑的趟数
 * 一趟没变。这条测试锁住的就是那个等式 —— 只加桶不加需求（或者反过来）都会
 * 悄悄改掉难度，而两处改动隔着两个文件，评审时很容易只看见一半。
 *
 * 桶的坐标是算出来的（出生点朝卡车偏 0.95 弧度、8.5 米），地形一改就可能落到
 * 崖壁上或者车里 —— 那时游戏照样跑，只是开场第一件事做不成，而这正是最难发现的坏法。
 */
describe("教学桶", () => {
  const world = createWorld();
  const barrel = world.barrels[world.barrels.length - 1];

  /*
   * 全图 10 桶：7 桶散在外面、3 桶压在狗巢里。余量 = 7 − FUEL_REQUIRED。
   *
   * 6 → 4 之前余量是 **1**：不进狗巢也能通关，但一桶都不能浪费，摸错一趟就得去掀巢。
   * 现在是 **3**。这不是顺手改的数字，是 6 → 4 明知要付的代价 ——
   * 狗巢从"迟早要去的地方"变成纯粹可选的高风险高回报，那三桶多数人不会再见到。
   *
   * 想把张力要回来，得把两桶散桶标成 guarded（余量回到 1），而不是回调 FUEL_REQUIRED；
   * 那是世界布局的事，不在这次改动里。这条断言的作用是：**下次谁动了这个平衡，必须先看见这段话。**
   */
  it("白送一桶 + 需求 +1，猥琐路线的余量是 3", () => {
    const reachableWithoutDen = world.barrels.filter((b) => !b.guarded).length;
    expect(reachableWithoutDen).toBe(7);
    expect(reachableWithoutDen - FUEL_REQUIRED).toBe(3);
  });

  it("落在可走的平地上，而且不在装车判定圈里", () => {
    expect(isTerrainWalkable(world, barrel)).toBe(true);
    // 0.78 是 TerrainModel 的可走坡度上限。
    expect(terrainSlopeAt(world, barrel)).toBeLessThan(0.78);
    // TRUCK_LOAD_REACH = 5.5：贴着车放等于把"扛"这一步教没了。
    expect(Math.hypot(barrel.x - world.truck.x, barrel.z - world.truck.z)).toBeGreaterThan(5.5);
  });

  it("扛到离车心 5.25 米即可装车", () => {
    const sim = new GameSimulation(createWorld());
    sim.start();
    const barrel = sim.world.barrels[sim.world.barrels.length - 1];
    sim.player.x = barrel.x;
    sim.player.z = barrel.z;
    sim.requestInteraction();
    sim.drainEvents();

    sim.player.x = sim.truck.x + 5.25;
    sim.player.z = sim.truck.z;
    sim.requestInteraction();

    expect(sim.truck.loaded).toBe(1);
    expect(sim.drainEvents()).toContainEqual({ type: "fuel-loaded", loaded: 1, required: FUEL_REQUIRED });
  });

  it("开局能扛起来、装上车，而且远早于第一个白天结束（50 秒）", () => {
    const sim = new GameSimulation(createWorld());
    sim.start();
    const target = sim.world.barrels[sim.world.barrels.length - 1];
    const STEP = 1 / 20;
    let loadedAt = -1;
    let loadEvent: { type: "fuel-loaded"; loaded: number; required: number } | undefined;

    for (let step = 0; step < 20 * 50 && loadedAt < 0; step += 1) {
      const aim = sim.player.carrying ? sim.truck : target;
      const dx = aim.x - sim.player.x;
      const dz = aim.z - sim.player.z;
      const dist = Math.hypot(dx, dz);
      sim.update(STEP, dist > 1.6 ? { x: dx / dist, z: dz / dist } : { x: 0, z: 0 });
      // 拾取半径 2.6、装车半径 5.5，机器人都留一点余量。
      if (!sim.player.carrying && dist <= 2.4) sim.requestInteraction();
      else if (sim.player.carrying && dist <= 5.2) sim.requestInteraction();
      loadEvent = sim.drainEvents().find((event) => event.type === "fuel-loaded") as typeof loadEvent;
      if (sim.truck.loaded > 0) loadedAt = step * STEP;
    }

    expect(loadedAt).toBeGreaterThan(0);
    expect(loadedAt).toBeLessThan(20);
    expect(loadEvent).toEqual({ type: "fuel-loaded", loaded: 1, required: FUEL_REQUIRED });
    expect(sim.barrels[sim.barrels.length - 1].placement).toBe("loaded");
    expect(sim.player.carrying).toBeNull();
  });
});
