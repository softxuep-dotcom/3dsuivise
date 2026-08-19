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

  it("白送一桶 + 需求 +1，猥琐路线的余量仍然是 1", () => {
    const reachableWithoutDen = world.barrels.filter((b) => !b.guarded).length;
    expect(reachableWithoutDen - FUEL_REQUIRED).toBe(1);
  });

  it("落在可走的平地上，而且不在装车判定圈里", () => {
    expect(isTerrainWalkable(world, barrel)).toBe(true);
    // 0.78 是 TerrainModel 的可走坡度上限。
    expect(terrainSlopeAt(world, barrel)).toBeLessThan(0.78);
    // TRUCK_LOAD_REACH = 4.5：贴着车放等于把"扛"这一步教没了。
    expect(Math.hypot(barrel.x - world.truck.x, barrel.z - world.truck.z)).toBeGreaterThan(4.5);
  });

  it("开局能扛起来、装上车，而且远早于第一个白天结束（40 秒）", () => {
    const sim = new GameSimulation(createWorld());
    sim.start();
    const target = sim.world.barrels[sim.world.barrels.length - 1];
    const STEP = 1 / 20;
    let loadedAt = -1;

    for (let step = 0; step < 20 * 40 && loadedAt < 0; step += 1) {
      const aim = sim.player.carrying ? sim.truck : target;
      const dx = aim.x - sim.player.x;
      const dz = aim.z - sim.player.z;
      const dist = Math.hypot(dx, dz);
      sim.update(STEP, dist > 1.6 ? { x: dx / dist, z: dz / dist } : { x: 0, z: 0 });
      // 拾取半径 2.6、装车半径 4.5，机器人都留一点余量。
      if (!sim.player.carrying && dist <= 2.4) sim.requestInteraction();
      else if (sim.player.carrying && dist <= 4.2) sim.requestInteraction();
      if (sim.truck.loaded > 0) loadedAt = step * STEP;
    }

    expect(loadedAt).toBeGreaterThan(0);
    expect(loadedAt).toBeLessThan(20);
  });
});
