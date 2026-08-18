import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import { CRITTER_SPECS } from "../src/game/simulation/types";

/**
 * 出生点脚边必须有能一刀砍中的东西。
 *
 * 这条守的是一个很容易悄悄退化的性质：`seedCritters()` 原先把 52 只猎物**均匀撒满
 * 220×220 的地图**，于是最近的铠甲虫在 92 米外，而一直挥刀的玩家第一次命中要到
 * 第 43 秒 —— 第一天白天只有 40 秒，也就是说这一课在考试之后才到。
 *
 * 数字之间是咬合的，改任何一个都要回来看这里：
 *   铠甲虫 8 血 / 初始匕首 30 伤害  → 一刀
 *   教学犬 28 血 / 防御 0          → 同样一刀（这才是这三只虫子存在的理由）
 *   逃速 2.6 / 玩家 8.2            → 跑不掉
 *   警觉 3.5 / 刀长 3.1            → 落点必须在警觉圈外，否则开局它们就在跑
 */
const STEP = 1 / 20;

function build(): GameSimulation {
  const sim = new GameSimulation(createWorld());
  sim.enableCritters();
  sim.enableWolves();
  sim.start();
  return sim;
}

const distance = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z);

describe("开局的第一刀", () => {
  it("出生点 6 米内有至少三只铠甲虫，且都在警觉半径之外", () => {
    const sim = build();
    const near = sim.critters
      .filter((critter) => critter.kind === "beetle")
      .map((critter) => distance(sim.player, critter))
      .filter((d) => d <= 6)
      .sort((a, b) => a - b);

    expect(near.length).toBeGreaterThanOrEqual(3);
    // 站在警觉圈外才是静止的；落在圈内的话玩家一进游戏就看见它们在逃。
    expect(near[0]).toBeGreaterThan(CRITTER_SPECS.beetle.alertRadius);
  });

  it("铠甲虫仍然是一刀一只，且种群总数没被撑大", () => {
    const sim = build();
    expect(CRITTER_SPECS.beetle.maxHealth).toBeLessThan(sim.getAttackPower());
    const beetles = sim.critters.filter((critter) => critter.kind === "beetle");
    expect(beetles).toHaveLength(CRITTER_SPECS.beetle.population);
  });

  it("只用「走 + 挥刀」这一个动词，10 秒内能拿到第一块肉", () => {
    const sim = build();
    let firstHit = -1;
    let firstMeat = -1;
    for (let step = 0; step * STEP <= 30; step += 1) {
      const now = step * STEP;
      sim.requestAttack();
      sim.update(STEP, { x: sim.player.facing.x, z: sim.player.facing.z });
      for (const event of sim.drainEvents()) {
        if (event.type === "critter-hit" && firstHit < 0) firstHit = now;
        if (event.type === "pickup" && event.kind === "raw-meat" && firstMeat < 0) firstMeat = now;
      }
    }
    expect(firstHit).toBeGreaterThanOrEqual(0);
    expect(firstHit).toBeLessThan(10);
    expect(firstMeat).toBeGreaterThanOrEqual(0);
    expect(firstMeat).toBeLessThan(10);
  });

  it("补充逻辑不在脚边重复刷：教学虫被打死后，新的补在 30 米开外", () => {
    const sim = build();
    const anchor = { x: sim.player.x, z: sim.player.z };
    for (const critter of sim.critters) {
      if (critter.kind === "beetle" && distance(anchor, critter) < 8) {
        (sim as unknown as { killCritter(c: typeof critter): void }).killCritter(critter);
      }
    }
    for (let step = 0; step * STEP <= 120; step += 1) {
      sim.update(STEP, { x: sim.player.facing.x, z: sim.player.facing.z });
      if (!sim.running) break;
    }
    const alive = sim.critters.filter((c) => c.kind === "beetle" && c.mode !== "dead");
    expect(alive).toHaveLength(CRITTER_SPECS.beetle.population);
    const nearest = Math.min(...alive.map((c) => distance(anchor, c)));
    expect(nearest).toBeGreaterThan(30);
  });
});
