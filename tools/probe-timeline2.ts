import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import { zh } from "../src/i18n/locales/zh";

const render = (o: any): string => {
  let s = zh[o.key] ?? o.key;
  for (const [k, v] of Object.entries(o.params ?? {})) {
    const vv = (v as any)?.key ? (zh[(v as any).key] ?? (v as any).key) : v;
    s = s.replace(`{${k}}`, String(vv));
  }
  return s;
};

const w = createWorld();
const sim = new GameSimulation(w);
sim.start();
const inner = sim as any;
const STEP = 1 / 20;
let last = "";
// "不死玩家"：每步把生存轴补满，只观察目标行随昼夜/阶段怎么走
for (let step = 0; step * STEP <= 600; step += 1) {
  const t = step * STEP;
  sim.update(STEP, { x: Math.cos(t * 0.31), z: Math.sin(t * 0.29) });
  sim.player.water = 90; sim.player.hunger = 85; sim.player.health = 100;
  sim.player.warmth = 45; inner.player.condition = "normal";
  if (!sim.running) { console.log(`  t=${t.toFixed(0)}s 结束`); break; }
  const line = render(sim.getObjective());
  if (line !== last) {
    console.log(`  t=${t.toFixed(0)}s 第${sim.day}天${sim.phase === "day" ? "昼" : "夜"} | ${line}`);
    last = line;
  }
}
console.log(`\n目标行第一次出现"汽油/卡车"的时刻见上。`);

// 出生点附近有什么可捡的
const d = (a: any, b: any) => Math.hypot(a.x - b.x, a.z - b.z);
const sim2 = new GameSimulation(createWorld());
const p = sim2.player;
console.log(`\n出生点 (${p.x.toFixed(0)},${p.z.toFixed(0)})`);
const items = (sim2 as any).items ?? (sim2 as any).world.items ?? [];
console.log(`  地面物件 ${items.length} 个`);
const woods = items.filter((i: any) => i.kind === "wood");
if (woods.length) {
  const near = woods.map((i: any) => d(p, i)).sort((a: number, b: number) => a - b);
  console.log(`  最近三根枯木 ${near.slice(0, 3).map((v: number) => v.toFixed(0)).join(" / ")} m`);
}
const stones = (sim2 as any).world.stones ?? [];
console.log(`  大石 ${stones.length} 个，最近 ${stones.length ? Math.min(...stones.map((s: any) => d(p, s))).toFixed(0) : "-"} m`);
const barrels = w.barrels.map((b) => d(p, b)).sort((a, b) => a - b);
console.log(`  九桶油离出生点：${barrels.map((v) => v.toFixed(0)).join(" / ")} m`);
