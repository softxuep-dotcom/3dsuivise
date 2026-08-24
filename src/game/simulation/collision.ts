/**
 * 圆形碰撞、分轴推进与视线判定 —— 玩家、狼、猎物共用的一层"物理"。
 *
 * 从 GameSimulation.ts 拆出来。它只认三样东西（地形、地上的实体障碍、玩家放置的
 * 树桩），一条游戏规则都不知道，所以拆得干净：调用方给一个 {@link CollisionWorld}
 * 就行。这些函数之间有几条**必须成对修改**的不变式（见 canStepToward 的注释），
 * 放在同一个文件里正是为了让那几条不变式一眼看得全。
 */
import { clamp, direction, distanceSquared, normalize, segmentIntersectsCircle } from "./geometry";
import { terrainHeightAt, terrainSlopeAt } from "../terrain/TerrainModel";
import { STONE_COLLIDE_RADIUS, STRUCTURE_SPECS, WOLF_RADIUS } from "./types";
import type { GroundItem, PlacedStructure, Vec2, WorldDefinition } from "./types";
import { MOVE_STEP_FALLBACKS } from "./balance";

/** 碰撞需要看到的那一小片世界。GameSimulation 天然满足它。 */
export interface CollisionWorld {
  readonly world: WorldDefinition;
  readonly items: GroundItem[];
  readonly structures: PlacedStructure[];
}

/**
 * 近战必须真的处在同一层地面上。
 *
 * 旧判定只有水平距离，玩家站在巢穴土垄上仍能隔着两三米落差砍到下面的守卫，
 * 守卫却找不到能爬上去的路。高度差与遮挡一起判定后，卡在崖边不再等于无伤输出位。
 */
export function hasMeleeLine(cw: CollisionWorld, start: Vec2, end: Vec2): boolean {
  const heightDelta = Math.abs(terrainHeightAt(cw.world, start) - terrainHeightAt(cw.world, end));
  return heightDelta <= 1.65 && !lineOfSightBlocked(cw, start, end);
}

export function lineOfSightBlocked(cw: CollisionWorld, start: Vec2, end: Vec2): boolean {
  for (const wall of cw.world.walls) {
    if (segmentIntersectsCircle(start, end, wall, wall.radius * 0.82)) return true;
  }
  const startHeight = terrainHeightAt(cw.world, start) + 1.15;
  const endHeight = terrainHeightAt(cw.world, end) + 1.15;
  for (let step = 1; step < 8; step += 1) {
    const t = step / 8;
    const point = { x: start.x + (end.x - start.x) * t, z: start.z + (end.z - start.z) * t };
    const sightHeight = startHeight + (endHeight - startHeight) * t;
    if (terrainHeightAt(cw.world, point) > sightHeight + 0.35) return true;
  }
  for (const item of cw.items) {
    if (isBlockingGroundItem(item)
      && segmentIntersectsCircle(start, end, item, item.kind === "stone" ? 1.48 : 0.65)) return true;
  }
  return false;
}

/**
 * 天然石头从生成时就是实体障碍；枯木只有被玩家放下后才组成路障。
 * `placed` 表示“被玩家布置过”，不能再被误用成“有没有碰撞”。
 */
/**
 * 要让流场绕开的圆形障碍。
 *
 * 只收**天然**石头：它有碰撞却不该被啃（见 findBlockingItem），所以寻路必须自己绕。
 * 玩家布置的路障故意**不**收 —— 那是专门给狗啃的，流场绕开它，布防就白做了。
 *
 * 半径按"狗的圆心能到哪儿"算（石头半径 + 狗半径），这样流场给出的路线
 * 和 resolveCollisions 的判断是同一套，不会出现"寻路说能走、物理说不能"。
 */
export function getFlowFieldObstacles(cw: CollisionWorld): { x: number; z: number; radius: number }[] {
  const out: { x: number; z: number; radius: number }[] = [];
  for (const item of cw.items) {
    if (!isBlockingGroundItem(item) || item.placed) continue;
    out.push({ x: item.x, z: item.z, radius: STONE_COLLIDE_RADIUS + WOLF_RADIUS });
  }
  return out;
}

export function isBlockingGroundItem(item: GroundItem): boolean {
  return item.active && (item.kind === "stone" || item.placed);
}

export function getSteeredDirection(cw: CollisionWorld, entity: Vec2, desired: Vec2): Vec2 {
  let steerX = desired.x;
  let steerZ = desired.z;
  for (const wall of cw.world.walls) {
    const safe = wall.radius + 2.3;
    const value = distanceSquared(entity, wall);
    if (value > safe * safe || value < 0.0001) continue;
    const away = direction(wall, entity);
    const strength = (safe - Math.sqrt(value)) / safe;
    steerX += away.x * strength * 2.6;
    steerZ += away.z * strength * 2.6;
  }
  for (const item of cw.items) {
    if (!isBlockingGroundItem(item) || distanceSquared(entity, item) > 3.2 * 3.2) continue;
    const away = direction(item, entity);
    steerX += away.x * 1.8;
    steerZ += away.z * 1.8;
  }
  return normalize({ x: steerX, z: steerZ });
}

/**
 * 推进单个轴，整步被地形拒绝时退而求其次走半步、四分之一步。
 * 没有这个回退的话，贴着坡沿走会在"整步 0.14m"和"原地不动"之间反复横跳
 * —— 那正是走路发卡的手感。有了回退，玩家会平滑地贴到坡沿再停住。
 */
export function stepAxis(
  cw: CollisionWorld,
  entity: Vec2,
  axis: "x" | "z",
  amount: number,
  radius: number,
  collideWithItems: boolean,
  terrainSlopeAllowance = 1,
): void {
  const origin = entity[axis];
  for (const scale of MOVE_STEP_FALLBACKS) {
    entity[axis] = origin + amount * scale;
    const from = axis === "x" ? { x: origin, z: entity.z } : { x: entity.x, z: origin };
    if (canTraverseTerrain(cw, from, entity, terrainSlopeAllowance)
      && !stepCrossesCollision(cw, from, entity, radius, collideWithItems)) return;
  }
  entity[axis] = origin;
}

export function moveEntity(
  cw: CollisionWorld,
  entity: Vec2,
  dx: number,
  dz: number,
  radius: number,
  collideWithItems: boolean,
  terrainSlopeAllowance = 1,
): void {
  // 分轴推进本身就提供了沿墙滑行：一轴被挡时另一轴仍然生效。
  stepAxis(cw, entity, "x", dx, radius, collideWithItems, terrainSlopeAllowance);
  resolveCollisions(cw, entity, radius, collideWithItems);
  stepAxis(cw, entity, "z", dz, radius, collideWithItems, terrainSlopeAllowance);
  resolveCollisions(cw, entity, radius, collideWithItems);
  const half = cw.world.size / 2 - radius;
  entity.x = clamp(entity.x, -half, half);
  entity.z = clamp(entity.z, -half, half);
}

export function resolveCollisions(cw: CollisionWorld, entity: Vec2, radius: number, collideWithItems: boolean): void {
  for (let pass = 0; pass < 3; pass += 1) {
    for (const obstacle of cw.world.walls) pushOutsideCircle(entity, radius, obstacle, obstacle.radius);
    if (!collideWithItems) continue;
    for (const item of cw.items) {
      if (!isBlockingGroundItem(item)) continue;
      pushOutsideCircle(entity, radius, item, item.kind === "stone" ? STONE_COLLIDE_RADIUS : 0.62);
    }
    for (const structure of cw.structures) {
      if (!structure.active) continue;
      pushOutsideCircle(entity, radius, structure, STRUCTURE_SPECS[structure.kind].radius);
    }
  }
}

/**
 * 连续碰撞：检查这一小步的整条线段，而不只检查落点。
 *
 * 原来的 resolveCollisions 只能修正“走完以后还压在圆里”的情况。如果一步从圆的一侧
 * 走到另一侧，或多个路障依次把实体推出，落点可能已经在圆外，于是完全检测不到。
 * 石头和树桩因此看着有碰撞，快速追击或击退时却能偶发穿过。
 */
export function stepCrossesCollision(cw: CollisionWorld, from: Vec2, to: Vec2, radius: number, collideWithItems: boolean): boolean {
  for (const wall of cw.world.walls) {
    if (stepEntersCircle(from, to, wall, radius + wall.radius)) return true;
  }
  if (!collideWithItems) return false;
  for (const item of cw.items) {
    if (!isBlockingGroundItem(item)) continue;
    const obstacleRadius = item.kind === "stone" ? STONE_COLLIDE_RADIUS : 0.62;
    if (stepEntersCircle(from, to, item, radius + obstacleRadius)) return true;
  }
  for (const structure of cw.structures) {
    if (!structure.active) continue;
    if (stepEntersCircle(from, to, structure, radius + STRUCTURE_SPECS[structure.kind].radius)) return true;
  }
  return false;
}

export function stepEntersCircle(from: Vec2, to: Vec2, obstacle: Vec2, expandedRadius: number): boolean {
  const startDistance = distanceSquared(from, obstacle);
  const endDistance = distanceSquared(to, obstacle);
  const radiusSquared = expandedRadius * expandedRadius;

  // 如果放置物刚好生成在实体脚下，允许实体往外脱离，但不许继续往深处走。
  if (startDistance < radiusSquared - 0.0001) return endDistance < startDistance;

  const moveX = to.x - from.x;
  const moveZ = to.z - from.z;
  const toward = moveX * (obstacle.x - from.x) + moveZ * (obstacle.z - from.z);
  if (toward <= 0) return false;
  return segmentIntersectsCircle(from, to, obstacle, expandedRadius);
}

/**
 * 以 desired 为中心向两侧张开，找第一个迈得动的方向；一圈都不行返回 null。
 * 先试小角度，让它尽量还朝着原来想去的地方走，而不是掉头。
 */
export function findSteppableDirection(cw: CollisionWorld, from: Vec2, desired: Vec2, collideWithItems = true): Vec2 | null {
  const base = Math.atan2(desired.z, desired.x);
  for (const offset of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.4, -2.4, Math.PI]) {
    const angle = base + offset;
    const candidate = { x: Math.cos(angle), z: Math.sin(angle) };
    if (canStepToward(cw, from, candidate, WOLF_RADIUS, collideWithItems)) return candidate;
  }
  return null;
}

/**
 * 沿 dir 迈一步会不会被拒掉。探针取 0.45 米 —— 比一帧的位移长（狗最快约 0.1 米/帧），
 * 这样它在真正贴上障碍之前就已经改道，而不是先撞上去再纠正。
 *
 * **必须和 stepAxis 用同一组判定**，否则整套解卡机制会建立在错误的答案上：
 * findSteppableDirection 问它"这个方向行不行"，它说行，stepAxis 却拒绝，
 * 于是狗每帧都在"找到一个能走的方向"和"走不动"之间空转，站着不动。
 *
 * 这条不变式被破坏过一次：stepAxis 后来加了 stepCrossesCollision（连续碰撞），
 * 这里没跟着加，于是探针只问地形、stepAxis 却还要过碰撞这一关，两边可能给出
 * 相反的答案。补齐是为了让不变式重新成立 —— **但要说清楚：补齐之后，
 * tests/wolfPathing 里那批"狗僵住 143 秒"的失败一条都没变**，所以那个 bug
 * 另有原因，别把这次改动当成它的修复。
 * 改这两个函数中的任何一个，都要同时改另一个。
 */
export function canStepToward(cw: CollisionWorld, from: Vec2, dir: Vec2, radius = WOLF_RADIUS, collideWithItems = true): boolean {
  /*
   * **分轴问**，不要问对角线。
   *
   * moveEntity 是分轴推进的（stepAxis 先走 x 再走 z，一轴被挡另一轴仍然生效，
   * 这正是贴墙滑行的来源）。探针若按对角线问，就会在墙角处答错：对角线方向畅通，
   * 可 x 和 z 各自都会撞角，于是探针说"这个方向能走"、stepAxis 三档 fallback
   * 全被拒，狗一步不动。实测岩壁洞窟外一只巡逻犬就这么定住 10 秒。
   *
   * 只要有一个轴迈得动，moveEntity 就会产生位移 —— 判据必须和它一致。
   */
  const REACH = 0.45;
  const axisClear = (target: Vec2): boolean => canTraverseTerrain(cw, from, target)
    && !stepCrossesCollision(cw, from, target, radius, collideWithItems);
  if (Math.abs(dir.x) > 1e-6 && axisClear({ x: from.x + dir.x * REACH, z: from.z })) return true;
  if (Math.abs(dir.z) > 1e-6 && axisClear({ x: from.x, z: from.z + dir.z * REACH })) return true;
  return false;
}

export function canTraverseTerrain(cw: CollisionWorld, from: Vec2, to: Vec2, terrainSlopeAllowance = 1): boolean {
  const limit = cw.world.terrain.maxWalkableSlope * terrainSlopeAllowance;
  const toSlope = terrainSlopeAt(cw.world, to);
  // 落点坡度是一条**站得住吗**的判据，这里却被拿来当**迈得过去吗**用。
  // 实体已经站在坡度 0.776 的地面上（贴着营地的墙走，被完全不看地形的
  // pushOutsideCircle 推上去的 —— 实测好几只狗被同一堵墙推到同一个坐标后一起定住），
  // 此时它横向挪一步、爬升比只有 0.036，几乎是平着走，却因为落点坡度 0.784
  // 微微过线而被拒；而另一个轴的落点坡度合格、爬升比却有 1.003，同样被拒。
  // 两条判据一边卡一个方向，实体就被钉死在原地，站着看玩家，一整夜不动。
  //
  // 所以：脚下本来就在线上时，只要新落点不比脚下**明显**更陡就放行，让它挪得回去。
  // 爬崖不受影响 —— 那件事从头到尾由下面的 rise/travel 把关，这里一个字没动。
  if (toSlope > limit && toSlope > terrainSlopeAt(cw.world, from) + 0.05) return false;
  const travel = Math.hypot(to.x - from.x, to.z - from.z);
  if (travel < 0.0001) return true;
  const rise = Math.abs(terrainHeightAt(cw.world, to) - terrainHeightAt(cw.world, from));
  return rise / travel <= limit * 1.12;
}

export function pushOutsideCircle(entity: Vec2, radius: number, obstacle: Vec2, obstacleRadius: number): void {
  const dx = entity.x - obstacle.x;
  const dz = entity.z - obstacle.z;
  const minDistance = radius + obstacleRadius;
  const value = dx * dx + dz * dz;
  if (value >= minDistance * minDistance) return;
  const currentDistance = Math.sqrt(value);
  if (currentDistance < 0.0001) {
    entity.x += minDistance;
    return;
  }
  const correction = minDistance - currentDistance;
  entity.x += (dx / currentDistance) * correction;
  entity.z += (dz / currentDistance) * correction;
}
