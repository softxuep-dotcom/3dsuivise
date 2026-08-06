import { clamp, lerp } from "../simulation/geometry";
import type { CampDefinition, Vec2, WorldDefinition } from "../simulation/types";

type TerrainWorld = Pick<WorldDefinition, "camps" | "hills" | "terrain">;

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

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

const baseHeight = (world: TerrainWorld, x: number, z: number): number => {
  const seed = world.terrain.seed;
  let height = valueNoise(x / 34, z / 34, seed) * 0.72;
  height += valueNoise(x / 16, z / 16, seed + 31) * 0.28;
  height += valueNoise(x / 7.5, z / 7.5, seed + 79) * 0.08;
  for (const ridge of world.hills) {
    const dx = x - ridge.x;
    const dz = z - ridge.z;
    const cosine = Math.cos(-ridge.rotation);
    const sine = Math.sin(-ridge.rotation);
    const localX = dx * cosine - dz * sine;
    const localZ = dx * sine + dz * cosine;
    const q = (localX * localX) / (ridge.scaleX * ridge.scaleX) + (localZ * localZ) / (ridge.scaleZ * ridge.scaleZ);
    if (q >= 1) continue;
    const weight = (1 - q) ** 2;
    height += ridge.height * weight;
  }
  return height;
};

const shapeCamp = (height: number, camp: CampDefinition, x: number, z: number): number => {
  const dx = x - camp.x;
  const dz = z - camp.z;
  const distance = Math.hypot(dx, dz);
  const plateauBlend = 1 - smoothstep(camp.radius - 1.8, camp.radius + 5.8, distance);
  const detail = Math.sin((x + camp.id * 13) * 0.42) * Math.cos((z - camp.id * 7) * 0.37) * 0.035;
  let result = lerp(height, camp.elevation + detail, plateauBlend);

  const angle = Math.atan2(dz, dx);
  let angleDifference = Math.abs((angle - camp.entranceAngle + Math.PI) % (Math.PI * 2) - Math.PI);
  if (angleDifference > Math.PI) angleDifference = Math.PI * 2 - angleDifference;
  const gapEdge = camp.entranceWidth + (camp.kind === "deep-cave" ? 0.3 : 0.42);
  const closedSide = smoothstep(camp.entranceWidth * 0.72, gapEdge, angleDifference);
  const innerRing = smoothstep(camp.radius - 4.8, camp.radius - 0.2, distance);
  const outerRing = 1 - smoothstep(camp.radius + 1.3, camp.radius + 7.2, distance);
  const ring = innerRing * outerRing;
  const backFacing = smoothstep(0.25, 1, (1 - Math.cos(angleDifference)) * 0.5);
  const wallHeight = camp.kind === "deep-cave" ? 5.2 : camp.kind === "windy-ridge" ? 2.4 : 2.75;
  const enclosure = camp.kind === "abandoned-camp" ? 0.48 + backFacing * 0.52 : 1;
  result += ring * closedSide * enclosure * wallHeight;

  const forwardX = Math.cos(camp.entranceAngle);
  const forwardZ = Math.sin(camp.entranceAngle);
  const along = dx * forwardX + dz * forwardZ;
  const across = Math.abs(-dx * forwardZ + dz * forwardX);
  if (along > camp.radius - 4 && along < camp.radius + 22 && across < 6.2) {
    const lane = 1 - smoothstep(3.4, 6.2, across);
    const start = smoothstep(camp.radius - 4, camp.radius + 1, along);
    const end = 1 - smoothstep(camp.radius + 15, camp.radius + 22, along);
    const rampT = smoothstep(camp.radius - 1, camp.radius + 19, along);
    const target = lerp(camp.elevation, height, rampT);
    result = lerp(result, target, lane * start * end);
  }
  return result;
};

export function terrainHeightAt(world: TerrainWorld, point: Vec2): number {
  let height = baseHeight(world, point.x, point.z);
  for (const camp of world.camps) height = shapeCamp(height, camp, point.x, point.z);
  return height;
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

export function terrainSnowAt(world: TerrainWorld, point: Vec2): number {
  const height = terrainHeightAt(world, point);
  const slope = terrainSlopeAt(world, point, 1.1);
  const drift = valueNoise(point.x / 11, point.z / 11, world.terrain.seed + 503) * 0.5 + 0.5;
  const altitude = smoothstep(3.4, 6.2, height);
  return clamp(altitude * (1 - smoothstep(0.38, 0.9, slope)) * smoothstep(0.46, 0.76, drift), 0, 1);
}
