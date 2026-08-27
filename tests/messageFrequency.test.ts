import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";

const STEP = 1 / 20;

const messages = (simulation: GameSimulation) => simulation.drainEvents()
  .filter((event) => event.type === "message");

describe("消息频率", () => {
  it("开局口粮推进目标时不再重复讲柴火和门口大石", () => {
    const simulation = new GameSimulation(createWorld());
    simulation.start();
    messages(simulation); // 开场首句 msg.1

    simulation.update(STEP, { x: 1, z: 0 });

    expect(messages(simulation)).toEqual([]);
  });

  it("黄昏会把背包里的柴从缺口中扣除", () => {
    const simulation = new GameSimulation(createWorld());
    // 开局口粮的柴是 2（够烧满第一夜），那会走到下一条测试的 duskCarryEnough 分支。
    // 这条要验的是**缺口**分支，所以先压回 1 —— 门槛写在数值里，测试自己造够不着的状态。
    const wood = simulation.player.inventory.find((stack) => stack?.kind === "wood");
    if (!wood) throw new Error("开局口粮缺少教学用枯木");
    wood.count = 1;
    simulation.start();
    messages(simulation);
    const state = simulation as unknown as { clockStarted: boolean; phaseTime: number };
    state.clockStarted = true;
    state.phaseTime = 30.01;

    simulation.update(STEP, { x: 0, z: 0 });

    expect(messages(simulation)).toEqual([
      { type: "message", key: "msg.duskNoFire", params: { night: 150, logs: 1 } },
    ]);
  });

  it("背包里的柴已经够过夜时直接提示添火", () => {
    const simulation = new GameSimulation(createWorld());
    const wood = simulation.player.inventory.find((stack) => stack?.kind === "wood");
    if (!wood) throw new Error("开局口粮缺少教学用枯木");
    wood.count = 2;
    simulation.start();
    messages(simulation);
    const state = simulation as unknown as { clockStarted: boolean; phaseTime: number };
    state.clockStarted = true;
    state.phaseTime = 30.01;

    simulation.update(STEP, { x: 0, z: 0 });

    expect(messages(simulation)).toEqual([
      { type: "message", key: "msg.duskCarryEnough", params: { logs: 2 } },
    ]);
  });
});
