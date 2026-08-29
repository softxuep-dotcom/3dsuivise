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
 * 第 0 阶：**把第一桶油装上车**。
 *
 * 它原先是「捡起身边的枯木」，判据是"捡过柴没有"。现在整条链的第一步换成了搬油 ——
 * 出生点脚边就有一桶，这一步同时教了"搬"和"装车"，而且第一帧就把玩家指向通关目标。
 *
 * 注意 `sim.26` 这句文案**实际显示不出来**：它上面的 sim.fuelFirst 闸门是
 * 「第 1 天 + 白天 + 还没装过桶」，正好盖住第 0 阶的全部存在时间。这里守的是
 * **阶段机器本身**（推进时机对不对），不是那句文案会不会出现。
 */
describe("第 0 阶 · 装上第一桶油", () => {
  const started = (): GameSimulation => {
    const simulation = build();
    // 迈第一步：不启动时钟的话 sim.7 会压住一切（那是"还没开始"的开场白）。
    for (let i = 0; i < 10; i += 1) simulation.update(1 / 20, { x: 1, z: 0 });
    return simulation;
  };
  const stageOf = (simulation: GameSimulation): number =>
    (simulation as unknown as { objectives: { objectiveStage: number } }).objectives.objectiveStage;
  const setLoaded = (simulation: GameSimulation, value: number): void => {
    (simulation as unknown as { truck: { loaded: number } }).truck.loaded = value;
  };

  it("一桶都没装的时候停在第 0 阶 —— 开局口粮里的柴不再能顶掉它", () => {
    const simulation = started();
    expect(simulation.getInventoryCount("wood")).toBeGreaterThan(0);
    expect(stageOf(simulation)).toBe(0);
  });

  it("第一桶进车斗才推进到第 1 阶", () => {
    const simulation = started();
    expect(stageOf(simulation)).toBe(0);

    setLoaded(simulation, 1);
    for (let i = 0; i < 10; i += 1) simulation.update(1 / 20, { x: 0, z: 0 });

    expect(stageOf(simulation)).toBe(1);
  });

  it("第 0 阶期间白天的目标行说的是通关目标，不是家务", () => {
    const simulation = started();
    expect(stageOf(simulation)).toBe(0);
    expect((simulation.getObjective() as { key: string }).key).toBe("sim.fuelFirst");
  });
});
