import type { HillDefinition, Vec2 } from "./types";

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

/**
 * 把 `current` 朝 `target` 转过去，一次最多转 `maxRadians`。
 *
 * 用来给"朝向"装一个转向速率上限。没有它的话，任何**以玩家为原点**算出来的方向
 * （比如猎物的"背对玩家逃"）在贴身距离上都会疯转：玩家 8.2 m/s 从 1 米外擦过去，
 * 那条方向向量一秒能扫过 470°，模型每帧被硬设成新角度，看上去就是在原地甩头。
 */
export function rotateToward(current: Vec2, target: Vec2, maxRadians: number): Vec2 {
  const from = normalize(current);
  const to = normalize(target);
  if (from.x === 0 && from.z === 0) return to;
  if (to.x === 0 && to.z === 0) return from;
  const currentAngle = Math.atan2(from.z, from.x);
  const targetAngle = Math.atan2(to.z, to.x);
  let delta = (targetAngle - currentAngle) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  const step = clamp(delta, -maxRadians, maxRadians);
  const angle = currentAngle + step;
  return { x: Math.cos(angle), z: Math.sin(angle) };
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

export function toEllipseLocal(point: Vec2, ellipse: HillDefinition): Vec2 {
  const dx = point.x - ellipse.x;
  const dz = point.z - ellipse.z;
  const cosine = Math.cos(-ellipse.rotation);
  const sine = Math.sin(-ellipse.rotation);
  return {
    x: dx * cosine - dz * sine,
    z: dx * sine + dz * cosine,
  };
}

export function fromEllipseLocal(point: Vec2, ellipse: HillDefinition): Vec2 {
  const cosine = Math.cos(ellipse.rotation);
  const sine = Math.sin(ellipse.rotation);
  return {
    x: ellipse.x + point.x * cosine - point.z * sine,
    z: ellipse.z + point.x * sine + point.z * cosine,
  };
}

export function pointInEllipse(point: Vec2, ellipse: HillDefinition, padding = 0): boolean {
  const local = toEllipseLocal(point, ellipse);
  const radiusX = Math.max(0.1, ellipse.scaleX * 0.9 + padding);
  const radiusZ = Math.max(0.1, ellipse.scaleZ * 0.9 + padding);
  return (local.x * local.x) / (radiusX * radiusX) + (local.z * local.z) / (radiusZ * radiusZ) < 1;
}

export function segmentIntersectsEllipse(start: Vec2, end: Vec2, ellipse: HillDefinition, padding = 0): boolean {
  const localStart = toEllipseLocal(start, ellipse);
  const localEnd = toEllipseLocal(end, ellipse);
  const radiusX = Math.max(0.1, ellipse.scaleX * 0.9 + padding);
  const radiusZ = Math.max(0.1, ellipse.scaleZ * 0.9 + padding);
  return segmentIntersectsCircle(
    { x: localStart.x / radiusX, z: localStart.z / radiusZ },
    { x: localEnd.x / radiusX, z: localEnd.z / radiusZ },
    { x: 0, z: 0 },
    1,
  );
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
