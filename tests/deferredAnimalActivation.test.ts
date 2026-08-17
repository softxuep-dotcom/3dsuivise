import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";

describe("动物资源延迟启用", () => {
  it("资源未就绪时不生成猎物或狼", () => {
    const sim = new GameSimulation(createWorld());
    expect(sim.critters).toHaveLength(0);
    expect(sim.wolves).toHaveLength(0);
  });

  it("鹿资源就绪后只启用猎物，而且不会重复撒怪", () => {
    const sim = new GameSimulation(createWorld());
    sim.enableCritters();
    const population = sim.critters.length;

    expect(population).toBeGreaterThan(0);
    expect(sim.wolves).toHaveLength(0);

    sim.enableCritters();
    expect(sim.critters).toHaveLength(population);
  });

  it("狼资源就绪后生成守巢犬，而且不会重复生成", () => {
    const sim = new GameSimulation(createWorld());
    sim.enableWolves();

    expect(sim.wolves.filter((wolf) => wolf.role === "guard")).toHaveLength(5);
    expect(sim.critters).toHaveLength(0);

    sim.enableWolves();
    expect(sim.wolves.filter((wolf) => wolf.role === "guard")).toHaveLength(5);
  });
});
