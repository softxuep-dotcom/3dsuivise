import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import type { Vec2 } from "../src/game/simulation/types";
import { FirstBarrelHint } from "../src/ui/FirstBarrelHint";

describe("出生点油桶提示灯", () => {
  const STEP = 1 / 20;

  const build = (preStartSeconds = 3) => {
    const simulation = new GameSimulation(createWorld());
    let lit: Vec2 | null = null;
    const hint = new FirstBarrelHint({
      get simulation() { return simulation; },
      spotlight: (target) => { lit = target; },
    });

    /* 复现真机顺序：reset 先发生，第一次玩家输入之后 simulation 才 start。 */
    hint.reset();
    for (let elapsed = 0; elapsed < preStartSeconds / STEP; elapsed += 1) hint.update(STEP);
    simulation.start();

    const barrel = simulation.barrels.reduce((best, candidate) => (
      Math.hypot(candidate.x - simulation.player.x, candidate.z - simulation.player.z)
        < Math.hypot(best.x - simulation.player.x, best.z - simulation.player.z) ? candidate : best
    ));
    const away = (): Vec2 => {
      const dx = simulation.player.x - barrel.x;
      const dz = simulation.player.z - barrel.z;
      const magnitude = Math.hypot(dx, dz) || 1;
      return { x: dx / magnitude, z: dz / magnitude };
    };
    const step = (seconds: number, movement: () => Vec2) => {
      for (let elapsed = 0; elapsed < seconds / STEP; elapsed += 1) {
        simulation.update(STEP, movement());
        hint.update(STEP);
      }
    };

    return {
      simulation,
      hint,
      barrel,
      lit: () => lit,
      walkAway: (seconds: number) => step(seconds, away),
      idle: (seconds: number) => step(seconds, () => ({ x: 0, z: 0 })),
    };
  };

  it("站在出生点时不点灯", () => {
    const game = build();
    game.idle(6);
    expect(game.lit()).toBeNull();
  });

  it("走开后照亮出生油桶", () => {
    const game = build();
    game.walkAway(4);
    const lit = game.lit();
    expect(lit).not.toBeNull();
    expect(Math.hypot(lit!.x - game.barrel.x, lit!.z - game.barrel.z)).toBeLessThan(0.01);
  });

  it("四秒后熄灭且不会反复催促", () => {
    const game = build();
    game.walkAway(4);
    expect(game.lit()).not.toBeNull();
    game.idle(8);
    expect(game.lit()).toBeNull();
    game.walkAway(4);
    expect(game.lit()).toBeNull();
  });

  it("已经扛起油桶时不点灯", () => {
    const game = build();
    game.simulation.requestInteraction();
    expect(game.simulation.player.carrying).toBe("fuel");
    game.walkAway(4);
    expect(game.lit()).toBeNull();
  });

  it("玩家开场长时间没输入不会提前禁用提示", () => {
    const game = build(20);
    game.walkAway(4);
    expect(game.lit()).not.toBeNull();
  });

  it("软重启后允许新的一局再次提示", () => {
    const game = build();
    game.walkAway(4);
    game.idle(8);
    game.hint.reset();
    game.walkAway(4);
    expect(game.lit()).not.toBeNull();
  });
});
