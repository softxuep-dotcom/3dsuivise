import { describe, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import { en } from "../src/i18n/locales/en";

const STEP = 1 / 20;
const d = (a: any, b: any) => Math.hypot(a.x - b.x, a.z - b.z);
function render(text: any): string {
  if (typeof text === "string") return text;
  let out = (en as any)[text.key] ?? `??${text.key}`;
  for (const [k, v] of Object.entries(text.params ?? {})) {
    const value = typeof v === "object" && v && "key" in (v as any) ? ((en as any)[(v as any).key] ?? (v as any).key) : String(v);
    out = out.replaceAll(`{${k}}`, value);
  }
  return `[${text.key}] ${out}`;
}
function push(sim: GameSimulation, target: any, stopAt: number, budget: number): { ok: boolean; secs: number } {
  let secs = 0, last = 1e9, stall = 0;
  for (let i = 0; i < budget * 20; i += 1) {
    if (d(sim.player, target) <= stopAt) return { ok: true, secs };
    const dx = target.x - sim.player.x, dz = target.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
    sim.update(STEP, { x: dx / len, z: dz / len }); secs += STEP; sim.drainEvents();
    const now = d(sim.player, target);
    stall = Math.abs(now - last) < 1e-7 ? stall + 1 : 0; last = now;
    if (stall > 30) return { ok: false, secs };
  }
  return { ok: false, secs };
}

describe("probe 4", () => {
  it("A: player who believes the opening line and walks straight at the truck", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    sim.start();
    console.log(`opening line: ${render(sim.getObjective())}`);
    const r = push(sim, world.truck, 4.0, 120);
    console.log(`  result ok=${r.ok} after ${r.secs.toFixed(1)}s stuck at (${sim.player.x.toFixed(1)},${sim.player.z.toFixed(1)}) still ${d(sim.player, world.truck).toFixed(1)}m from the truck`);
    console.log(`  phase=${sim.phase} phaseTime=${sim.phaseTime.toFixed(1)} :: ${render(sim.getObjective())}`);
  });

  it("B: player who walks straight at the nearest barrel", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    sim.start();
    const barrel = [...world.barrels].sort((a, b) => d(a, sim.player) - d(b, sim.player))[0];
    console.log(`nearest barrel ${d(barrel, sim.player).toFixed(1)}m from spawn`);
    const r = push(sim, barrel, 2.4, 120);
    console.log(`  ok=${r.ok} after ${r.secs.toFixed(1)}s, at (${sim.player.x.toFixed(1)},${sim.player.z.toFixed(1)}), ${d(sim.player, barrel).toFixed(1)}m from the barrel, phase=${sim.phase} :: ${render(sim.getObjective())}`);
  });

  it("C: what the objective says at each of the first 60s for a player who wanders", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    sim.start();
    let t = 0;
    for (let i = 0; i < 60 * 20; i += 1) {
      // wander: slow random-ish walk, never presses Act
      const angle = Math.sin(i * 0.013) * 3.1;
      sim.update(STEP, { x: Math.cos(angle), z: Math.sin(angle) });
      t += STEP;
      for (const e of sim.drainEvents()) {
        if (e.type === "message") console.log(`   t=${t.toFixed(1)} TOAST ${render(e as any)}`);
        if (e.type === "phase") console.log(`   t=${t.toFixed(1)} PHASE BANNER ${(e as any).phase}`);
      }
      if (i % 100 === 0) console.log(`t=${t.toFixed(0)} phase=${sim.phase} :: ${render(sim.getObjective())}`);
    }
  });

  it("D: full one-barrel round trip with perfect pathing", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    sim.start();
    let t = 0;
    const via = camp.approach.map((l) => ({
      x: camp.x + Math.cos(camp.entranceAngle + Math.PI / 2) * 0 + (-Math.sin(camp.entranceAngle)) * l.x + Math.cos(camp.entranceAngle) * l.z,
      z: camp.z + Math.cos(camp.entranceAngle) * l.x + Math.sin(camp.entranceAngle) * l.z,
    }));
    for (const node of via) { const r = push(sim, node, 2.0, 30); t += r.secs; }
    console.log(`t=${t.toFixed(1)} down the ramp at (${sim.player.x.toFixed(1)},${sim.player.z.toFixed(1)}) phase=${sim.phase} :: ${render(sim.getObjective())}`);
    const barrel = [...world.barrels].sort((a, b) => d(a, sim.player) - d(b, sim.player))[0];
    const r1 = push(sim, barrel, 2.4, 90); t += r1.secs;
    console.log(`t=${t.toFixed(1)} at barrel ok=${r1.ok} phase=${sim.phase} day=${sim.day} warmth=${sim.player.warmth.toFixed(0)} :: ${render(sim.getObjective())}`);
    sim.requestInteraction();
    console.log(`   carrying=${sim.player.carrying} hint=${render(sim.getInteractionHint().text)}`);
    const r2 = push(sim, world.truck, 4.0, 180); t += r2.secs;
    console.log(`t=${t.toFixed(1)} at truck ok=${r2.ok} dist=${d(sim.player, world.truck).toFixed(1)} phase=${sim.phase} day=${sim.day} :: ${render(sim.getObjective())}`);
    sim.requestInteraction();
    console.log(`   truck.loaded=${sim.truck.loaded} :: ${render(sim.getObjective())}`);
  });
});
