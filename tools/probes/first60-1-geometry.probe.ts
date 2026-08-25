import { describe, it } from "vitest";
import { createWorld } from "../../src/game/content/createWorld";
import { GameSimulation } from "../../src/game/simulation/GameSimulation";
import { campGatePosition } from "../../src/game/terrain/TerrainModel";
import { STEP, d, render } from "./harness";

describe("first 60 seconds probe", () => {
  it("geometry", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    const p = sim.player;
    console.log("startCampId", world.startCampId, "camp", camp.x, camp.z, "radius", camp.radius);
    console.log("player spawn", p.x.toFixed(2), p.z.toFixed(2));
    console.log("truck", world.truck.x.toFixed(2), world.truck.z.toFixed(2), "dist from player", d(p, world.truck).toFixed(1));
    const gate = campGatePosition(camp);
    console.log("gate", gate.x.toFixed(2), gate.z.toFixed(2), "dist from player", d(p, gate).toFixed(1));
    const woods = world.initialItems.filter((i) => i.kind === "wood" && d(i, camp) < 20);
    for (const w of woods) console.log("  wood", w.x.toFixed(2), w.z.toFixed(2), "distPlayer", d(p, w).toFixed(2), "distCamp", d(w, camp).toFixed(2));
    const stones = world.initialItems.filter((i) => i.kind === "stone" && d(i, gate) < 12);
    for (const s of stones) console.log("  gateStone", s.x.toFixed(2), s.z.toFixed(2), "distPlayer", d(p, s).toFixed(2), "distGate", d(s, gate).toFixed(2), "distCamp", d(s, camp).toFixed(2));
    const barrels = [...world.barrels].sort((a, b) => d(a, p) - d(b, p));
    for (const b of barrels.slice(0, 4)) console.log("  barrel", b.id, "guarded", b.guarded, "distPlayer", d(b, p).toFixed(1), "distTruck", d(b, world.truck).toFixed(1));
    const wells = [...world.wells].sort((a, b) => d(a, p) - d(b, p));
    console.log("  nearest well distPlayer", d(wells[0], p).toFixed(1));
    const cacti = [...world.initialCacti].sort((a, b) => d(a, p) - d(b, p));
    console.log("  nearest cactus distPlayer", d(cacti[0], p).toFixed(1));
  });

  it("idle player: objective text per second", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    sim.start();
    console.log("t=-1 (before any input):", render(sim.getObjective()));
    // one nudge to start the clock, then stand still
    for (let step = 0; step < 60 * 20; step += 1) {
      const move = step < 4 ? { x: 1, z: 0 } : { x: 0, z: 0 };
      sim.update(STEP, move);
      const t = (step + 1) * STEP;
      if (Math.abs(t - Math.round(t)) < 1e-9 && [0, 1, 2, 5, 10, 15, 20, 25, 26, 30, 35, 39, 40, 41, 45, 50, 55, 60].includes(Math.round(t))) {
        console.log(`t=${Math.round(t)} phase=${sim.phase} phaseTime=${sim.phaseTime.toFixed(1)} warmth=${sim.player.warmth.toFixed(0)} stam=${sim.player.stamina.toFixed(0)} :: ${render(sim.getObjective())}`);
      }
      for (const e of sim.drainEvents()) {
        if (e.type === "message") console.log(`   t=${t.toFixed(1)} TOAST ${render({ key: (e as any).key, params: (e as any).params })}`);
      }
    }
  });

  it("ideal player: walks the tutorial chain, timed", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    const gate = campGatePosition(camp);
    sim.start();
    let t = 0;
    const log: string[] = [];
    const goto = (target: { x: number; z: number }, reach: number, budget = 40): boolean => {
      for (let i = 0; i < budget * 20; i += 1) {
        if (d(sim.player, target) <= reach) return true;
        const dx = target.x - sim.player.x;
        const dz = target.z - sim.player.z;
        const len = Math.hypot(dx, dz) || 1;
        sim.update(STEP, { x: dx / len, z: dz / len });
        t += STEP;
        sim.drainEvents();
      }
      return false;
    };
    const idle = (seconds: number) => {
      for (let i = 0; i < seconds * 20; i += 1) { sim.update(STEP, { x: 0, z: 0 }); t += STEP; sim.drainEvents(); }
    };
    const stage = () => (sim as any).objectiveStage;

    const woods = world.initialItems.filter((i) => i.kind === "wood" && d(i, camp) < 20)
      .sort((a, b) => d(a, sim.player) - d(b, sim.player));
    log.push(`t=${t.toFixed(1)} start, stage=${stage()} :: ${render(sim.getObjective())}`);
    goto(woods[0], 2.2);
    log.push(`t=${t.toFixed(1)} reached wood#1 (${d(sim.player, woods[0]).toFixed(1)}m) hint=${render(sim.getInteractionHint().text)}`);
    sim.requestInteraction();
    idle(0.2);
    log.push(`t=${t.toFixed(1)} took wood, stamina=${sim.player.stamina.toFixed(0)}, stage=${stage()} :: ${render(sim.getObjective())}`);
    // walk to the fire (camp centre) and feed
    goto(camp, 1.2);
    log.push(`t=${t.toFixed(1)} at hearth, hint=${render(sim.getInteractionHint().text)}`);
    sim.requestInteraction();
    idle(0.2);
    log.push(`t=${t.toFixed(1)} fed fire, campFuel=${sim.camps[camp.id].fuel.toFixed(0)}, stage=${stage()}, warmth=${sim.player.warmth.toFixed(0)} :: ${render(sim.getObjective())}`);
    // find the gate boulder
    const stone = world.initialItems.filter((i) => i.kind === "stone" && d(i, gate) < 12)
      .sort((a, b) => d(a, sim.player) - d(b, sim.player))[0];
    goto(stone, 2.2);
    log.push(`t=${t.toFixed(1)} at gate boulder (${d(sim.player, stone).toFixed(1)}m) hint=${render(sim.getInteractionHint().text)} warmth=${sim.player.warmth.toFixed(0)}`);
    sim.requestInteraction();
    idle(0.2);
    log.push(`t=${t.toFixed(1)} lifted boulder, carrying=${sim.player.carrying} :: ${render(sim.getObjective())}`);
    // face the gate then drop
    const dx = gate.x - sim.player.x, dz = gate.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
    sim.player.facing = { x: dx / len, z: dz / len };
    sim.requestInteraction();
    idle(0.3);
    log.push(`t=${t.toFixed(1)} dropped boulder, stage=${stage()}, phase=${sim.phase}, phaseTime=${sim.phaseTime.toFixed(1)} :: ${render(sim.getObjective())}`);
    // now what does it want?
    idle(1);
    log.push(`t=${t.toFixed(1)} stage=${stage()} :: ${render(sim.getObjective())}`);
    // walk to truck
    const before = t;
    goto(world.truck, 4.0);
    log.push(`t=${t.toFixed(1)} reached truck (took ${(t - before).toFixed(1)}s) phase=${sim.phase} :: ${render(sim.getObjective())}`);
    for (const line of log) console.log(line);
  });
});
