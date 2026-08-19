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
function push(sim: GameSimulation, target: any, stopAt: number, budget: number) {
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

describe("probe 5", () => {
  it("carrying a fuel barrel advances objectiveStage 0 -> 1 and dead-ends the objective line", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    sim.start();
    console.log(`stage at spawn = ${(sim as any).objectiveStage}`);
    // go down the ramp
    const via = camp.approach.map((l) => ({
      x: camp.x + (-Math.sin(camp.entranceAngle)) * l.x + Math.cos(camp.entranceAngle) * l.z,
      z: camp.z + Math.cos(camp.entranceAngle) * l.x + Math.sin(camp.entranceAngle) * l.z,
    }));
    let t = 0;
    for (const node of via) t += push(sim, node, 2.0, 30).secs;
    const barrel = [...world.barrels].sort((a, b) => d(a, sim.player) - d(b, sim.player))[0];
    t += push(sim, barrel, 2.4, 90).secs;
    sim.requestInteraction();
    sim.update(STEP, { x: 0, z: 0 }); sim.drainEvents();
    console.log(`picked up barrel: carrying=${sim.player.carrying}, stage=${(sim as any).objectiveStage}, wood in pack=${sim.getInventoryCount("wood")}`);
    t += push(sim, world.truck, 4.0, 120).secs;
    sim.requestInteraction();
    sim.update(STEP, { x: 0, z: 0 }); sim.drainEvents();
    console.log(`loaded: truck=${sim.truck.loaded}/5, stage=${(sim as any).objectiveStage}, wood=${sim.getInventoryCount("wood")}`);
    console.log(`objective right after loading barrel 1 :: ${render(sim.getObjective())}`);
    // now walk away toward the next barrel and sample the objective
    const next = [...world.barrels].filter((b) => b.id !== barrel.id).sort((a, b) => d(a, sim.player) - d(b, sim.player))[0];
    for (let i = 0; i < 30 * 20; i += 1) {
      const dx = next.x - sim.player.x, dz = next.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
      sim.update(STEP, { x: dx / len, z: dz / len }); t += STEP; sim.drainEvents();
      if (i % 200 === 0) console.log(`  t=+${(i / 20).toFixed(0)}s after loading, phase=${sim.phase}, stage=${(sim as any).objectiveStage} :: ${render(sim.getObjective())}`);
    }
  });

  it("hint flicker between Take and Add fuel while walking wood -> fire", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    sim.start();
    const woods = world.initialItems.filter((i) => i.kind === "wood" && d(i, camp) < 20)
      .sort((a, b) => d(a, sim.player) - d(b, sim.player));
    push(sim, woods[0], 2.3, 20);
    sim.requestInteraction();
    console.log(`took 1 wood, stamina=${sim.player.stamina.toFixed(0)}/100`);
    let lastAction = "";
    for (let i = 0; i < 20 * 20; i += 1) {
      if (d(sim.player, camp) < 0.4) break;
      const dx = camp.x - sim.player.x, dz = camp.z - sim.player.z, len = Math.hypot(dx, dz) || 1;
      sim.update(STEP, { x: dx / len, z: dz / len }); sim.drainEvents();
      const h = sim.getInteractionHint();
      if (h.action !== lastAction) {
        lastAction = h.action;
        console.log(`  at (${sim.player.x.toFixed(1)},${sim.player.z.toFixed(1)}) distCamp=${d(sim.player, camp).toFixed(1)} button="${(en as any)['action.' + h.action]}" prompt=${render(h.text)}`);
      }
    }
  });

  it("camper who lights the fire and stays inside the camp: does warmth hijack the objective?", () => {
    const world = createWorld();
    const sim = new GameSimulation(world);
    const camp = world.camps[world.startCampId];
    sim.start();
    const woods = world.initialItems.filter((i) => i.kind === "wood" && d(i, camp) < 20)
      .sort((a, b) => d(a, sim.player) - d(b, sim.player));
    push(sim, woods[0], 2.3, 20);
    sim.requestInteraction();
    sim.requestInteraction(); // feed from where he stands
    let t = 0;
    console.log(`fire fuel=${sim.camps[camp.id].fuel.toFixed(0)}`);
    for (let i = 0; i < 200 * 20; i += 1) {
      // stand still next to the fire
      sim.update(STEP, { x: 0, z: 0 }); t += STEP; sim.drainEvents();
      if (i % 100 === 0) console.log(`  t=${t.toFixed(0)} phase=${sim.phase} warmth=${sim.player.warmth.toFixed(0)} fireFuel=${sim.camps[camp.id].fuel.toFixed(0)} :: ${render(sim.getObjective())}`);
    }
  });
});
