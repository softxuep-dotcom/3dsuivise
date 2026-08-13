/**
 * 生成地形俯视图（SVG）。
 *
 * 直接调用游戏自己的 createWorld() 与 terrainHeightAt()，所以图上画的
 * 就是玩家实际会跑进去的那张地图 —— 不是手绘示意，改了蓝图重跑就能更新。
 *
 *   npx tsx tools/draw-map.ts > docs/terrain-map.svg
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createWorld } from "../src/game/content/createWorld";
import { campGatePosition, terrainHeightAt, terrainSlopeAt } from "../src/game/terrain/TerrainModel";

/**
 * 最小 PNG 编码器。
 * 地形层如果用 SVG 的 <rect> 逐格画，150×150 就是 22500 个节点、1.8 MB ——
 * 编码成一张内嵌 PNG 之后同样的分辨率只要几十 KB。
 */
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    rgb.subarray(y * width * 3, (y + 1) * width * 3).forEach((v, i) => {
      raw[y * (width * 3 + 1) + 1 + i] = v;
    });
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const world = createWorld();
const terrainWorld = { camps: world.camps, hills: world.hills, terrain: world.terrain } as never;
const half = world.size / 2;

const PX = 900;                       // 画布边长
const PAD = 54;                       // 四周留白，放坐标轴与图例
const SPAN = PX - PAD * 2;
const toX = (x: number): number => PAD + ((x + half) / world.size) * SPAN;
const toY = (z: number): number => PAD + ((z + half) / world.size) * SPAN;
const f = (n: number): string => n.toFixed(1);

// --- 高度场采样（同时用于 PNG 底图与等高线） ---
const GRID = 440;                     // PNG 分辨率
const CONTOUR_GRID = 150;             // 等高线用较粗的网格，够看又不至于抖
const heights: number[][] = [];
let lo = Infinity;
let hi = -Infinity;
for (let row = 0; row < GRID; row += 1) {
  heights[row] = [];
  for (let col = 0; col < GRID; col += 1) {
    const x = -half + (col / (GRID - 1)) * world.size;
    const z = -half + (row / (GRID - 1)) * world.size;
    const h = terrainHeightAt(terrainWorld, { x, z });
    heights[row][col] = h;
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
}

/** 沙色 → 岩色的分段渐变，低洼偏灰、高地偏亮。 */
function shade(h: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (h - lo) / Math.max(0.001, hi - lo)));
  const stops: Array<[number, [number, number, number]]> = [
    [0.00, [104, 92, 74]],
    [0.35, [168, 141, 96]],
    [0.62, [203, 173, 114]],
    [0.82, [223, 199, 151]],
    [1.00, [246, 233, 202]],
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const k = (t - a[0]) / Math.max(0.0001, b[0] - a[0]);
  return a[1].map((v, i) => Math.round(v + (b[1][i] - v) * k)) as [number, number, number];
}

// 底图：高度着色 + 西北向山体阴影（让高地的形状读得出来），陡坡压暗。
const pixels = new Uint8Array(GRID * GRID * 3);
for (let row = 0; row < GRID; row += 1) {
  for (let col = 0; col < GRID; col += 1) {
    const h = heights[row][col];
    let [r, g, b] = shade(h);
    const hx = heights[row][Math.min(GRID - 1, col + 1)] - heights[row][Math.max(0, col - 1)];
    const hz = heights[Math.min(GRID - 1, row + 1)][col] - heights[Math.max(0, row - 1)][col];
    // 光从西北来：坡朝光则亮，背光则暗。
    const lightness = 1 + Math.max(-0.5, Math.min(0.5, (-hx - hz) * 0.55));
    const x = -half + (col / (GRID - 1)) * world.size;
    const z = -half + (row / (GRID - 1)) * world.size;
    const steep = terrainSlopeAt(terrainWorld, { x, z }) > world.terrain.maxWalkableSlope;
    const k = lightness * (steep ? 0.62 : 1);
    const o = (row * GRID + col) * 3;
    pixels[o] = Math.max(0, Math.min(255, Math.round(r * k)));
    pixels[o + 1] = Math.max(0, Math.min(255, Math.round(g * k)));
    pixels[o + 2] = Math.max(0, Math.min(255, Math.round(b * k)));
  }
}
const basePng = encodePng(GRID, GRID, pixels).toString("base64");

const out: string[] = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${PX}" height="${PX}" viewBox="0 0 ${PX} ${PX}" font-family="ui-sans-serif,system-ui,'PingFang SC','Microsoft YaHei',sans-serif">`);
out.push(`<rect width="${PX}" height="${PX}" fill="#14100b"/>`);

// --- 地形底图 ---
out.push(`<image x="${PAD}" y="${PAD}" width="${SPAN}" height="${SPAN}" href="data:image/png;base64,${basePng}" style="image-rendering:auto"/>`);

// --- 等高线：把"高地"真正画出来，而不是只靠明暗 ---
const cCell = SPAN / (CONTOUR_GRID - 1);
const sampleH = (row: number, col: number): number => {
  const r = Math.round((row / (CONTOUR_GRID - 1)) * (GRID - 1));
  const c = Math.round((col / (CONTOUR_GRID - 1)) * (GRID - 1));
  return heights[r][c];
};
out.push(`<g fill="none" stroke="rgba(48,34,18,.40)" stroke-width="1">`);
for (const level of [2, 4, 6, 8, 10, 11.5]) {
  const segs: string[] = [];
  for (let row = 0; row < CONTOUR_GRID - 1; row += 1) {
    for (let col = 0; col < CONTOUR_GRID - 1; col += 1) {
      const a = sampleH(row, col);
      const b = sampleH(row, col + 1);
      const c = sampleH(row + 1, col);
      const x = PAD + (col / (CONTOUR_GRID - 1)) * SPAN;
      const y = PAD + (row / (CONTOUR_GRID - 1)) * SPAN;
      if ((a - level) * (b - level) < 0) segs.push(`M${f(x + cCell / 2)} ${f(y)}v${f(cCell)}`);
      if ((a - level) * (c - level) < 0) segs.push(`M${f(x)} ${f(y + cCell / 2)}h${f(cCell)}`);
    }
  }
  out.push(`<path d="${segs.join("")}"/>`);
}
out.push(`</g>`);

const label = (x: number, y: number, text: string, color: string, size = 13, weight = 700, anchor = "middle"): string =>
  `<text x="${f(x)}" y="${f(y)}" fill="${color}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"
     paint-order="stroke" stroke="rgba(12,9,5,.85)" stroke-width="3.4" stroke-linejoin="round">${text}</text>`;

// --- 水井 ---
for (const well of world.wells) {
  out.push(`<circle cx="${f(toX(well.x))}" cy="${f(toY(well.z))}" r="5" fill="#3f8fb8" stroke="#0e1a22" stroke-width="1.6"/>`);
}

// --- 铁矿 ---
for (const node of world.ironNodes) {
  out.push(`<rect x="${f(toX(node.x) - 3)}" y="${f(toY(node.z) - 3)}" width="6" height="6" fill="#9a6a3c" stroke="#2a1a0c" stroke-width="1.2"/>`);
}

// --- 营地 ---
for (const camp of world.camps) {
  const isStart = camp.id === world.startCampId;
  const gate = campGatePosition(camp);
  const r = (camp.radius / world.size) * SPAN;
  out.push(`<circle cx="${f(toX(camp.x))}" cy="${f(toY(camp.z))}" r="${f(r)}"
    fill="${isStart ? "rgba(120,200,140,.20)" : "rgba(240,220,170,.13)"}"
    stroke="${isStart ? "#7ee08c" : "#e6cd9a"}" stroke-width="${isStart ? 2.6 : 1.7}"/>`);
  // 大门方向的短线：一眼看出"出门往哪走"
  out.push(`<line x1="${f(toX(camp.x))}" y1="${f(toY(camp.z))}" x2="${f(toX(gate.x))}" y2="${f(toY(gate.z))}"
    stroke="${isStart ? "#7ee08c" : "#e6cd9a"}" stroke-width="2.2" stroke-linecap="round"/>`);
  out.push(`<circle cx="${f(toX(gate.x))}" cy="${f(toY(gate.z))}" r="3" fill="${isStart ? "#7ee08c" : "#e6cd9a"}"/>`);
  const name = `${isStart ? "★ " : ""}camp${camp.id} ${camp.kind}`;
  out.push(label(toX(camp.x), toY(camp.z) - r - 7, name, isStart ? "#a8f0b4" : "#f2e2bd", 12));
  out.push(label(toX(camp.x), toY(camp.z) + 4, `h${camp.elevation.toFixed(1)}`, "rgba(255,255,255,.62)", 10, 600));
}

// --- 狗巢 ---
for (const den of world.dens) {
  const r = (den.radius / world.size) * SPAN;
  out.push(`<circle cx="${f(toX(den.x))}" cy="${f(toY(den.z))}" r="${f(r)}" fill="rgba(220,60,44,.22)" stroke="#e2503c" stroke-width="2.6"/>`);
  out.push(`<line x1="${f(toX(den.x))}" y1="${f(toY(den.z))}" x2="${f(toX(den.mouth.x))}" y2="${f(toY(den.mouth.z))}" stroke="#e2503c" stroke-width="2.4"/>`);
  out.push(label(toX(den.x), toY(den.z) - r - 8, "狗巢 DEN", "#ff8b78", 14));
  out.push(label(toX(den.x), toY(den.z) + r + 16, "巢口", "#ff8b78", 10, 600));
}

// --- 汽油桶 ---
for (const barrel of world.barrels) {
  const color = barrel.guarded ? "#ff6a4d" : "#ffd166";
  out.push(`<circle cx="${f(toX(barrel.x))}" cy="${f(toY(barrel.z))}" r="4.6" fill="${color}" stroke="#2a1a0c" stroke-width="1.4"/>`);
}

// --- 卡车 ---
const tx = toX(world.truck.x);
const ty = toY(world.truck.z);
out.push(`<rect x="${f(tx - 8)}" y="${f(ty - 6)}" width="16" height="12" rx="2" fill="#63d0e8" stroke="#0d1e26" stroke-width="2"/>`);
out.push(`<line x1="${f(tx)}" y1="${f(ty)}" x2="${f(tx + world.truck.exit.x * 40)}" y2="${f(ty + world.truck.exit.z * 40)}"
  stroke="#63d0e8" stroke-width="3" stroke-dasharray="6 4" marker-end="url(#arrow)"/>`);
out.push(label(tx, ty - 13, "卡车 · 通关点", "#a8ecfb", 13));

// --- 玩家出生点 ---
const startCamp = world.camps[world.startCampId];
const startGate = campGatePosition(startCamp);
const len = Math.hypot(startGate.x - startCamp.x, startGate.z - startCamp.z) || 1;
const sx = startCamp.x + ((startGate.x - startCamp.x) / len) * 1.5;
const sz = startCamp.z + ((startGate.z - startCamp.z) / len) * 1.5;
out.push(`<circle cx="${f(toX(sx))}" cy="${f(toY(sz))}" r="4" fill="#ffffff" stroke="#1d3a24" stroke-width="2"/>`);

out.push(`<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
  <path d="M0 0 L9 4.5 L0 9 z" fill="#63d0e8"/></marker></defs>`);

// --- 边框与刻度 ---
out.push(`<rect x="${PAD}" y="${PAD}" width="${SPAN}" height="${SPAN}" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1.5"/>`);
for (const v of [-100, -50, 0, 50, 100]) {
  out.push(label(toX(v), PAD - 9, String(v), "rgba(255,255,255,.5)", 11, 600));
  out.push(label(PAD - 14, toY(v) + 4, String(v), "rgba(255,255,255,.5)", 11, 600, "end"));
}
out.push(label(PX / 2, 26, `荒漠幸存者 · 地形图  ${world.size}×${world.size}m   高度 ${lo.toFixed(1)} ~ ${hi.toFixed(1)}m`, "#f6ecd8", 17, 800));
out.push(label(PX / 2, PX - 26,
  "★出生营地　●井　■铁矿　●野外油桶　●巢边油桶（有守卫）　▬卡车　·陡坡不可走　细线=等高线 4/6/8/10/11.5m",
  "rgba(255,255,255,.66)", 11, 600));
out.push(`</svg>`);

writeFileSync("docs/terrain-map.svg", out.join("\n"), "utf8");

// --- 同时把关键距离打到控制台，便于核对 ---
const d = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
console.log(`地图 ${world.size}×${world.size}m，高度 ${lo.toFixed(2)} ~ ${hi.toFixed(2)}m`);
console.log(`出生 camp${world.startCampId} → 卡车 ${d(startCamp, world.truck).toFixed(0)}m · → 狗巢 ${d(startCamp, world.dens[0]).toFixed(0)}m`);
console.log(`写入 docs/terrain-map.svg`);
