import { createWorld } from "../src/game/content/createWorld";
import { isTerrainWalkable, terrainSlopeAt, terrainHeightAt, campGatePosition } from "../src/game/terrain/TerrainModel";

const w = createWorld();
const tw = { camps: w.camps, hills: w.hills, terrain: w.terrain };
const start = w.camps[w.startCampId];
const gate = campGatePosition(start);
const d = (a: any, b: any) => Math.hypot(a.x - b.x, a.z - b.z);
const den = w.dens[0];

console.log(`出生营地 camp${w.startCampId} ${start.kind} (${start.x.toFixed(1)},${start.z.toFixed(1)}) r=${start.radius}`);
console.log(`大门 (${gate.x.toFixed(1)},${gate.z.toFixed(1)})`);
console.log(`狗巢 (${den.x.toFixed(1)},${den.z.toFixed(1)}) 离出生营地 ${d(start, den).toFixed(1)}m`);
console.log("");
console.log(`卡车 (${w.truck.x.toFixed(1)},${w.truck.z.toFixed(1)})`);
console.log(`  离大门 ${d(gate, w.truck).toFixed(1)}m · 离营地中心 ${d(start, w.truck).toFixed(1)}m · 离狗巢 ${d(den, w.truck).toFixed(1)}m`);
console.log(`  可走=${isTerrainWalkable(tw as any, w.truck)} 坡度=${terrainSlopeAt(tw as any, w.truck).toFixed(3)} 高度=${terrainHeightAt(tw as any, w.truck).toFixed(2)}`);
console.log(`  发车方向 (${w.truck.exit.x},${w.truck.exit.z})`);
let ok = true;
const limit = Math.abs(w.truck.exit.x) > 0 ? 110 - Math.abs(w.truck.x) : 110 - Math.abs(w.truck.z);
for (let s = 3; s <= limit; s += 6) {
  const p = { x: w.truck.x + w.truck.exit.x * s, z: w.truck.z + w.truck.exit.z * s };
  const walk = isTerrainWalkable(tw as any, p);
  const sl = terrainSlopeAt(tw as any, p);
  if (!walk || sl > 0.5) ok = false;
  console.log(`   +${String(s).padStart(2)}m (${p.x.toFixed(0)},${p.z.toFixed(0)}) 可走=${walk} 坡=${sl.toFixed(3)}${(!walk||sl>0.5)?"  ✗":""}`);
}
console.log(`  出图路径 ${ok ? "全程通畅 ✓" : "有阻塞 ✗"}`);
console.log("");
console.log("九桶汽油离卡车的距离：");
for (const b of w.barrels) {
  console.log(`  #${b.id} ${b.guarded ? "巢边" : "野外"} (${b.x.toFixed(0)},${b.z.toFixed(0)}) → 卡车 ${d(b, w.truck).toFixed(0)}m · 离巢 ${d(b, den).toFixed(0)}m`);
}
