import { describe, it } from "vitest";
import { createWorld } from "../../src/game/content/createWorld";
import { GameSimulation } from "../../src/game/simulation/GameSimulation";
import { campGatePosition, campLocalToWorld, terrainHeightAt, terrainSlopeAt } from "../../src/game/terrain/TerrainModel";
import { STEP, d, render } from "./harness";

describe("probe 3 - the descent", () => {
  it("boulder is reachable: exact stop distance and hint", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    const gate = campGatePosition(camp);
    const stone = world.initialItems.filter((i) => i.kind === "stone" && d(i, gate) < 12)[0];
    sim.start();
    let t = 0;
    let last = 999;
    for (let i = 0; i < 30 * 20; i += 1) {
      const dx = stone.x - sim.player.x, dz = stone.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
      sim.update(STEP, { x: dx / len, z: dz / len }); t += STEP; sim.drainEvents();
      const now = d(sim.player, stone);
      if (Math.abs(now - last) < 1e-6) { break; }
      last = now;
    }
    console.log(`stopped ${last.toFixed(2)}m from the boulder at t=${t.toFixed(1)}s (PLAYER_RADIUS+STONE_COLLIDE = 2.20)`);
    console.log(`hint now: ${render(sim.getInteractionHint().text)} / action=${sim.getInteractionHint().action}`);
    sim.requestInteraction();
    console.log(`carrying=${sim.player.carrying}`);
    // face the gate and drop
    const dx = gate.x - sim.player.x, dz = gate.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
    sim.player.facing = { x: dx / len, z: dz / len };
    sim.requestInteraction();
    sim.update(STEP, { x: 0, z: 0 });
    console.log(`t=${t.toFixed(1)} after drop: stage=${(sim as any).objectiveStage} phaseTime=${sim.phaseTime.toFixed(1)} :: ${render(sim.getObjective())}`);
  });

  it("full ideal chain: wood -> fire -> boulder, timed", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    const gate = campGatePosition(camp);
    sim.start();
    let t = 0;
    const push = (target: any, stopAt: number, budget: number) => {
      let last = 1e9, stall = 0;
      for (let i = 0; i < budget * 20; i += 1) {
        if (d(sim.player, target) <= stopAt) return true;
        const dx = target.x - sim.player.x, dz = target.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
        sim.update(STEP, { x: dx / len, z: dz / len }); t += STEP; sim.drainEvents();
        const now = d(sim.player, target);
        stall = Math.abs(now - last) < 1e-7 ? stall + 1 : 0;
        last = now;
        if (stall > 20) return false;
      }
      return false;
    };
    const woods = world.initialItems.filter((i) => i.kind === "wood" && d(i, camp) < 20)
      .sort((a, b) => d(a, sim.player) - d(b, sim.player));
    console.log(`t=${t.toFixed(1)} :: ${render(sim.getObjective())}`);
    push(woods[0], 2.3, 20);
    console.log(`t=${t.toFixed(1)} at wood (${d(sim.player, woods[0]).toFixed(2)}m) hint=${render(sim.getInteractionHint().text)}`);
    sim.requestInteraction(); sim.update(STEP, { x: 0, z: 0 }); t += STEP; sim.drainEvents();
    console.log(`t=${t.toFixed(1)} wood taken, stamina=${sim.player.stamina} :: ${render(sim.getObjective())} | hint=${render(sim.getInteractionHint().text)}`);
    sim.requestInteraction(); sim.update(STEP, { x: 0, z: 0 }); t += STEP; sim.drainEvents();
    console.log(`t=${t.toFixed(1)} fire fed? fuel=${sim.camps[camp.id].fuel.toFixed(0)} stage=${(sim as any).objectiveStage} :: ${render(sim.getObjective())}`);
    const stone = world.initialItems.filter((i) => i.kind === "stone" && d(i, gate) < 12)[0];
    const ok = push(stone, 2.35, 30);
    console.log(`t=${t.toFixed(1)} boulder reached=${ok} dist=${d(sim.player, stone).toFixed(2)} :: ${render(sim.getObjective())}`);
    sim.requestInteraction();
    const dx = gate.x - sim.player.x, dz = gate.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
    sim.player.facing = { x: dx / len, z: dz / len };
    sim.requestInteraction();
    sim.update(STEP, { x: 0, z: 0 }); t += STEP;
    for (const e of sim.drainEvents()) if (e.type === "message") console.log(`   TOAST ${render(e as any)}`);
    console.log(`t=${t.toFixed(1)} CHAIN DONE stage=${(sim as any).objectiveStage} phase=${sim.phase} phaseTime=${sim.phaseTime.toFixed(1)} warmth=${sim.player.warmth.toFixed(0)} stamina=${sim.player.stamina.toFixed(0)} :: ${render(sim.getObjective())}`);
    // then head for the truck
    const okTruck = push(world.truck, 4.0, 90);
    console.log(`t=${t.toFixed(1)} truck reached=${okTruck} dist=${d(sim.player, world.truck).toFixed(1)} pos=(${sim.player.x.toFixed(1)},${sim.player.z.toFixed(1)}) phase=${sim.phase} :: ${render(sim.getObjective())}`);
  });

  it("descent corridor: slope map between camp and truck", () => {
    const world = createWorld();
    const camp = world.camps[world.startCampId];
    const limit = world.terrain.maxWalkableSlope;
    console.log(`maxWalkableSlope=${limit}`);
    console.log("rows z=-18..-40 step 2, cols x=-8..+10 step 2 : '.'=walkable '#'=too steep, height in second grid");
    for (let z = -18; z >= -40; z -= 2) {
      let row = `z=${String(z).padStart(4)} `;
      let hrow = "      ";
      for (let x = -8; x <= 10; x += 2) {
        const p = { x, z };
        const s = terrainSlopeAt(world as any, p);
        row += s <= limit ? " . " : " # ";
        hrow += String(Math.round(terrainHeightAt(world as any, p))).padStart(3);
      }
      console.log(row + "   |" + hrow);
    }
    console.log("truck at", world.truck.x.toFixed(1), world.truck.z.toFixed(1));
    const path = camp.approach.map((l) => campLocalToWorld(camp, l));
    console.log("authored ramp nodes:", path.map((p) => `(${p.x.toFixed(1)},${p.z.toFixed(1)})`).join(" -> "));
  });

  it("ramp-following walk: per-leg timing", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    sim.start();
    let t = 0;
    const path = camp.approach.map((l) => campLocalToWorld(camp, l));
    for (const node of [...path, world.truck]) {
      const start = t;
      let last = 1e9, stall = 0, stuck = false;
      for (let i = 0; i < 40 * 20; i += 1) {
        if (d(sim.player, node) <= 2.0) break;
        const dx = node.x - sim.player.x, dz = node.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
        sim.update(STEP, { x: dx / len, z: dz / len }); t += STEP; sim.drainEvents();
        const now = d(sim.player, node);
        stall = Math.abs(now - last) < 1e-7 ? stall + 1 : 0; last = now;
        if (stall > 20) { stuck = true; break; }
      }
      console.log(`  leg -> (${node.x.toFixed(1)},${node.z.toFixed(1)}) took ${(t - start).toFixed(1)}s, now at (${sim.player.x.toFixed(1)},${sim.player.z.toFixed(1)}) remaining=${d(sim.player, node).toFixed(1)} stuck=${stuck}`);
    }
    console.log(`  total spawn->truck via ramp: ${t.toFixed(1)}s, phase=${sim.phase}, phaseTime=${sim.phaseTime.toFixed(1)}`);
  });
});
