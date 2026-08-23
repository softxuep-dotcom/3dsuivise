import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import type { GameEvent } from "../src/game/simulation/types";

const STEP = 1 / 20;

function build(): GameSimulation {
  const sim = new GameSimulation(createWorld());
  sim.start();
  sim.drainEvents();
  return sim;
}

/** 把一桶放到已点燃的营火前三米，走完整的“捡起 → 投掷 → 飞行”输入链。 */
function throwBarrelAtFire(spent: number): { sim: GameSimulation; barrel: GameSimulation["barrels"][number]; events: GameEvent[] } {
  const sim = build();
  const camp = sim.world.camps[sim.world.startCampId];
  sim.camps[camp.id].fuel = 100;
  const barrel = sim.barrels[sim.barrels.length - 1];
  for (const other of sim.barrels.filter((candidate) => candidate !== barrel).slice(0, spent)) {
    other.placement = "spent";
  }
  sim.player.x = camp.x - 3;
  sim.player.z = camp.z;
  sim.player.facing = { x: 1, z: 0 };
  barrel.x = sim.player.x;
  barrel.z = sim.player.z;
  barrel.placement = "ground";

  sim.requestInteraction();
  expect(sim.player.carrying).toBe("fuel");
  sim.requestAttack();
  for (let step = 0; step < 20; step += 1) sim.update(STEP, { x: 0, z: 0 });
  return { sim, barrel, events: sim.drainEvents() };
}

describe("ProjectileCarriedCombatSystem", () => {
  it("只消耗多出来的四桶爆破预算，最后六桶不会把通关条件炸没", () => {
    const { sim, barrel, events } = throwBarrelAtFire(4);

    expect(sim.getFuelBlastBudget()).toBe(0);
    expect(barrel.placement).toBe("ground");
    expect(sim.barrels.filter((candidate) => candidate.placement === "spent")).toHaveLength(4);
    expect(events.some((event) => event.type === "barrel-blast")).toBe(false);
    expect(events).toContainEqual({ type: "message", key: "msg.fuelReserved" });
  });

  it("尚有余量时仍能把油桶投入火堆爆破", () => {
    const { sim, barrel, events } = throwBarrelAtFire(3);

    expect(barrel.placement).toBe("spent");
    expect(sim.getFuelBlastBudget()).toBe(0);
    expect(events.some((event) => event.type === "barrel-blast")).toBe(true);
  });

  it("抽出系统后飞石仍会命中并重新落成地面石头", () => {
    const sim = build();
    sim.enableWolves();
    const wolf = sim.wolves.find((candidate) => candidate.kind !== "elite")!;
    for (const other of sim.wolves) if (other !== wolf) other.mode = "dead";
    wolf.mode = "chase";
    wolf.x = sim.player.x + 3;
    wolf.z = sim.player.z;
    wolf.health = wolf.maxHealth;
    sim.player.facing = { x: 1, z: 0 };
    const stone = sim.items.find((item) => item.kind === "stone")!;
    stone.active = true;
    stone.placed = false;
    stone.x = sim.player.x;
    stone.z = sim.player.z;
    // 拾取优先级里油桶在普通地面物品之前；此测试只隔离飞石链路。
    for (const barrel of sim.barrels) barrel.placement = "loaded";

    const activeItemsBefore = sim.items.filter((item) => item.active).length;
    sim.requestInteraction();
    expect(sim.player.carrying).toBe("stone");
    sim.requestAttack();
    for (let step = 0; step < 20; step += 1) sim.update(STEP, { x: 0, z: 0 });
    const events = sim.drainEvents();

    expect(events.some((event) => event.type === "stone-thrown")).toBe(true);
    expect(events).toContainEqual({ type: "stone-landed", hit: true });
    expect(wolf.health).toBeLessThan(wolf.maxHealth);
    expect(sim.items.filter((item) => item.active)).toHaveLength(activeItemsBefore);
    expect(sim.thrownStones.every((flight) => !flight.active)).toBe(true);
  });

  it("油桶会自动瞄准斜前方猎物并造成撞击伤害", () => {
    const sim = build();
    sim.enableCritters();
    const critter = sim.critters[0];
    for (const other of sim.critters) if (other !== critter) other.mode = "dead";
    critter.mode = "graze";
    critter.x = sim.player.x + 3;
    critter.z = sim.player.z + 2;
    critter.health = 100;
    critter.maxHealth = 100;
    sim.player.facing = { x: 1, z: 0 };
    const barrel = sim.barrels[sim.barrels.length - 1];
    for (const other of sim.barrels) other.placement = "loaded";
    barrel.x = sim.player.x;
    barrel.z = sim.player.z;
    barrel.placement = "ground";

    sim.requestInteraction();
    expect(sim.player.carrying).toBe("fuel");
    sim.requestAttack();
    for (let step = 0; step < 20; step += 1) sim.update(STEP, { x: 0, z: 0 });
    const events = sim.drainEvents();

    expect(events.some((event) => event.type === "barrel-thrown")).toBe(true);
    expect(critter.health).toBe(70);
    expect(barrel.placement).toBe("ground");
  });
});

describe("卡车逐桶苏醒", () => {
  it.each([
    [0, false, false, false, false, false],
    [1, true, false, false, false, false],
    [2, true, true, false, false, false],
    [3, true, true, true, false, false],
    [4, true, true, true, false, false],
    [5, true, true, true, true, false],
    [6, true, true, true, true, true],
  ] as const)("装入 %i 桶时解锁对应系统", (loaded, electrics, headlights, horn, engine, ready) => {
    const sim = build();
    sim.truck.loaded = loaded;
    expect(sim.getTruckPowerState()).toMatchObject({ loaded, electrics, headlights, horn, engine, ready });
  });

  it("第三桶解锁的喇叭能震退普通狼，精英不受影响，并立即进入冷却", () => {
    const sim = build();
    sim.enableWolves();
    sim.truck.loaded = 3;
    sim.player.x = sim.truck.x;
    sim.player.z = sim.truck.z;
    const [ordinary, elite] = sim.wolves;
    elite.kind = "elite";
    for (const wolf of sim.wolves) if (wolf !== ordinary && wolf !== elite) wolf.mode = "dead";
    ordinary.mode = "chase";
    ordinary.attackCooldown = 0;
    ordinary.x = sim.truck.x + 3;
    ordinary.z = sim.truck.z;
    elite.mode = "chase";
    elite.attackCooldown = 0;
    elite.x = sim.truck.x - 3;
    elite.z = sim.truck.z;
    const ordinaryBefore = Math.hypot(ordinary.x - sim.truck.x, ordinary.z - sim.truck.z);
    const eliteBefore = { x: elite.x, z: elite.z };

    sim.requestInteraction();
    const events = sim.drainEvents();

    expect(events).toContainEqual({ type: "truck-horn", affected: 1 });
    expect(Math.hypot(ordinary.x - sim.truck.x, ordinary.z - sim.truck.z)).toBeGreaterThan(ordinaryBefore);
    expect({ x: elite.x, z: elite.z }).toEqual(eliteBefore);
    expect(sim.getTruckPowerState().hornCooldown).toBe(45);

    sim.requestInteraction();
    expect(sim.drainEvents().some((event) => event.type === "truck-horn")).toBe(false);
  });
});
