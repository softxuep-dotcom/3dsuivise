import { describe, it } from "vitest";
import { createWorld } from "../../src/game/content/createWorld";
import { GameSimulation } from "../../src/game/simulation/GameSimulation";
import { campGatePosition, campLocalToWorld, isTerrainWalkable, terrainHeightAt } from "../../src/game/terrain/TerrainModel";
import { STEP, d, render } from "./harness";

describe("probe 2", () => {
  it("objective every second 20..45 for an idle player", () => {
    const sim = new GameSimulation(createWorld());
    sim.start();
    for (let step = 0; step < 46 * 20; step += 1) {
      sim.update(STEP, step < 4 ? { x: 1, z: 0 } : { x: 0, z: 0 });
      sim.drainEvents();
      const t = (step + 1) * STEP;
      if (Math.abs(t - Math.round(t)) < 1e-9 && Math.round(t) >= 20) {
        console.log(`t=${Math.round(t)} phaseTime=${sim.phaseTime.toFixed(2)} rest=${sim.player.resting} :: ${render(sim.getObjective())}`);
      }
    }
  });

  it("player who feeds the fire and stays in camp: warmth hijack", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    sim.start();
    let t = 0;
    const goto = (target: any, reach: number, budget = 60) => {
      for (let i = 0; i < budget * 20 && d(sim.player, target) > reach; i += 1) {
        const dx = target.x - sim.player.x, dz = target.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
        sim.update(STEP, { x: dx / len, z: dz / len }); t += STEP; sim.drainEvents();
      }
    };
    const woods = world.initialItems.filter((i) => i.kind === "wood" && d(i, camp) < 20)
      .sort((a, b) => d(a, sim.player) - d(b, sim.player));
    goto(woods[0], 2.2); sim.requestInteraction();
    goto(camp, 1.0); sim.requestInteraction();
    console.log(`t=${t.toFixed(1)} fire lit, warmth=${sim.player.warmth.toFixed(0)} :: ${render(sim.getObjective())}`);
    // now wander inside the camp (stay within the 10m fire radius)
    for (let i = 0; i < 40 * 20; i += 1) {
      const angle = i * 0.02;
      sim.update(STEP, { x: Math.cos(angle) * 0.3, z: Math.sin(angle) * 0.3 });
      t += STEP; sim.drainEvents();
      if (i % 40 === 0) {
        console.log(`t=${t.toFixed(0)} phase=${sim.phase} warmth=${sim.player.warmth.toFixed(0)} distCamp=${d(sim.player, camp).toFixed(1)} :: ${render(sim.getObjective())}`);
      }
    }
  });

  it("walking to the gate boulder: is the mesa in the way?", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    const gate = campGatePosition(camp);
    const stone = world.initialItems.filter((i) => i.kind === "stone" && d(i, gate) < 12)[0];
    sim.start();
    console.log(`camp centre height ${terrainHeightAt(world as any, camp).toFixed(1)}  gate height ${terrainHeightAt(world as any, gate).toFixed(1)}  stone height ${terrainHeightAt(world as any, stone).toFixed(1)}`);
    console.log(`truck height ${terrainHeightAt(world as any, world.truck).toFixed(1)}`);
    // sample the straight line camp -> stone
    for (let f = 0; f <= 1.0001; f += 0.1) {
      const p = { x: camp.x + (stone.x - camp.x) * f, z: camp.z + (stone.z - camp.z) * f };
      console.log(`  f=${f.toFixed(1)} (${p.x.toFixed(1)},${p.z.toFixed(1)}) h=${terrainHeightAt(world as any, p).toFixed(1)} walkable=${isTerrainWalkable(world as any, p)}`);
    }
    // straight line camp -> truck
    console.log("straight line camp -> truck:");
    for (let f = 0; f <= 1.0001; f += 0.1) {
      const p = { x: camp.x + (world.truck.x - camp.x) * f, z: camp.z + (world.truck.z - camp.z) * f };
      console.log(`  f=${f.toFixed(1)} (${p.x.toFixed(1)},${p.z.toFixed(1)}) h=${terrainHeightAt(world as any, p).toFixed(1)} walkable=${isTerrainWalkable(world as any, p)}`);
    }
    // naive stick-toward-target walk, log progress
    let t = 0;
    for (let i = 0; i < 60 * 20 && d(sim.player, stone) > 2.2; i += 1) {
      const dx = stone.x - sim.player.x, dz = stone.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
      sim.update(STEP, { x: dx / len, z: dz / len }); t += STEP; sim.drainEvents();
      if (i % 40 === 0) console.log(`  naive walk t=${t.toFixed(0)} at (${sim.player.x.toFixed(1)},${sim.player.z.toFixed(1)}) h=${terrainHeightAt(world as any, sim.player).toFixed(1)} remaining=${d(sim.player, stone).toFixed(1)}m`);
    }
    console.log(`  naive walk to gate boulder took ${t.toFixed(1)}s for a ${d(world.camps[world.startCampId], stone).toFixed(1)}m straight line`);
    // then naive walk to the truck
    let t2 = 0;
    for (let i = 0; i < 90 * 20 && d(sim.player, world.truck) > 4; i += 1) {
      const dx = world.truck.x - sim.player.x, dz = world.truck.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
      sim.update(STEP, { x: dx / len, z: dz / len }); t2 += STEP; sim.drainEvents();
      if (i % 40 === 0) console.log(`  naive walk to truck t=${t2.toFixed(0)} at (${sim.player.x.toFixed(1)},${sim.player.z.toFixed(1)}) remaining=${d(sim.player, world.truck).toFixed(1)}m`);
    }
    console.log(`  naive walk boulder -> truck took ${t2.toFixed(1)}s`);
    // via the ramp (following the authored approach polyline)
    const sim2 = new GameSimulation(createWorld());
    sim2.start();
    let t3 = 0;
    const path = camp.approach.map((l) => campLocalToWorld(camp, l));
    for (const node of [...path, world.truck]) {
      for (let i = 0; i < 60 * 20 && d(sim2.player, node) > 2.0; i += 1) {
        const dx = node.x - sim2.player.x, dz = node.z - sim2.player.z, len = Math.hypot(dx, dz) || 1;
        sim2.update(STEP, { x: dx / len, z: dz / len }); t3 += STEP; sim2.drainEvents();
      }
    }
    console.log(`  ramp-following walk spawn -> truck took ${t3.toFixed(1)}s (straight-line ${d(sim.player, world.truck).toFixed(1)}m); ended (${sim2.player.x.toFixed(1)},${sim2.player.z.toFixed(1)}) remaining ${d(sim2.player, world.truck).toFixed(1)}m`);
  });

  it("nearest barrel: how long to fetch one and load it", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    sim.start();
    const barrel = [...world.barrels].sort((a, b) => d(a, sim.player) - d(b, sim.player))[0];
    console.log(`nearest barrel #${barrel.id} at ${d(barrel, sim.player).toFixed(1)}m from spawn, ${d(barrel, world.truck).toFixed(1)}m from truck, guarded=${barrel.guarded}`);
    let t = 0;
    for (let i = 0; i < 120 * 20 && d(sim.player, barrel) > 2.4; i += 1) {
      const dx = barrel.x - sim.player.x, dz = barrel.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
      sim.update(STEP, { x: dx / len, z: dz / len }); t += STEP; sim.drainEvents();
    }
    console.log(`  reached barrel at t=${t.toFixed(1)}s (phase=${sim.phase}) :: ${render(sim.getObjective())}`);
    sim.requestInteraction();
    console.log(`  carrying=${sim.player.carrying} :: ${render(sim.getObjective())}`);
    for (let i = 0; i < 180 * 20 && d(sim.player, world.truck) > 4.0; i += 1) {
      const dx = world.truck.x - sim.player.x, dz = world.truck.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
      sim.update(STEP, { x: dx / len, z: dz / len }); t += STEP; sim.drainEvents();
    }
    console.log(`  back at truck t=${t.toFixed(1)}s phase=${sim.phase} day=${sim.day} :: ${render(sim.getObjective())}`);
    sim.requestInteraction();
    console.log(`  truck loaded=${sim.truck.loaded} :: ${render(sim.getObjective())}`);
  });
});
