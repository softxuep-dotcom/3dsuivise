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
