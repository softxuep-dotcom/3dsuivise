import terrainHeightfield from "../content/terrainHeightfield.json";
import { clamp, lerp } from "../simulation/geometry";
import type { CampDefinition, Vec2, WorldDefinition } from "../simulation/types";

type TerrainWorld = Pick<WorldDefinition, "terrain">;

interface HeightfieldPayload {
  size: number;
  resolution: number;
  minHeight: number;
  maxHeight: number;
  encoding: "uint16-le-base64";
  data: string;
}

const HEIGHTFIELD = terrainHeightfield as HeightfieldPayload;

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const decodeHeightfield = (): Float32Array => {
  const binary = atob(HEIGHTFIELD.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const values = new Float32Array(binary.length / 2);
  const range = HEIGHTFIELD.maxHeight - HEIGHTFIELD.minHeight;
  for (let index = 0; index < values.length; index += 1) {
    values[index] = HEIGHTFIELD.minHeight + view.getUint16(index * 2, true) / 65535 * range;
  }
  return values;
};

const HEIGHTS = decodeHeightfield();

const hash = (x: number, z: number, seed: number): number => {
  let value = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
};

const valueNoise = (x: number, z: number, seed: number): number => {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = lerp(hash(ix, iz, seed), hash(ix + 1, iz, seed), sx);
  const b = lerp(hash(ix, iz + 1, seed), hash(ix + 1, iz + 1, seed), sx);
  return lerp(a, b, sz) * 2 - 1;
};

export function campLocalToWorld(camp: CampDefinition, local: Vec2): Vec2 {
  const forwardX = Math.cos(camp.entranceAngle);
  const forwardZ = Math.sin(camp.entranceAngle);
  const sideX = -forwardZ;
  const sideZ = forwardX;
  return {
    x: camp.x + sideX * local.x + forwardX * local.z,
    z: camp.z + sideZ * local.x + forwardZ * local.z,
  };
}

export function campGatePosition(camp: CampDefinition): Vec2 {
  return campLocalToWorld(camp, camp.gate);
}

export function distanceToCampApproach(camp: CampDefinition, point: Vec2): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < camp.approach.length - 1; index += 1) {
    const start = campLocalToWorld(camp, camp.approach[index]);
    const end = campLocalToWorld(camp, camp.approach[index + 1]);
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = Math.max(0.0001, dx * dx + dz * dz);
    const amount = clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared, 0, 1);
    best = Math.min(best, Math.hypot(point.x - (start.x + dx * amount), point.z - (start.z + dz * amount)));
  }
  return best;
}

export function terrainHeightAt(_world: TerrainWorld, point: Vec2): number {
  const half = HEIGHTFIELD.size * 0.5;
  const gridX = clamp((point.x + half) / HEIGHTFIELD.size * HEIGHTFIELD.resolution, 0, HEIGHTFIELD.resolution);
  const gridZ = clamp((point.z + half) / HEIGHTFIELD.size * HEIGHTFIELD.resolution, 0, HEIGHTFIELD.resolution);
  const x0 = Math.floor(gridX);
  const z0 = Math.floor(gridZ);
  const x1 = Math.min(HEIGHTFIELD.resolution, x0 + 1);
  const z1 = Math.min(HEIGHTFIELD.resolution, z0 + 1);
  const stride = HEIGHTFIELD.resolution + 1;
  const top = lerp(HEIGHTS[z0 * stride + x0], HEIGHTS[z0 * stride + x1], gridX - x0);
  const bottom = lerp(HEIGHTS[z1 * stride + x0], HEIGHTS[z1 * stride + x1], gridX - x0);
  return lerp(top, bottom, gridZ - z0);
}

export function terrainSlopeAt(world: TerrainWorld, point: Vec2, sampleDistance = 0.7): number {
  const left = terrainHeightAt(world, { x: point.x - sampleDistance, z: point.z });
  const right = terrainHeightAt(world, { x: point.x + sampleDistance, z: point.z });
  const down = terrainHeightAt(world, { x: point.x, z: point.z - sampleDistance });
  const up = terrainHeightAt(world, { x: point.x, z: point.z + sampleDistance });
  return Math.hypot((right - left) / (sampleDistance * 2), (up - down) / (sampleDistance * 2));
}

export function isTerrainWalkable(world: TerrainWorld, point: Vec2): boolean {
  return terrainSlopeAt(world, point) <= world.terrain.maxWalkableSlope;
}

export function terrainMoistureAt(world: TerrainWorld, point: Vec2): number {
  const noise = valueNoise(point.x / 18, point.z / 18, world.terrain.seed + 211) * 0.5 + 0.5;
  const height = terrainHeightAt(world, point);
  return clamp(noise * 0.72 + clamp((1.8 - height) / 7, 0, 0.35), 0, 1);
}

/**
 * 盐碱地覆盖度：低洼、平坦、且噪声允许的地方会泛出白色盐壳。
 * 这一项取代了原先的积雪 —— 同样是"高对比度的白色斑块"，
 * 但分布规律相反：积雪在高处，盐碱在洼地。
 */
export function terrainSaltAt(world: TerrainWorld, point: Vec2): number {
  const height = terrainHeightAt(world, point);
  const slope = terrainSlopeAt(world, point, 1.1);
  const drift = valueNoise(point.x / 13, point.z / 13, world.terrain.seed + 503) * 0.5 + 0.5;
  const basin = 1 - smoothstep(0.5, 4.2, height);
  return clamp(basin * (1 - smoothstep(0.18, 0.55, slope)) * smoothstep(0.52, 0.8, drift), 0, 1);
}
