import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import { DIFFICULTIES, DIFFICULTY_TUNING } from "../src/game/simulation/difficulty";
import type { Difficulty } from "../src/game/simulation/difficulty";

const STEP = 1 / 20;

interface AxisDelta {
  health: number;
  water: number;
  hunger: number;
  warmth: number;
  stamina: number;
}

/** 跳过输入起表，只测一秒纯五轴演算；动物默认尚未启用，不会混入咬伤。 */
function sampleAxes(difficulty: Difficulty): AxisDelta {
  const sim = new GameSimulation(createWorld(), difficulty);
  const inner = sim as unknown as { clockStarted: boolean; running: boolean };
  inner.clockStarted = true;
  inner.running = true;
  sim.player.health = 50;
  sim.player.water = 50;
  sim.player.hunger = 50;
  sim.player.warmth = 50;
  sim.player.stamina = 0;
  const before = { ...sim.player };
  for (let index = 0; index < 20; index += 1) sim.update(STEP, { x: 1, z: 0 });
  return {
    health: before.health - sim.player.health,
    water: before.water - sim.player.water,
    hunger: before.hunger - sim.player.hunger,
    warmth: sim.player.warmth - before.warmth,
    stamina: sim.player.stamina - before.stamina,
  };
}

describe("难度 · 五轴与狼群压力", () => {
  it("简单档保持原始平衡，普通/困难不再靠近乎翻倍的狼群", () => {
    expect(DIFFICULTY_TUNING.easy).toMatchObject({
      raid: 1, spawnInterval: 1, raidReleaseWindow: 0.6,
      wolfHealth: 1, wolfAttack: 1,
      healthDecay: 1, waterDecay: 1, hungerDecay: 1, thermalPressure: 1, staminaRegen: 1,
    });
    expect(DIFFICULTY_TUNING.normal.raid).toBe(1.2);
    expect(DIFFICULTY_TUNING.insane.raid).toBe(1.4);
    expect(DIFFICULTY_TUNING.insane.wolfHealth).toBe(1.1);
    expect(DIFFICULTY_TUNING.insane.wolfAttack).toBe(1.16);
  });

  it("五轴按非对称倍率实际接入模拟层", () => {
    const sampled = Object.fromEntries(
      DIFFICULTIES.map((difficulty) => [difficulty, sampleAxes(difficulty)]),
    ) as Record<Difficulty, AxisDelta>;
    for (const difficulty of DIFFICULTIES) {
      const expected = DIFFICULTY_TUNING[difficulty];
      expect(sampled[difficulty].health / sampled.easy.health).toBeCloseTo(expected.healthDecay, 4);
      expect(sampled[difficulty].water / sampled.easy.water).toBeCloseTo(expected.waterDecay, 4);
      expect(sampled[difficulty].hunger / sampled.easy.hunger).toBeCloseTo(expected.hungerDecay, 4);
      expect(sampled[difficulty].warmth / sampled.easy.warmth).toBeCloseTo(expected.thermalPressure, 4);
      expect(sampled[difficulty].stamina / sampled.easy.stamina).toBeCloseTo(expected.staminaRegen, 4);
    }
  });

  it("前三夜攻营配额只做小幅阶梯，而不是近乎翻倍", () => {
    const expected: Record<Difficulty, number[]> = {
      easy: [5, 9, 14],
      normal: [6, 11, 17],
      insane: [7, 13, 20],
    };
    for (const difficulty of DIFFICULTIES) {
      for (const [offset, quota] of expected[difficulty].entries()) {
        const sim = new GameSimulation(createWorld(), difficulty);
        sim.day = offset + 1;
        const director = (sim as unknown as {
          wolfDirector: { beginNight(): void; raidQuotaThisNight: number };
        }).wolfDirector;
        director.beginNight();
        expect(director.raidQuotaThisNight, `${difficulty} 第 ${sim.day} 夜`).toBe(quota);
      }
    }
  });

  it("第一夜教学犬不吃任何难度倍率", () => {
    for (const difficulty of DIFFICULTIES) {
      const sim = new GameSimulation(createWorld(), difficulty);
      const director = (sim as unknown as {
        wolfDirector: { spawnWolf(options: { role: "raider" }): void };
      }).wolfDirector;
      director.spawnWolf({ role: "raider" });
      expect(sim.wolves[0], difficulty).toMatchObject({ maxHealth: 28, health: 28, attack: 5 });
    }
  });

  it.each(["normal", "insane"] as const)("%s 使用开局口粮可以安全抵达 190 秒的第一黎明", (difficulty) => {
    const sim = new GameSimulation(createWorld(), difficulty);
    const inner = sim as unknown as { clockStarted: boolean; running: boolean };
    inner.clockStarted = true;
    inner.running = true;
    for (let index = 0; index < 190 / STEP; index += 1) {
      if (index === 80 / STEP) {
        sim.useInventorySlot(0);
        sim.useInventorySlot(1);
      }
      if (index === 140 / STEP) sim.useInventorySlot(0);
      sim.update(STEP, { x: 0, z: 0 });
    }
    expect(sim.player.water).toBeGreaterThan(0);
    expect(sim.player.hunger).toBeGreaterThan(0);
    expect(sim.running).toBe(true);
  });
});

