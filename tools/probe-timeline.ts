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
console.log(`玩家出生 (${sim.player.x.toFixed(1)},${sim.player.z.toFixed(1)}) 离卡车 ${Math.hypot(sim.player.x - w.truck.x, sim.player.z - w.truck.z).toFixed(1)}m`);
console.log(`未动时目标行：${render(sim.getObjective())}\n`);

const STEP = 1 / 20;
let last = "";
// 玩家：一直朝东走（随便动动），只为触发 clockStarted 并让时间流逝
for (let step = 0; step * STEP <= 400; step += 1) {
  const t = step * STEP;
  sim.update(STEP, { x: Math.cos(t * 0.4), z: Math.sin(t * 0.4) });
  if (!sim.running) { console.log(`  t=${t.toFixed(0)}s 结束`); break; }
  const line = render(sim.getObjective());
  if (line !== last) {
    console.log(`  t=${t.toFixed(0)}s 第${sim.day}天 ${sim.phase === "day" ? "昼" : "夜"} 余${sim.phaseTime.toFixed(0)}s | ${line}`);
    last = line;
  }
}
