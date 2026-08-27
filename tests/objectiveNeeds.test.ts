import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";

const build = (): GameSimulation => {
  const simulation = new GameSimulation(createWorld());
  simulation.start();
  (simulation as unknown as { clockStarted: boolean }).clockStarted = true;
  return simulation;
};

describe("致命需求提示", () => {
  it("水分和饥饿同时见底时显示联合背包提示", () => {
    const simulation = build();
    simulation.player.water = 17;
    simulation.player.hunger = 17;

    expect(simulation.getObjective()).toEqual({ key: "sim.needsCritical" });
  });

  it("只有饥饿见底时显示吃肉提示", () => {
    const simulation = build();
    simulation.player.water = 40;
    simulation.player.hunger = 17;

    expect(simulation.getObjective()).toEqual({ key: "sim.10" });
  });

  it("只有水分见底时仍显示找水提示", () => {
    const simulation = build();
    simulation.player.water = 17;
    simulation.player.hunger = 40;

    expect(simulation.getObjective()).toEqual({ key: "sim.9" });
  });
});


/**
 * 第 0 阶「捡起身边的枯木」。
 *
 * 它曾经在**每一局里都显示不出来**：判据写的是 `getInventoryCount("wood") > 0`，
 * 而开局口粮里就带着柴，于是 objectiveStage 在第一帧就从 0 跳到 1。
 * 后果不只是少一句提示 —— stage 1 说的是「走到篝火旁，按互动键添柴」，
 * 而一个包里没柴的人照着做，按下互动键什么也不会发生。**错的建议比没有建议更贵。**
 *
 * 1.1.31 实测第一个白天捡到柴的只有 9.6%，柴是唯一燃料，也是最便宜那件武器的造价。
 */
describe("第 0 阶 · 捡起身边的枯木", () => {
  const started = (): GameSimulation => {
    const simulation = build();
    // 迈第一步：不启动时钟的话 sim.7 会压住一切（那是"还没开始"的开场白）。
    for (let i = 0; i < 10; i += 1) simulation.update(1 / 20, { x: 1, z: 0 });
    return simulation;
  };
  const emptyPack = (simulation: GameSimulation): void => {
    const index = simulation.player.inventory.findIndex((stack) => stack?.kind === "wood");
    if (index >= 0) simulation.player.inventory[index] = null;
  };
  const stageOf = (simulation: GameSimulation): number =>
    (simulation as unknown as { objectives: { objectiveStage: number } }).objectives.objectiveStage;

  it("开局口粮里的柴不算他捡的 —— 第 0 阶不许当场跳过", () => {
    const simulation = started();
    expect(simulation.getInventoryCount("wood")).toBeGreaterThan(0);
    expect(stageOf(simulation)).toBe(0);
  });

  it("包里没柴时给的是「去捡柴」，不是「去添柴」", () => {
    const simulation = started();
    // 第一桶已装 → sim.fuelFirst 让位；包里没柴 → sim.14 也失效。
    (simulation as unknown as { truck: { loaded: number } }).truck.loaded = 1;
    emptyPack(simulation);
    for (let i = 0; i < 10; i += 1) simulation.update(1 / 20, { x: 0, z: 0 });

    expect((simulation.getObjective() as { key: string }).key).toBe("sim.26");
  });

  it("真的从地上捡起一根之后才推进到第 1 阶", () => {
    const simulation = started();
    emptyPack(simulation);
    for (let i = 0; i < 10; i += 1) simulation.update(1 / 20, { x: 0, z: 0 });
    expect(stageOf(simulation)).toBe(0);

    const log = simulation.items.find((item) => item.active && item.kind === "wood" && !item.placed);
    if (!log) throw new Error("地图上没有散落的枯木");
    simulation.player.x = log.x;
    simulation.player.z = log.z;
    simulation.requestInteraction();
    for (let i = 0; i < 10; i += 1) simulation.update(1 / 20, { x: 0, z: 0 });

    expect(simulation.getInventoryCount("wood")).toBeGreaterThan(0);
    expect(stageOf(simulation)).toBe(1);
  });
});
