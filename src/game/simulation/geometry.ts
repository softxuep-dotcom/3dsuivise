import type { Vec2 } from "./types";

export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function distanceSquared(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.sqrt(distanceSquared(a, b));
}

export function normalize(vector: Vec2): Vec2 {
  const length = Math.hypot(vector.x, vector.z);
  if (length < 0.0001) return { x: 0, z: 0 };
  return { x: vector.x / length, z: vector.z / length };
}

export function direction(from: Vec2, to: Vec2): Vec2 {
  return normalize({ x: to.x - from.x, z: to.z - from.z });
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.z * b.z;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function angleDifference(a: number, b: number): number {
  let value = (a - b) % TAU;
  if (value > Math.PI) value -= TAU;
  if (value < -Math.PI) value += TAU;
  return Math.abs(value);
}

export function segmentIntersectsCircle(start: Vec2, end: Vec2, center: Vec2, radius: number): boolean {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < 0.0001) return distanceSquared(start, center) <= radius * radius;
  const t = clamp(((center.x - start.x) * dx + (center.z - start.z) * dz) / lengthSq, 0, 1);
  const nearestX = start.x + dx * t;
  const nearestZ = start.z + dz * t;
  const ox = nearestX - center.x;
  const oz = nearestZ - center.z;
  return ox * ox + oz * oz <= radius * radius;
}

export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}
