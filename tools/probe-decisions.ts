import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import { zh } from "../src/i18n/locales/zh";

const w = createWorld();
const d = (a: any, b: any) => Math.hypot(a.x - b.x, a.z - b.z);
const truck = w.truck;

// --- 1. 贪心路线：每趟走离"当前站位"最近的一桶，扛回卡车 ---
const pool = w.barrels.map((b) => ({ ...b }));
let at: { x: number; z: number } = { x: truck.x, z: truck.z };
let walk = 0, carry = 0;
const picked: any[] = [];
for (let trip = 0; trip < 5; trip += 1) {
  let best: any = null;
  for (const b of pool) {
    if (picked.includes(b)) continue;
    const v = d(at, b);
    if (!best || v < best.v) best = { b, v };
  }
  picked.push(best.b);
  const back = d(best.b, truck);
  walk += best.v; carry += back;
  at = { x: truck.x, z: truck.z };
}
console.log("=== 贪心 5 趟（每趟从卡车出发找最近的一桶）===");
picked.forEach((b, i) => console.log(`  第${i + 1}趟 #${b.id} ${b.guarded ? "巢边(有守卫)" : "野外"} 离车 ${d(b, truck).toFixed(0)}m`));
console.log(`  空手走 ${walk.toFixed(0)}m / ${(walk / 8.2).toFixed(0)}s`);
console.log(`  扛桶走 ${carry.toFixed(0)}m / ${(carry / (8.2 * 0.54)).toFixed(0)}s  ← 这段不能攻击、不能捡东西`);
console.log(`  合计 ${(walk + carry).toFixed(0)}m / ${(walk / 8.2 + carry / (8.2 * 0.54)).toFixed(0)}s`);

// --- 2. 目标行在整个流程里说过什么 ---
const sim = new GameSimulation(createWorld());
const inner = sim as any;
const say = (tag: string) => {
  const o = sim.getObjective() as any;
  let s = zh[o.key] ?? o.key;
  for (const [k, v] of Object.entries(o.params ?? {})) {
    const vv = (v as any)?.key ? (zh[(v as any).key] ?? (v as any).key) : v;
    s = s.replace(`{${k}}`, String(vv));
  }
  console.log(`  [${tag}] ${s}`);
};
console.log("\n=== 目标行 ===");
say("开局未动");
inner.clockStarted = true;
say("刚起步");
// 走到巢边桶旁边（守卫仍在）
const guardedBarrel = w.barrels.find((b) => b.guarded)!;
sim.player.x = guardedBarrel.x - 30; sim.player.z = guardedBarrel.z;
say("站在巢边 30m 外");
// 站在起点营地
const start = w.camps[w.startCampId];
sim.player.x = start.x; sim.player.z = start.z;
say("站在出生营地");

// --- 3. 背包与轴的量级 ---
console.log("\n=== 时间尺度 ===");
console.log(`  一趟最短往返（35m 桶）: ${(35 / 8.2 + 35 / 4.43).toFixed(0)}s`);
console.log(`  五趟贪心总步行: ${(walk / 8.2 + carry / (8.2 * 0.54)).toFixed(0)}s`);
console.log(`  首日白天 ${sim.getPhaseDuration()}s`);
