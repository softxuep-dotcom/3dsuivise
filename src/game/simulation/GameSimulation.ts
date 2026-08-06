import {
  clamp,
  direction,
  distance,
  distanceSquared,
  dot,
  fromEllipseLocal,
  mulberry32,
  normalize,
  pointInEllipse,
  segmentIntersectsCircle,
  segmentIntersectsEllipse,
  TAU,
  toEllipseLocal,
} from "./geometry";
import { NavigationGrid } from "./NavigationGrid";
import type {
  BerryPatch,
  CampDefinition,
  CampState,
  GameEvent,
  GroundItem,
  InteractionHint,
  InventoryItemKind,
  Phase,
  PlayerState,
  Vec2,
  WolfState,
  WorldDefinition,
  WorldDrop,
} from "./types";
import { INVENTORY_CAPACITY, INVENTORY_STACK_LIMITS } from "./types";

const PLAYER_RADIUS = 0.72;
const WOLF_RADIUS = 0.68;
const FIRST_DAY_DURATION = 90;
const FIRST_NIGHT_DURATION = 105;
const LATER_DAY_DURATION = 120;
const SECOND_NIGHT_DURATION = 120;
const LATER_NIGHT_DURATION = 135;
const MAX_WOLVES = 120;
const DROP_LIFETIME = 180;

export class GameSimulation {
  readonly world: WorldDefinition;
  readonly camps: CampState[];
  readonly items: GroundItem[];
  readonly berries: BerryPatch[];
  readonly player: PlayerState;
  readonly wolves: WolfState[] = [];
  readonly drops: WorldDrop[] = [];

  phase: Phase = "day";
  day = 1;
  phaseTime = FIRST_DAY_DURATION;
  elapsed = 0;
  running = false;
  clockStarted = false;

  private readonly random = mulberry32(847331);
  private readonly events: GameEvent[] = [];
  private readonly navigation: NavigationGrid;
  private readonly retreatNavigations: NavigationGrid[];
  private wolfId = 0;
  private dropId = 0;
  private spawnCountdown = 3;
  private spawnedThisNight = 0;
  private navigationCountdown = 0;
  private objectiveStage = 0;
  private gameOverSent = false;

  constructor(world: WorldDefinition) {
    this.world = world;
    this.navigation = new NavigationGrid(world);
    const retreatEdge = world.size / 2 - 0.7;
    this.retreatNavigations = [
      { x: -retreatEdge, z: 0 },
      { x: retreatEdge, z: 0 },
      { x: 0, z: -retreatEdge },
      { x: 0, z: retreatEdge },
    ].map((target) => {
      const navigation = new NavigationGrid(world);
      navigation.rebuild(target);
      return navigation;
    });
    const startCamp = world.camps[world.startCampId];
    this.camps = world.camps.map((camp) => ({ id: camp.id, fuel: camp.id === world.startCampId ? 42 : 0 }));
    this.items = world.initialItems.map((item) => ({ ...item }));
    this.berries = world.initialBerries.map((patch) => ({ ...patch }));
    this.player = {
      x: startCamp.x,
      z: startCamp.z + 1.5,
      facing: { x: 0.7, z: 0.7 },
      health: 100,
      warmth: 85,
      hunger: 82,
      inventory: Array.from({ length: INVENTORY_CAPACITY }, () => null),
      carrying: null,
      hasLeatherCoat: false,
      resting: false,
      idleTime: 0,
      attackCooldown: 0,
      attackFlash: 0,
      hurtFlash: 0,
      kills: 0,
    };
    this.navigation.rebuild(this.player);
  }

  start(): void {
    this.running = true;
    this.events.push({ type: "message", text: "首次移动后开始计时 · 天黑前添柴并封住入口" });
  }

  update(deltaSeconds: number, movement: Vec2): void {
    if (!this.running) return;
    const delta = Math.min(deltaSeconds, 0.05);
    this.player.attackCooldown = Math.max(0, this.player.attackCooldown - delta);
    this.player.attackFlash = Math.max(0, this.player.attackFlash - delta);
    this.player.hurtFlash = Math.max(0, this.player.hurtFlash - delta);
    const isMoving = Math.hypot(movement.x, movement.z) >= 0.08;
    this.updatePlayerMovement(delta, movement, isMoving);
    if (!this.clockStarted) return;

    this.elapsed += delta;
    this.phaseTime -= delta;
    if (!isMoving) this.player.idleTime += delta;
    this.navigationCountdown -= delta;
    if (this.navigationCountdown <= 0) {
      this.navigation.rebuild(this.player);
      this.navigationCountdown = 0.65;
    }

    this.updateNeeds(delta);
    this.updateFires(delta);
    this.updateBerries();
    this.updateDrops();
    this.updateWolves(delta);
    this.updateRest(delta);
    this.updateObjectives();

    if (this.phaseTime <= 0) this.advancePhase();
    if (this.player.health <= 0 && !this.gameOverSent) {
      this.player.health = 0;
      this.setResting(false);
      this.running = false;
      this.gameOverSent = true;
      this.events.push({ type: "game-over" });
    }
  }

  requestInteraction(): void {
    if (!this.running) return;
    this.noteActivity();
    if (this.player.carrying) {
      const nearestCamp = this.findNearestCamp(4.3);
      if (nearestCamp && this.player.carrying === "wood") {
        const campState = this.camps[nearestCamp.id];
        campState.fuel = clamp(campState.fuel + 95, 0, 300);
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
      if (!this.addInventory("berry", 1)) {
        this.events.push({ type: "message", text: "背包已满" });
        return;
      }
      berryPatch.berries -= 1;
      if (berryPatch.berries === 0) berryPatch.regrowAt = this.elapsed + 180;
      this.events.push({ type: "pickup", kind: "berry" });
    }
  }

  requestAttack(): void {
    if (!this.running || this.player.attackCooldown > 0 || this.player.carrying) return;
    this.noteActivity();
    this.player.attackCooldown = 0.5;
    this.player.attackFlash = 0.22;
    this.events.push({ type: "attack" });
    let hit = false;

    for (const wolf of this.wolves) {
      if (wolf.mode === "dead" || distanceSquared(this.player, wolf) > 3.1 * 3.1) continue;
      const towardWolf = direction(this.player, wolf);
      if (dot(this.player.facing, towardWolf) < -0.15) continue;
      const wasRetreating = wolf.mode === "retreating";
      wolf.health -= 38;
      wolf.hurtFlash = 0.18;
      if (wolf.health <= 0) wolf.mode = "dead";
      else if (!wasRetreating) wolf.mode = "chase";
      wolf.lostTimer = 0;
      hit = true;
      this.events.push({ type: "wolf-hit", wolfId: wolf.id });
      if (wolf.health <= 0) this.killWolf(wolf);
    }

    if (this.phase === "night") {
      for (const wolf of this.wolves) {
        if (wolf.mode !== "dead" && distanceSquared(this.player, wolf) < 17 * 17) {
          wolf.mode = "chase";
          wolf.lostTimer = 0;
        }
      }
    }
    if (!hit && this.objectiveStage >= 3) this.events.push({ type: "message", text: "挥空会暴露位置" });
  }

  consumeBerry(): void {
    const slot = this.player.inventory.findIndex((stack) => stack?.kind === "berry");
    if (slot >= 0) this.useInventorySlot(slot);
  }

  useInventorySlot(index: number): void {
    if (!this.running) return;
    const stack = this.player.inventory[index];
    if (!stack) return;
    this.noteActivity();
    if (stack.kind === "berry") {
      if (this.player.hunger >= 99 && this.player.health >= 100) return;
      this.removeFromSlot(index, 1);
      this.player.hunger = clamp(this.player.hunger + 22, 0, 100);
      this.player.health = clamp(this.player.health + 5, 0, 100);
      this.events.push({ type: "eat", kind: "berry" });
      return;
    }
    if (stack.kind === "cooked-meat") {
      if (this.player.hunger >= 99 && this.player.health >= 100) return;
      this.removeFromSlot(index, 1);
      this.player.hunger = clamp(this.player.hunger + 45, 0, 100);
      this.player.health = clamp(this.player.health + 10, 0, 100);
      this.events.push({ type: "eat", kind: "cooked-meat" });
      return;
    }
    if (stack.kind === "raw-meat") {
      if (!this.findNearestLitCamp(4.6)) {
        this.events.push({ type: "message", text: "靠近燃烧的篝火才能烤肉" });
        return;
      }
      this.removeFromSlot(index, 1);
      this.addInventory("cooked-meat", 1);
      this.events.push({ type: "cook" });
      this.events.push({ type: "message", text: "生肉已经烤熟" });
      return;
    }
    this.events.push({ type: "message", text: this.player.hasLeatherCoat ? "已经穿着基础皮衣" : "收集4张狼皮可制作基础皮衣" });
  }

  craftLeatherCoat(): boolean {
    if (!this.running || this.player.hasLeatherCoat) return false;
    if (this.getInventoryCount("wolf-hide") < 4) {
      this.events.push({ type: "message", text: "制作皮衣需要4张狼皮" });
      return false;
    }
    this.noteActivity();
    this.removeInventory("wolf-hide", 4);
    this.player.hasLeatherCoat = true;
    this.events.push({ type: "craft-coat" });
    this.events.push({ type: "message", text: "基础皮衣完成 · 夜间寒冷流失降低30%" });
    return true;
  }

  getInventoryCount(kind: InventoryItemKind): number {
    return this.player.inventory.reduce((total, stack) => total + (stack?.kind === kind ? stack.count : 0), 0);
  }

  getInteractionHint(): InteractionHint {
    if (this.player.carrying) {
      const camp = this.findNearestCamp(4.3);
      if (camp && this.player.carrying === "wood") return { action: "feed", text: "添入圆木 · 篝火延长95秒" };
      return { action: "drop", text: `放下${this.player.carrying === "wood" ? "圆木" : "石块"} · 多件组合才能封口` };
    }
    const item = this.findNearestItem(2.5);
    if (item) return { action: "pickup", text: `双手搬起${item.kind === "wood" ? "圆木" : "石块"}` };
    if (this.findNearestBerry(2.7)) return { action: "berry", text: "采集野果到背包" };
    return { action: "none", text: "" };
  }

  drainEvents(): GameEvent[] {
    return this.events.splice(0, this.events.length);
  }

  getPhaseDuration(): number {
    if (this.phase === "day") return this.day === 1 ? FIRST_DAY_DURATION : LATER_DAY_DURATION;
    if (this.day === 1) return FIRST_NIGHT_DURATION;
    if (this.day === 2) return SECOND_NIGHT_DURATION;
    return LATER_NIGHT_DURATION;
  }

  getDaylight(): number {
    const duration = this.getPhaseDuration();
    const elapsedInPhase = duration - this.phaseTime;
    const fade = 10;
    if (this.phase === "day") {
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
    if (!this.clockStarted) return "移动或拿起圆木，开始第一天";
    if (this.player.resting) return "休息中 · 生命每秒恢复1点";
    if (this.phase === "night") {
      const lit = this.getNearestLitCamp();
      if (!lit) return "找到篝火并添柴，寒冷正在伤害你";
      if (lit.fuel < 25) return "火快灭了：再搬一根圆木";
      return "守住火光；狼死亡会掉落肉和皮";
    }
    const retreatingWolves = this.wolves.filter((wolf) => wolf.mode === "retreating").length;
    if (retreatingWolves > 0) return `天亮了 · ${retreatingWolves}只狼正在撤离`;
    if (!this.player.hasLeatherCoat && this.getInventoryCount("wolf-hide") > 0) return "收集4张狼皮制作基础皮衣";
    if (this.getInventoryCount("berry") === 0) return "搜集圆木、石块与野果";
    return "选择营地，添柴并用多件物资封住入口";
  }

  private updatePlayerMovement(delta: number, rawMovement: Vec2, isMoving: boolean): void {
    if (!isMoving) return;
    this.noteActivity();
    const movement = normalize(rawMovement);
    this.player.facing = movement;
    const carryingPenalty = this.player.carrying === "stone" ? 0.68 : this.player.carrying ? 0.82 : 1;
    const speed = 8.2 * carryingPenalty;
    this.moveEntity(this.player, movement.x * speed * delta, movement.z * speed * delta, PLAYER_RADIUS, true);
  }

  private updateNeeds(delta: number): void {
    this.player.hunger = clamp(this.player.hunger - delta * 0.09, 0, 100);
    const nearFire = this.camps.some((camp) => {
      if (camp.fuel <= 0) return false;
      return distanceSquared(this.player, this.world.camps[camp.id]) < 8.2 * 8.2;
    });
    if (nearFire) {
      this.player.warmth = clamp(this.player.warmth + delta * 5.4, 0, 100);
    } else if (this.phase === "night") {
      const coatMultiplier = this.player.hasLeatherCoat ? 0.7 : 1;
      this.player.warmth = clamp(this.player.warmth - delta * 0.74 * coatMultiplier, 0, 100);
    } else {
      this.player.warmth = clamp(this.player.warmth + delta * 0.32, 0, 100);
    }
    if (this.player.hunger <= 0) this.player.health -= delta * 2.2;
    if (this.player.warmth <= 0) this.player.health -= delta * 4.2;
  }

  private updateRest(delta: number): void {
    const nearbyThreat = this.wolves.some((wolf) => {
      if (wolf.mode === "dead") return false;
      const dangerRadius = wolf.mode === "chase" ? 20 : wolf.mode === "raid" ? 11 : 0;
      return dangerRadius > 0 && distanceSquared(wolf, this.player) < dangerRadius * dangerRadius;
    });
    const temperatureAllowsRest = this.phase === "day" || this.player.warmth > 30;
    const canRest = this.player.idleTime >= 5
      && this.player.health < 100
      && this.player.hunger > 0
      && temperatureAllowsRest
      && !nearbyThreat;
    this.setResting(canRest);
    if (this.player.resting) this.player.health = clamp(this.player.health + delta, 0, 100);
  }

  private setResting(active: boolean): void {
    if (this.player.resting === active) return;
    this.player.resting = active;
    this.events.push({ type: "rest", active });
  }

  private noteActivity(): void {
    this.clockStarted = true;
    this.player.idleTime = 0;
    this.setResting(false);
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

  private updateDrops(): void {
    for (const drop of this.drops) {
      if (!drop.active) continue;
      if (this.elapsed >= drop.expiresAt) {
        drop.active = false;
        continue;
      }
      if (distanceSquared(this.player, drop) > 1.8 * 1.8) continue;
      if (!this.addInventory(drop.kind, drop.count)) continue;
      drop.active = false;
      this.events.push({ type: "pickup", kind: drop.kind });
    }
  }

  private updateWolves(delta: number): void {
    const livingCount = this.wolves.filter((wolf) => wolf.mode !== "dead").length;
    const target = Math.min(72, 42 + (this.day - 1) * 10);
    if (this.phase === "night" && livingCount < MAX_WOLVES && this.spawnedThisNight < target) {
      this.spawnCountdown -= delta;
      if (this.spawnCountdown <= 0) {
        this.spawnWolf();
        this.spawnedThisNight += 1;
        const nightProgress = clamp(1 - this.phaseTime / this.getPhaseDuration(), 0, 1);
        const nightlyPressure = Math.max(0.78, 1 - (this.day - 1) * 0.09);
        const curvedInterval = 0.9 + Math.pow(nightProgress, 0.8) * 4.8;
        this.spawnCountdown = curvedInterval * nightlyPressure * (0.85 + this.random() * 0.3);
      }
    }

    for (const wolf of this.wolves) this.updateWolf(wolf, delta);
    for (let index = this.wolves.length - 1; index >= 0; index -= 1) {
      const wolf = this.wolves[index];
      if (wolf.mode === "dead" && wolf.deathTimer <= 0) this.wolves.splice(index, 1);
      else if (wolf.mode === "retreating" && (
        this.isAtWorldEdge(wolf)
        || wolf.lostTimer >= 34
        || (wolf.lostTimer >= 18 && distanceSquared(wolf, this.player) > 45 * 45)
      )) this.wolves.splice(index, 1);
    }
  }

  private updateWolf(wolf: WolfState, delta: number): void {
    wolf.attackCooldown = Math.max(0, wolf.attackCooldown - delta);
    wolf.hurtFlash = Math.max(0, wolf.hurtFlash - delta);
    if (wolf.mode === "dead") {
      wolf.deathTimer -= delta;
      return;
    }

    if (wolf.mode === "retreating") wolf.lostTimer += delta;
    const canSeePlayer = this.phase === "night" && wolf.mode !== "retreating" && this.wolfCanSeePlayer(wolf);
    if (canSeePlayer) {
      wolf.mode = "chase";
      wolf.lostTimer = 0;
    } else if (wolf.mode === "chase") {
      wolf.lostTimer += delta;
      const beyondLeash = distance(wolf, wolf.anchor) > 38;
      if ((wolf.lostTimer > 4.5 && distance(wolf, this.player) > 13) || beyondLeash) {
        wolf.mode = "patrol";
        wolf.lostTimer = 0;
      }
    }

    let target: Vec2;
    if (wolf.mode === "retreating") {
      target = wolf.anchor;
    } else if (wolf.mode === "entering") {
      target = wolf.anchor;
      if (distanceSquared(wolf, wolf.anchor) < 3 * 3) wolf.mode = wolf.raider ? "raid" : "patrol";
    } else if (wolf.mode === "chase") {
      target = this.player;
    } else if (wolf.mode === "raid") {
      target = this.getRaidTarget(wolf);
      if (distanceSquared(wolf, this.player) < 15 * 15) wolf.mode = "chase";
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
        this.noteActivity();
        this.events.push({ type: "player-hit", amount: damage });
      }
      return;
    }

    let desired = direction(wolf, target);
    if (wolf.mode === "chase" && this.lineOfSightBlocked(wolf, this.player)) desired = this.navigation.directionFrom(wolf);
    if (wolf.mode === "retreating" && this.lineOfSightBlocked(wolf, wolf.anchor)) {
      desired = this.getRetreatNavigation(wolf).directionFrom(wolf);
    }
    const blockingItem = wolf.mode === "retreating" ? null : this.findBlockingItem(wolf, desired);
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
    const pace = wolf.mode === "retreating" ? wolf.speed * 2.25 : wolf.mode === "chase" ? wolf.speed * 1.2 : wolf.speed;
    this.moveEntity(wolf, steered.x * pace * delta, steered.z * pace * delta, WOLF_RADIUS, wolf.mode !== "retreating");
  }

  private beginRetreat(wolf: WolfState): void {
    if (wolf.mode === "dead") return;
    const half = this.world.size / 2 + 2;
    const exits: Vec2[] = [
      { x: -half, z: wolf.z },
      { x: half, z: wolf.z },
      { x: wolf.x, z: -half },
      { x: wolf.x, z: half },
    ];
    wolf.mode = "retreating";
    wolf.anchor = exits.reduce((best, candidate) => (
      distanceSquared(wolf, candidate) < distanceSquared(wolf, best) ? candidate : best
    ));
    wolf.lostTimer = 0;
    wolf.attackCooldown = 0;
  }

  private getRetreatNavigation(wolf: WolfState): NavigationGrid {
    const horizontalExit = Math.abs(wolf.anchor.x) > this.world.size / 2;
    if (horizontalExit) return this.retreatNavigations[wolf.anchor.x < 0 ? 0 : 1];
    return this.retreatNavigations[wolf.anchor.z < 0 ? 2 : 3];
  }

  private isAtWorldEdge(wolf: WolfState): boolean {
    const edge = this.world.size / 2 - WOLF_RADIUS - 1;
    return Math.abs(wolf.x) >= edge || Math.abs(wolf.z) >= edge;
  }

  private killWolf(wolf: WolfState): void {
    if (wolf.dropsCreated) return;
    wolf.dropsCreated = true;
    wolf.mode = "dead";
    wolf.health = 0;
    wolf.deathTimer = 0.8;
    this.player.kills += 1;
    this.createDrop(wolf, "raw-meat", -0.65);
    this.createDrop(wolf, "wolf-hide", 0.65);
    this.events.push({ type: "wolf-killed", wolfId: wolf.id });
  }

  private createDrop(position: Vec2, kind: InventoryItemKind, angleOffset: number): void {
    const angle = Math.atan2(this.player.z - position.z, this.player.x - position.x) + angleOffset;
    const drop: WorldDrop = {
      id: this.dropId++,
      kind,
      count: 1,
      x: position.x + Math.cos(angle) * 0.9,
      z: position.z + Math.sin(angle) * 0.9,
      active: true,
      createdAt: this.elapsed,
      expiresAt: this.elapsed + DROP_LIFETIME,
      burstAngle: angle,
    };
    this.drops.push(drop);
    this.events.push({ type: "loot-drop", kind, dropId: drop.id });
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
    const anchorDistance = 12 + this.random() * 10;
    const raiderChance = Math.min(0.35, 0.16 + (this.day - 1) * 0.06);
    const raider = this.random() < raiderChance;
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
      speed: 3.2 + this.random() * 0.9,
      attackCooldown: this.random(),
      lostTimer: 0,
      hurtFlash: 0,
      deathTimer: 0,
      dropsCreated: false,
    });
  }

  private wolfCanSeePlayer(wolf: WolfState): boolean {
    const maxDistance = wolf.raider ? 17.5 : 14.5;
    if (distanceSquared(wolf, this.player) > maxDistance * maxDistance) return false;
    const towardPlayer = direction(wolf, this.player);
    if (dot(wolf.facing, towardPlayer) < 0.08 && distanceSquared(wolf, this.player) > 5 * 5) return false;
    return !this.lineOfSightBlocked(wolf, this.player);
  }

  private lineOfSightBlocked(start: Vec2, end: Vec2): boolean {
    for (const wall of this.world.walls) {
      if (segmentIntersectsCircle(start, end, wall, wall.radius * 0.82)) return true;
    }
    for (const hill of this.world.hills) {
      if (segmentIntersectsEllipse(start, end, hill, 0.25)) return true;
    }
    for (const item of this.items) {
      if (item.active && item.placed && segmentIntersectsCircle(start, end, item, item.kind === "stone" ? 0.85 : 0.65)) return true;
    }
    return false;
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
    if (!nearest) return this.player;
    const entrance = {
      x: nearest.x + Math.cos(nearest.entranceAngle) * (nearest.radius + 3),
      z: nearest.z + Math.sin(nearest.entranceAngle) * (nearest.radius + 3),
    };
    return distanceSquared(wolf, entrance) > 3.2 * 3.2 ? entrance : nearest;
  }

  private findBlockingItem(wolf: WolfState, desired: Vec2): GroundItem | null {
    let closest: GroundItem | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const item of this.items) {
      if (!item.active || !item.placed) continue;
      const itemDistance = distance(wolf, item);
      if (itemDistance > 2.3) continue;
      if (dot(desired, direction(wolf, item)) < 0.35) continue;
      const clusterSize = this.items.filter((other) => other.active && other.placed && distanceSquared(item, other) < 3.6 * 3.6).length;
      if (clusterSize < 3) continue;
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
    for (const hill of this.world.hills) {
      if (!pointInEllipse(entity, hill, 3.2)) continue;
      const away = direction(hill, entity);
      steerX += away.x * 2.1;
      steerZ += away.z * 2.1;
    }
    for (const item of this.items) {
      if (!item.active || !item.placed || distanceSquared(entity, item) > 3.2 * 3.2) continue;
      const away = direction(item, entity);
      steerX += away.x * 1.8;
      steerZ += away.z * 1.8;
    }
    return normalize({ x: steerX, z: steerZ });
  }

  private advancePhase(): void {
    if (this.phase === "day") {
      this.phase = "night";
      this.phaseTime = this.day === 1 ? FIRST_NIGHT_DURATION : this.day === 2 ? SECOND_NIGHT_DURATION : LATER_NIGHT_DURATION;
      this.spawnCountdown = 0.45;
      this.spawnedThisNight = 0;
      this.objectiveStage = 3;
      this.events.push({ type: "phase", phase: "night", day: this.day });
      this.events.push({ type: "message", text: "狼正从雪原边缘逐只进入" });
      return;
    }
    this.phase = "day";
    this.day += 1;
    this.phaseTime = LATER_DAY_DURATION;
    for (const wolf of this.wolves) this.beginRetreat(wolf);
    this.events.push({ type: "phase", phase: "day", day: this.day });
    this.events.push({ type: "message", text: "天亮了 · 狼群停止攻击并撤向雪原边缘" });
  }

  private updateObjectives(): void {
    if (this.objectiveStage === 0 && this.player.carrying) {
      this.objectiveStage = 1;
      this.events.push({ type: "message", text: "圆木可添柴，也能与其他物资组合成路障" });
    } else if (this.objectiveStage === 1 && this.camps.some((camp) => camp.fuel > 90)) {
      this.objectiveStage = 2;
      this.events.push({ type: "message", text: "火已续上；至少用3件物体组成封锁" });
    }
  }

  private addInventory(kind: InventoryItemKind, count: number): boolean {
    let remaining = count;
    const limit = INVENTORY_STACK_LIMITS[kind];
    for (const stack of this.player.inventory) {
      if (!stack || stack.kind !== kind || stack.count >= limit) continue;
      const amount = Math.min(remaining, limit - stack.count);
      stack.count += amount;
      remaining -= amount;
      if (remaining === 0) return true;
    }
    for (let index = 0; index < this.player.inventory.length; index += 1) {
      if (this.player.inventory[index]) continue;
      const amount = Math.min(remaining, limit);
      this.player.inventory[index] = { kind, count: amount };
      remaining -= amount;
      if (remaining === 0) return true;
    }
    return false;
  }

  private removeInventory(kind: InventoryItemKind, count: number): void {
    let remaining = count;
    for (let index = this.player.inventory.length - 1; index >= 0; index -= 1) {
      const stack = this.player.inventory[index];
      if (!stack || stack.kind !== kind) continue;
      const amount = Math.min(remaining, stack.count);
      this.removeFromSlot(index, amount);
      remaining -= amount;
      if (remaining === 0) return;
    }
  }

  private removeFromSlot(index: number, count: number): void {
    const stack = this.player.inventory[index];
    if (!stack) return;
    stack.count -= count;
    if (stack.count <= 0) this.player.inventory[index] = null;
  }

  private findNearestLitCamp(maxDistance: number): CampDefinition | null {
    const camp = this.findNearestCamp(maxDistance);
    return camp && this.camps[camp.id].fuel > 0 ? camp : null;
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
    item.hp = kind === "stone" ? 95 : 70;
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
    for (let pass = 0; pass < 3; pass += 1) {
      for (const obstacle of this.world.walls) this.pushOutsideCircle(entity, radius, obstacle, obstacle.radius);
      for (const hill of this.world.hills) this.pushOutsideHill(entity, radius, hill);
      if (!collideWithItems) continue;
      for (const item of this.items) {
        if (!item.active || !item.placed) continue;
        this.pushOutsideCircle(entity, radius, item, item.kind === "stone" ? 0.75 : 0.62);
      }
    }
  }

  private pushOutsideCircle(entity: Vec2, radius: number, obstacle: Vec2, obstacleRadius: number): void {
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

  private pushOutsideHill(entity: Vec2, radius: number, hill: WorldDefinition["hills"][number]): void {
    if (!pointInEllipse(entity, hill, radius)) return;
    const local = toEllipseLocal(entity, hill);
    const radiusX = hill.scaleX * 0.9 + radius;
    const radiusZ = hill.scaleZ * 0.9 + radius;
    const normalized = Math.hypot(local.x / radiusX, local.z / radiusZ);
    const fallback: Vec2 = normalized < 0.0001 ? { x: radiusX, z: 0 } : { x: local.x / normalized, z: local.z / normalized };
    const corrected = fromEllipseLocal(fallback, hill);
    entity.x = corrected.x;
    entity.z = corrected.z;
  }
}
