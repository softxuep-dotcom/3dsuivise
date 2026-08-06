import {
  clamp,
  direction,
  distance,
  distanceSquared,
  dot,
  mulberry32,
  normalize,
  segmentIntersectsCircle,
  TAU,
} from "./geometry";
import type {
  BerryPatch,
  CampDefinition,
  CampState,
  GameEvent,
  GroundItem,
  InteractionHint,
  Phase,
  PlayerState,
  Vec2,
  WolfState,
  WorldDefinition,
} from "./types";

const PLAYER_RADIUS = 0.72;
const WOLF_RADIUS = 0.68;
const DAY_DURATION = 50;
const LATER_DAY_DURATION = 58;
const NIGHT_DURATION = 78;
const MAX_WOLVES = 120;

export class GameSimulation {
  readonly world: WorldDefinition;
  readonly camps: CampState[];
  readonly items: GroundItem[];
  readonly berries: BerryPatch[];
  readonly player: PlayerState;
  readonly wolves: WolfState[] = [];

  phase: Phase = "day";
  day = 1;
  phaseTime = DAY_DURATION;
  elapsed = 0;
  running = false;

  private readonly random = mulberry32(847331);
  private readonly events: GameEvent[] = [];
  private wolfId = 0;
  private spawnCountdown = 3;
  private objectiveStage = 0;
  private gameOverSent = false;

  constructor(world: WorldDefinition) {
    this.world = world;
    const startCamp = world.camps[world.startCampId];
    this.camps = world.camps.map((camp) => ({ id: camp.id, fuel: camp.id === world.startCampId ? 18 : 0 }));
    this.items = world.initialItems.map((item) => ({ ...item }));
    this.berries = world.initialBerries.map((patch) => ({ ...patch }));
    this.player = {
      x: startCamp.x,
      z: startCamp.z + 1.5,
      facing: { x: 0.7, z: 0.7 },
      health: 100,
      warmth: 85,
      hunger: 82,
      berries: 0,
      carrying: null,
      attackCooldown: 0,
      attackFlash: 0,
      hurtFlash: 0,
      kills: 0,
    };
  }

  start(): void {
    this.running = true;
    this.events.push({ type: "message", text: "天黑前：添柴，并用物资封住入口" });
  }

  update(deltaSeconds: number, movement: Vec2): void {
    if (!this.running) return;
    const delta = Math.min(deltaSeconds, 0.05);
    this.elapsed += delta;
    this.phaseTime -= delta;
    this.player.attackCooldown = Math.max(0, this.player.attackCooldown - delta);
    this.player.attackFlash = Math.max(0, this.player.attackFlash - delta);
    this.player.hurtFlash = Math.max(0, this.player.hurtFlash - delta);

    this.updatePlayerMovement(delta, movement);
    this.updateNeeds(delta);
    this.updateFires(delta);
    this.updateBerries();
    this.updateWolves(delta);
    this.updateObjectives();

    if (this.phaseTime <= 0) this.advancePhase();
    if (this.player.health <= 0 && !this.gameOverSent) {
      this.player.health = 0;
      this.running = false;
      this.gameOverSent = true;
      this.events.push({ type: "game-over" });
    }
  }

  requestInteraction(): void {
    if (!this.running) return;
    if (this.player.carrying) {
      const nearestCamp = this.findNearestCamp(4.3);
      if (nearestCamp && this.player.carrying === "wood") {
        const campState = this.camps[nearestCamp.id];
        campState.fuel = clamp(campState.fuel + 34, 0, 110);
        this.player.carrying = null;
        this.events.push({ type: "feed-fire", campId: nearestCamp.id });
        return;
      }
      this.dropCarriedItem();
      return;
    }

    const item = this.findNearestItem(2.5);
    if (item) {
      this.player.carrying = item.kind;
      item.active = false;
      this.events.push({ type: "pickup", kind: item.kind });
      return;
    }

    const berryPatch = this.findNearestBerry(2.7);
    if (berryPatch) {
      berryPatch.berries -= 1;
      if (berryPatch.berries === 0) berryPatch.regrowAt = this.elapsed + 105;
      this.player.berries += 1;
      this.events.push({ type: "pickup", kind: "berry" });
    }
  }

  requestAttack(): void {
    if (!this.running || this.player.attackCooldown > 0) return;
    this.player.attackCooldown = 0.5;
    this.player.attackFlash = 0.22;
    this.events.push({ type: "attack" });
    let hit = false;

    for (const wolf of this.wolves) {
      if (wolf.mode === "dead" || distanceSquared(this.player, wolf) > 3.1 * 3.1) continue;
      const towardWolf = direction(this.player, wolf);
      if (dot(this.player.facing, towardWolf) < -0.15) continue;
      wolf.health -= 38;
      wolf.hurtFlash = 0.18;
      wolf.mode = wolf.health <= 0 ? "dead" : "chase";
      wolf.lostTimer = 0;
      hit = true;
      this.events.push({ type: "wolf-hit", wolfId: wolf.id });
      if (wolf.health <= 0) {
        wolf.deathTimer = 2.4;
        this.player.kills += 1;
        this.events.push({ type: "wolf-killed", wolfId: wolf.id });
      }
    }

    // An attack is noise: nearby patrols investigate and may acquire the player.
    for (const wolf of this.wolves) {
      if (wolf.mode !== "dead" && distanceSquared(this.player, wolf) < 17 * 17) {
        wolf.mode = "chase";
        wolf.lostTimer = 0;
      }
    }
    if (!hit && this.objectiveStage === 3) this.events.push({ type: "message", text: "挥空会暴露位置" });
  }

  consumeBerry(): void {
    if (!this.running || this.player.berries <= 0 || this.player.hunger >= 99) return;
    this.player.berries -= 1;
    this.player.hunger = clamp(this.player.hunger + 28, 0, 100);
    this.player.health = clamp(this.player.health + 4, 0, 100);
    this.events.push({ type: "eat" });
  }

  getInteractionHint(): InteractionHint {
    if (this.player.carrying) {
      const camp = this.findNearestCamp(4.3);
      if (camp && this.player.carrying === "wood") return { action: "feed", text: "添入木头 · 篝火延长 34 秒" };
      return { action: "drop", text: `放下${this.player.carrying === "wood" ? "木头" : "石块"} · 可封堵入口` };
    }
    const item = this.findNearestItem(2.5);
    if (item) return { action: "pickup", text: `搬起${item.kind === "wood" ? "木头" : "石块"}` };
    if (this.findNearestBerry(2.7)) return { action: "berry", text: "采集野果" };
    return { action: "none", text: "" };
  }

  drainEvents(): GameEvent[] {
    return this.events.splice(0, this.events.length);
  }

  getPhaseDuration(): number {
    return this.phase === "night" ? NIGHT_DURATION : this.day === 1 ? DAY_DURATION : LATER_DAY_DURATION;
  }

  getDaylight(): number {
    const duration = this.getPhaseDuration();
    const elapsedInPhase = duration - this.phaseTime;
    const fade = 8;
    if (this.phase === "day") {
      // The first playable frame must be readable; later dawns still fade in.
      if (this.day === 1) return Math.min(1, this.phaseTime / fade);
      return Math.min(1, this.phaseTime / fade, elapsedInPhase / fade);
    }
    return 1 - Math.min(1, this.phaseTime / fade, elapsedInPhase / fade);
  }

  getNearestLitCamp(): { camp: CampDefinition; fuel: number; distance: number } | null {
    let closest: { camp: CampDefinition; fuel: number; distance: number } | null = null;
    for (const camp of this.world.camps) {
      const fuel = this.camps[camp.id].fuel;
      if (fuel <= 0) continue;
      const campDistance = distance(this.player, camp);
      if (!closest || campDistance < closest.distance) closest = { camp, fuel, distance: campDistance };
    }
    return closest;
  }

  getObjective(): string {
    if (this.phase === "night") {
      const lit = this.getNearestLitCamp();
      if (!lit) return "找到篝火并添柴，寒冷正在伤害你";
      if (lit.fuel < 15) return "火快灭了：再搬一根木头";
      return "守住火光；巡逻狼会被噪声吸引";
    }
    if (this.player.berries === 0) return "搜集木头、石块与野果";
    return "选择营地，添柴并封住唯一入口";
  }

  private updatePlayerMovement(delta: number, rawMovement: Vec2): void {
    const movement = normalize(rawMovement);
    if (Math.hypot(rawMovement.x, rawMovement.z) < 0.08) return;
    this.player.facing = movement;
    const carryingPenalty = this.player.carrying === "stone" ? 0.72 : this.player.carrying ? 0.86 : 1;
    const speed = 8.2 * carryingPenalty;
    this.moveEntity(this.player, movement.x * speed * delta, movement.z * speed * delta, PLAYER_RADIUS, true);
  }

  private updateNeeds(delta: number): void {
    this.player.hunger = clamp(this.player.hunger - delta * 0.15, 0, 100);
    const nearFire = this.camps.some((camp) => {
      if (camp.fuel <= 0) return false;
      const definition = this.world.camps[camp.id];
      return distanceSquared(this.player, definition) < 8.2 * 8.2;
    });

    if (nearFire) {
      this.player.warmth = clamp(this.player.warmth + delta * 5.4, 0, 100);
    } else if (this.phase === "night") {
      this.player.warmth = clamp(this.player.warmth - delta * 1.18, 0, 100);
    } else {
      this.player.warmth = clamp(this.player.warmth + delta * 0.32, 0, 100);
    }

    if (this.player.hunger <= 0) this.player.health -= delta * 2.2;
    if (this.player.warmth <= 0) this.player.health -= delta * 4.2;
    if (this.player.hunger > 60 && this.player.warmth > 65 && this.player.health < 100) {
      this.player.health = clamp(this.player.health + delta * 0.2, 0, 100);
    }
  }

  private updateFires(delta: number): void {
    for (const camp of this.camps) camp.fuel = Math.max(0, camp.fuel - delta);
  }

  private updateBerries(): void {
    for (const patch of this.berries) {
      if (patch.berries === 0 && patch.regrowAt > 0 && this.elapsed >= patch.regrowAt) {
        patch.berries = 2;
        patch.regrowAt = 0;
      }
    }
  }

  private updateWolves(delta: number): void {
    if (this.phase === "night" && this.wolves.filter((wolf) => wolf.mode !== "dead").length < MAX_WOLVES) {
      this.spawnCountdown -= delta;
      if (this.spawnCountdown <= 0) {
        this.spawnWolf();
        const nightProgress = 1 - this.phaseTime / NIGHT_DURATION;
        this.spawnCountdown = 4.1 - nightProgress * 1.8 + this.random() * 1.1;
      }
    }

    for (const wolf of this.wolves) this.updateWolf(wolf, delta);
    for (let index = this.wolves.length - 1; index >= 0; index -= 1) {
      const wolf = this.wolves[index];
      if (wolf.mode === "dead" && wolf.deathTimer <= 0) this.wolves.splice(index, 1);
    }
  }

  private updateWolf(wolf: WolfState, delta: number): void {
    wolf.attackCooldown = Math.max(0, wolf.attackCooldown - delta);
    wolf.hurtFlash = Math.max(0, wolf.hurtFlash - delta);
    if (wolf.mode === "dead") {
      wolf.deathTimer -= delta;
      return;
    }

    const canSeePlayer = this.wolfCanSeePlayer(wolf);
    if (canSeePlayer) {
      wolf.mode = "chase";
      wolf.lostTimer = 0;
    } else if (wolf.mode === "chase") {
      wolf.lostTimer += delta;
      const beyondLeash = distance(wolf, wolf.anchor) > 34;
      if ((wolf.lostTimer > 4.5 && distance(wolf, this.player) > 13) || beyondLeash) {
        wolf.mode = "patrol";
        wolf.lostTimer = 0;
      }
    }

    let target: Vec2;
    if (wolf.mode === "entering") {
      target = wolf.anchor;
      if (distanceSquared(wolf, wolf.anchor) < 3 * 3) wolf.mode = wolf.raider ? "raid" : "patrol";
    } else if (wolf.mode === "chase") {
      target = this.getChaseWaypoint(wolf);
    } else if (wolf.mode === "raid") {
      target = this.getRaidTarget(wolf);
      if (distanceSquared(wolf, this.player) < 13 * 13) wolf.mode = "chase";
    } else {
      wolf.patrolAngle += delta * (0.22 + (wolf.id % 5) * 0.015);
      target = {
        x: wolf.anchor.x + Math.cos(wolf.patrolAngle) * 7,
        z: wolf.anchor.z + Math.sin(wolf.patrolAngle * 0.83) * 5,
      };
    }

    const playerDistance = distance(wolf, this.player);
    if (wolf.mode === "chase" && playerDistance < 1.75) {
      if (wolf.attackCooldown <= 0) {
        wolf.attackCooldown = 1.15;
        const damage = 9 + this.day * 0.65;
        this.player.health -= damage;
        this.player.hurtFlash = 0.3;
        this.events.push({ type: "player-hit", amount: damage });
      }
      return;
    }

    const desired = direction(wolf, target);
    const blockingItem = this.findBlockingItem(wolf, desired);
    if (blockingItem) {
      if (wolf.attackCooldown <= 0) {
        wolf.attackCooldown = 0.95;
        blockingItem.hp -= wolf.raider ? 18 : 13;
        this.events.push({ type: "barrier-hit", itemId: blockingItem.id });
        if (blockingItem.hp <= 0) blockingItem.active = false;
      }
      return;
    }

    const steered = this.getSteeredDirection(wolf, desired);
    wolf.facing = steered;
    const pace = wolf.mode === "chase" ? wolf.speed * 1.2 : wolf.speed;
    this.moveEntity(wolf, steered.x * pace * delta, steered.z * pace * delta, WOLF_RADIUS, false);
  }

  private spawnWolf(): void {
    const half = this.world.size / 2 - 2;
    const side = Math.floor(this.random() * 4);
    const along = (this.random() - 0.5) * (this.world.size - 12);
    const spawn = side === 0 ? { x: -half, z: along }
      : side === 1 ? { x: half, z: along }
      : side === 2 ? { x: along, z: -half }
      : { x: along, z: half };
    const camp = this.world.camps[Math.floor(this.random() * this.world.camps.length)];
    const anchorAngle = this.random() * TAU;
    const anchorDistance = 15 + this.random() * 12;
    const raider = this.random() < 0.19;
    const anchor = {
      x: camp.x + Math.cos(anchorAngle) * anchorDistance,
      z: camp.z + Math.sin(anchorAngle) * anchorDistance,
    };
    this.wolves.push({
      id: this.wolfId++,
      ...spawn,
      facing: direction(spawn, anchor),
      health: 72,
      mode: raider ? "raid" : "entering",
      raider,
      anchor,
      patrolAngle: this.random() * TAU,
      speed: 3.1 + this.random() * 0.8,
      attackCooldown: this.random(),
      lostTimer: 0,
      hurtFlash: 0,
      deathTimer: 0,
    });
  }

  private wolfCanSeePlayer(wolf: WolfState): boolean {
    const maxDistance = wolf.raider ? 16.5 : 13.5;
    if (distanceSquared(wolf, this.player) > maxDistance * maxDistance) return false;
    const towardPlayer = direction(wolf, this.player);
    if (dot(wolf.facing, towardPlayer) < 0.08 && distanceSquared(wolf, this.player) > 5 * 5) return false;
    return !this.lineOfSightBlocked(wolf, this.player);
  }

  private lineOfSightBlocked(start: Vec2, end: Vec2): boolean {
    for (const wall of this.world.walls) {
      if (segmentIntersectsCircle(start, end, wall, wall.radius * 0.82)) return true;
    }
    for (const item of this.items) {
      if (item.active && item.placed && segmentIntersectsCircle(start, end, item, item.kind === "stone" ? 0.85 : 0.65)) return true;
    }
    return false;
  }

  private getChaseWaypoint(wolf: WolfState): Vec2 {
    const shelter = this.world.camps.find((camp) => distanceSquared(this.player, camp) < 8.8 * 8.8);
    if (!shelter || distanceSquared(wolf, shelter) < 10.2 * 10.2) return this.player;
    const entrance = {
      x: shelter.x + Math.cos(shelter.entranceAngle) * 13.2,
      z: shelter.z + Math.sin(shelter.entranceAngle) * 13.2,
    };
    if (distanceSquared(wolf, entrance) < 3.2 * 3.2) return this.player;
    return entrance;
  }

  private getRaidTarget(wolf: WolfState): Vec2 {
    let nearest: CampDefinition | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const camp of this.world.camps) {
      if (this.camps[camp.id].fuel <= 0) continue;
      const value = distanceSquared(wolf, camp);
      if (value < nearestDistance) {
        nearest = camp;
        nearestDistance = value;
      }
    }
    return nearest ?? this.player;
  }

  private findBlockingItem(wolf: WolfState, desired: Vec2): GroundItem | null {
    let closest: GroundItem | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const item of this.items) {
      if (!item.active || !item.placed) continue;
      const itemDistance = distance(wolf, item);
      if (itemDistance > 2.25) continue;
      const towardItem = direction(wolf, item);
      if (dot(desired, towardItem) < 0.4) continue;
      if (itemDistance < closestDistance) {
        closest = item;
        closestDistance = itemDistance;
      }
    }
    return closest;
  }

  private getSteeredDirection(entity: Vec2, desired: Vec2): Vec2 {
    let steerX = desired.x;
    let steerZ = desired.z;
    for (const wall of this.world.walls) {
      const safe = wall.radius + 2.3;
      const value = distanceSquared(entity, wall);
      if (value > safe * safe || value < 0.0001) continue;
      const away = direction(wall, entity);
      const strength = (safe - Math.sqrt(value)) / safe;
      steerX += away.x * strength * 2.6;
      steerZ += away.z * strength * 2.6;
    }
    return normalize({ x: steerX, z: steerZ });
  }

  private advancePhase(): void {
    if (this.phase === "day") {
      this.phase = "night";
      this.phaseTime = NIGHT_DURATION;
      this.spawnCountdown = 2.5;
      this.objectiveStage = 3;
      this.events.push({ type: "phase", phase: "night", day: this.day });
      this.events.push({ type: "message", text: "狼正从雪原边缘逐只进入" });
      return;
    }

    this.phase = "day";
    this.day += 1;
    this.phaseTime = LATER_DAY_DURATION;
    this.events.push({ type: "phase", phase: "day", day: this.day });
    this.events.push({ type: "message", text: "天亮了，但昨夜的狼仍留在地图上" });
  }

  private updateObjectives(): void {
    if (this.objectiveStage === 0 && this.player.carrying) {
      this.objectiveStage = 1;
      this.events.push({ type: "message", text: "把木头送进篝火，或放在入口当路障" });
    } else if (this.objectiveStage === 1 && this.camps.some((camp) => camp.fuel > 30)) {
      this.objectiveStage = 2;
      this.events.push({ type: "message", text: "火已续上；再搬石块封住入口" });
    }
  }

  private findNearestCamp(maxDistance: number): CampDefinition | null {
    let nearest: CampDefinition | null = null;
    let best = maxDistance * maxDistance;
    for (const camp of this.world.camps) {
      const value = distanceSquared(this.player, camp);
      if (value < best) {
        nearest = camp;
        best = value;
      }
    }
    return nearest;
  }

  private findNearestItem(maxDistance: number): GroundItem | null {
    let nearest: GroundItem | null = null;
    let best = maxDistance * maxDistance;
    for (const item of this.items) {
      if (!item.active) continue;
      const value = distanceSquared(this.player, item);
      if (value < best) {
        nearest = item;
        best = value;
      }
    }
    return nearest;
  }

  private findNearestBerry(maxDistance: number): BerryPatch | null {
    let nearest: BerryPatch | null = null;
    let best = maxDistance * maxDistance;
    for (const patch of this.berries) {
      if (patch.berries <= 0) continue;
      const value = distanceSquared(this.player, patch);
      if (value < best) {
        nearest = patch;
        best = value;
      }
    }
    return nearest;
  }

  private dropCarriedItem(): void {
    const kind = this.player.carrying;
    if (!kind) return;
    const dropPosition = {
      x: this.player.x + this.player.facing.x * 2.05,
      z: this.player.z + this.player.facing.z * 2.05,
    };
    const existing = this.items.find((item) => !item.active);
    const item: GroundItem = existing ?? {
      id: this.items.length,
      x: dropPosition.x,
      z: dropPosition.z,
      kind,
      hp: 1,
      placed: true,
      active: true,
      rotation: Math.atan2(this.player.facing.z, this.player.facing.x),
    };
    item.x = dropPosition.x;
    item.z = dropPosition.z;
    item.kind = kind;
    item.hp = kind === "stone" ? 130 : 70;
    item.placed = true;
    item.active = true;
    item.rotation = Math.atan2(this.player.facing.z, this.player.facing.x);
    if (!existing) this.items.push(item);
    this.player.carrying = null;
    this.events.push({ type: "drop", kind });
  }

  private moveEntity(entity: Vec2, dx: number, dz: number, radius: number, collideWithItems: boolean): void {
    entity.x += dx;
    this.resolveCollisions(entity, radius, collideWithItems);
    entity.z += dz;
    this.resolveCollisions(entity, radius, collideWithItems);
    const half = this.world.size / 2 - radius;
    entity.x = clamp(entity.x, -half, half);
    entity.z = clamp(entity.z, -half, half);
  }

  private resolveCollisions(entity: Vec2, radius: number, collideWithItems: boolean): void {
    for (let pass = 0; pass < 2; pass += 1) {
      for (const obstacle of this.world.walls) this.pushOutside(entity, radius, obstacle, obstacle.radius);
      if (!collideWithItems) continue;
      for (const item of this.items) {
        if (!item.active || !item.placed) continue;
        this.pushOutside(entity, radius, item, item.kind === "stone" ? 0.9 : 0.72);
      }
    }
  }

  private pushOutside(entity: Vec2, radius: number, obstacle: Vec2, obstacleRadius: number): void {
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
}
