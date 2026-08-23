import { clamp, direction, distanceSquared, dot } from "./geometry";
import { BARRIER_STATS, FUEL_REQUIRED } from "./types";
import type {
  CampDefinition,
  CampState,
  CritterState,
  FuelBarrelState,
  GameEvent,
  GroundItem,
  PlayerState,
  ThrownStone,
  Vec2,
  WolfState,
} from "./types";

/**
 * 投射物与双手战斗系统能看到的最小世界接口。
 *
 * 状态归属刻意分成两类：
 * - 玩家、狼、猎物、油桶、掉落石头仍是整局可保存的模拟状态，由 GameSimulation 提供；
 * - 正抓着谁、哪些物体正在飞、飞了多远，只对本系统有意义，由本类自己拥有。
 *
 * 渲染层只读取最终实体位置与 thrownStones，不参与命中、爆炸预算或击杀结算。
 */
export interface ProjectileCarriedCombatWorld {
  readonly player: PlayerState;
  readonly wolves: WolfState[];
  readonly critters: CritterState[];
  readonly barrels: FuelBarrelState[];
  readonly items: GroundItem[];
  readonly camps: CampState[];
  readonly campDefinitions: readonly CampDefinition[];
  random(): number;
  emit(event: GameEvent): void;
  noteActivity(): void;
  getConditionCooldownScale(): number;
  damagePlayer(amount: number, attacker: WolfState): void;
  killWolf(wolf: WolfState): void;
  knockbackWolf(wolf: WolfState, knockback: number, stun: number): void;
  killCritter(critter: CritterState): void;
}

const BARREL_BLAST_TRIGGER = 2.6;
const BARREL_BLAST_RADIUS = 5.0;
const BARREL_BLAST_DAMAGE = 95;
const BARREL_BLAST_EDGE_SCALE = 0.4;
const BARREL_BLAST_KNOCKBACK = 3.0;
const BARREL_BLAST_STUN = 1.1;
const BARREL_BLAST_FIRE_BONUS = 95;

const BARREL_THROW_RANGE = 6;
const BARREL_THROW_SPEED = 11;
const BARREL_HIT_RADIUS = 1.05;
const BARREL_THROW_DAMAGE = 30;
const BARREL_KNOCKBACK = 2.4;
const BARREL_KNOCKBACK_STUN = 0.9;

const GRAB_REACH = 2.2;
const GRAB_HEALTH_FRACTION = 0.35;
const GRAB_STRUGGLE_DPS = 6;
const BEAST_THROW_RANGE = 7;
const BEAST_THROW_SPEED = 13;
const BEAST_HIT_RADIUS = 1.15;
const BEAST_IMPACT_DAMAGE = 45;
const BEAST_SELF_DAMAGE = 35;
const BEAST_LAND_STUN = 1.4;

const STONE_THROW_RANGE = 9;
const STONE_THROW_SPEED = 15;
const STONE_THROW_DAMAGE = 60;
const STONE_HIT_RADIUS = 0.95;
const STONE_KNOCKBACK = 1.6;
const STONE_KNOCKBACK_STUN = 0.6;
const THROW_COOLDOWN = 0.75;

interface WolfFlight {
  wolf: WolfState;
  dirX: number;
  dirZ: number;
  travelled: number;
}

interface BarrelFlight {
  barrel: FuelBarrelState;
  dirX: number;
  dirZ: number;
  travelled: number;
}

export class ProjectileCarriedCombatSystem {
  /** 用过的槽位保留复用，渲染层按 active 找本帧真正飞着的石头。 */
  readonly thrownStones: ThrownStone[] = [];
  private carriedWolf: WolfState | null = null;
  private carriedBarrel: FuelBarrelState | null = null;
  private readonly thrownWolves: WolfFlight[] = [];
  private readonly thrownBarrels: BarrelFlight[] = [];

  constructor(private readonly world: ProjectileCarriedCombatWorld) {}

  get hasCarriedBarrel(): boolean {
    return this.carriedBarrel !== null;
  }

  /**
   * 还能安全炸几桶。
   *
   * loaded 桶仍留在 barrels 数组、placement = loaded，所以只要数“不是 spent 的桶”
   * 就得到本局还可用于通关的总量。这个数减去 FUEL_REQUIRED 才是爆炸预算。
   */
  getFuelBlastBudget(): number {
    const deliverable = this.world.barrels.filter((barrel) => barrel.placement !== "spent").length;
    return Math.max(0, deliverable - FUEL_REQUIRED);
  }

  pickupBarrel(barrel: FuelBarrelState): void {
    barrel.placement = "carried";
    this.carriedBarrel = barrel;
    this.world.player.carrying = "fuel";
    this.world.emit({ type: "pickup", kind: "fuel" });
  }

  /** 装车方取走当前油桶；同一处清理引用与 carrying，避免两边各改一半。 */
  takeCarriedBarrel(): FuelBarrelState | null {
    const barrel = this.carriedBarrel;
    this.carriedBarrel = null;
    if (this.world.player.carrying === "fuel") this.world.player.carrying = null;
    return barrel;
  }

  dropCarriedBarrel(position: Vec2, rotation: number): boolean {
    const barrel = this.takeCarriedBarrel();
    if (!barrel) return false;
    barrel.x = position.x;
    barrel.z = position.z;
    barrel.rotation = rotation;
    barrel.placement = "ground";
    this.world.emit({ type: "drop", kind: "fuel" });
    return true;
  }

  findGrabbableWolf(): WolfState | null {
    let best: WolfState | null = null;
    let bestSq = GRAB_REACH * GRAB_REACH;
    for (const wolf of this.world.wolves) {
      if (wolf.mode === "dead" || wolf.mode === "grabbed" || wolf.mode === "airborne") continue;
      const stunned = wolf.attackCooldown > 0.2;
      const weak = wolf.health <= wolf.maxHealth * GRAB_HEALTH_FRACTION;
      if (!stunned && !weak) continue;
      const value = distanceSquared(this.world.player, wolf);
      if (value >= bestSq) continue;
      bestSq = value;
      best = wolf;
    }
    return best;
  }

  grabWolf(wolf: WolfState): void {
    wolf.mode = "grabbed";
    wolf.attackCooldown = Math.max(wolf.attackCooldown, 0.3);
    this.carriedWolf = wolf;
    this.world.player.carrying = "beast";
    this.world.emit({ type: "beast-grabbed", wolfId: wolf.id });
  }

  releaseCarriedWolf(): void {
    const wolf = this.carriedWolf;
    this.carriedWolf = null;
    this.world.player.carrying = null;
    if (!wolf) return;
    wolf.mode = "chase";
    wolf.provoked = true;
    wolf.lostTimer = 0;
    this.world.emit({ type: "drop", kind: "beast" });
  }

  /** 若手上是本系统管理的战斗物，则完成对应投掷并返回 true。 */
  tryAttack(): boolean {
    switch (this.world.player.carrying) {
      case "stone":
        this.throwStone();
        return true;
      case "beast":
        this.throwCarriedWolf();
        return true;
      case "fuel":
        this.throwCarriedBarrel();
        return true;
      default:
        return false;
    }
  }

  update(delta: number): void {
    this.updateThrownStones(delta);
    this.updateCarriedWolf(delta);
    this.updateThrownWolves(delta);
    this.updateThrownBarrels(delta);
  }

  /** 面朝一堆可炸的火时返回目标；预算为零时按钮不能再承诺“爆破”。 */
  getBarrelBlastTarget(): CampDefinition | null {
    if (this.world.player.carrying !== "fuel" || this.getFuelBlastBudget() <= 0) return null;
    let best: CampDefinition | null = null;
    let bestSq = BARREL_THROW_RANGE * BARREL_THROW_RANGE;
    for (const camp of this.world.campDefinitions) {
      if (this.world.camps[camp.id].fuel <= 0) continue;
      const value = distanceSquared(this.world.player, camp);
      if (value >= bestSq) continue;
      if (dot(this.world.player.facing, direction(this.world.player, camp)) < 0.35) continue;
      bestSq = value;
      best = camp;
    }
    return best;
  }

  private armThrow(): void {
    const player = this.world.player;
    player.attackCooldown = THROW_COOLDOWN * this.world.getConditionCooldownScale();
    player.attackFlash = 0.22;
  }

  private throwCarriedWolf(): void {
    const wolf = this.carriedWolf;
    if (!wolf) {
      this.world.player.carrying = null;
      return;
    }
    this.armThrow();
    const player = this.world.player;
    const target = this.world.wolves
      .filter((other) => other !== wolf && other.mode !== "dead" && other.mode !== "airborne"
        && distanceSquared(player, other) <= BEAST_THROW_RANGE * BEAST_THROW_RANGE
        && dot(player.facing, direction(player, other)) >= 0.3)
      .sort((a, b) => distanceSquared(player, a) - distanceSquared(player, b))[0];
    if (target) player.facing = direction(player, target);

    wolf.mode = "airborne";
    wolf.airTime = 0;
    wolf.x = player.x + player.facing.x * 0.9;
    wolf.z = player.z + player.facing.z * 0.9;
    this.thrownWolves.push({ wolf, dirX: player.facing.x, dirZ: player.facing.z, travelled: 0 });
    this.carriedWolf = null;
    player.carrying = null;
    this.world.noteActivity();
    this.world.emit({ type: "beast-thrown", wolfId: wolf.id });
  }

  private updateCarriedWolf(delta: number): void {
    const wolf = this.carriedWolf;
    if (!wolf) return;
    if (wolf.mode === "dead") {
      this.carriedWolf = null;
      this.world.player.carrying = null;
      return;
    }
    const player = this.world.player;
    wolf.x = player.x + player.facing.x * 0.75;
    wolf.z = player.z + player.facing.z * 0.75;
    wolf.facing = { x: -player.facing.x, z: -player.facing.z };
    this.world.damagePlayer(GRAB_STRUGGLE_DPS * delta, wolf);
  }

  private updateThrownWolves(delta: number): void {
    for (let index = this.thrownWolves.length - 1; index >= 0; index -= 1) {
      const flight = this.thrownWolves[index];
      const wolf = flight.wolf;
      if (wolf.mode !== "airborne") {
        this.thrownWolves.splice(index, 1);
        continue;
      }
      const step = BEAST_THROW_SPEED * delta;
      wolf.x += flight.dirX * step;
      wolf.z += flight.dirZ * step;
      flight.travelled += step;
      // 渲染层拿它算离地高度和翻滚角（见 GameRenderer.syncWolves）。
      // 只在这里推进，落地由下面清零 —— 高度和翻滚纯属表现，不参与命中判定。
      wolf.airTime += delta;

      let hit = false;
      for (const other of this.world.wolves) {
        if (other === wolf || other.mode === "dead" || other.mode === "airborne") continue;
        if (distanceSquared(wolf, other) > BEAST_HIT_RADIUS * BEAST_HIT_RADIUS) continue;
        other.health -= BEAST_IMPACT_DAMAGE;
        other.hurtFlash = 0.18;
        other.provoked = true;
        if (other.health <= 0) this.world.killWolf(other);
        this.world.emit({ type: "wolf-hit", wolfId: other.id });
        hit = true;
        break;
      }
      if (!hit && flight.travelled < BEAST_THROW_RANGE) continue;

      wolf.airTime = 0;
      wolf.health -= BEAST_SELF_DAMAGE;
      wolf.hurtFlash = 0.18;
      this.world.emit({ type: "wolf-hit", wolfId: wolf.id });
      if (wolf.health <= 0) this.world.killWolf(wolf);
      else {
        wolf.mode = "chase";
        wolf.provoked = true;
        wolf.lostTimer = 0;
        wolf.attackCooldown = Math.max(wolf.attackCooldown, BEAST_LAND_STUN);
      }
      this.world.emit({ type: "beast-landed", wolfId: wolf.id, hit });
      this.thrownWolves.splice(index, 1);
    }
  }

  private throwCarriedBarrel(): void {
    const barrel = this.carriedBarrel;
    if (!barrel) {
      this.world.player.carrying = null;
      return;
    }
    this.armThrow();
    const player = this.world.player;
    const blastTarget = this.getBarrelBlastTarget();
    const barrelTargets: Vec2[] = [
      ...this.world.wolves.filter((wolf) => wolf.mode !== "dead" && wolf.mode !== "airborne"),
      ...this.world.critters.filter((critter) => critter.mode !== "dead"),
    ];
    const target = blastTarget ?? barrelTargets
      .filter((animal) => distanceSquared(player, animal) <= BARREL_THROW_RANGE * BARREL_THROW_RANGE
        && dot(player.facing, direction(player, animal)) >= 0.3)
      .sort((a, b) => distanceSquared(player, a) - distanceSquared(player, b))[0];
    if (target) player.facing = direction(player, target);

    barrel.placement = "airborne";
    barrel.x = player.x + player.facing.x * 0.9;
    barrel.z = player.z + player.facing.z * 0.9;
    this.thrownBarrels.push({ barrel, dirX: player.facing.x, dirZ: player.facing.z, travelled: 0 });
    this.carriedBarrel = null;
    player.carrying = null;
    this.world.noteActivity();
    this.world.emit({ type: "barrel-thrown" });
  }

  private updateThrownBarrels(delta: number): void {
    for (let index = this.thrownBarrels.length - 1; index >= 0; index -= 1) {
      const flight = this.thrownBarrels[index];
      const barrel = flight.barrel;
      if (barrel.placement !== "airborne") {
        this.thrownBarrels.splice(index, 1);
        continue;
      }
      const step = BARREL_THROW_SPEED * delta;
      barrel.x += flight.dirX * step;
      barrel.z += flight.dirZ * step;
      flight.travelled += step;

      const fire = this.findLitFireNear(barrel, BARREL_BLAST_TRIGGER);
      if (fire) {
        if (this.getFuelBlastBudget() > 0) this.detonateBarrel(barrel, fire);
        else {
          // 最后六桶是任务油：仍允许把它扔出去脱身，但绝不再销毁通关条件。
          barrel.placement = "ground";
          barrel.rotation = this.world.random() * Math.PI * 2;
          this.world.emit({ type: "message", key: "msg.fuelReserved" });
        }
        this.thrownBarrels.splice(index, 1);
        continue;
      }

      let hit = false;
      for (const wolf of this.world.wolves) {
        if (wolf.mode === "dead" || wolf.mode === "grabbed" || wolf.mode === "airborne") continue;
        if (distanceSquared(barrel, wolf) > BARREL_HIT_RADIUS * BARREL_HIT_RADIUS) continue;
        wolf.health -= BARREL_THROW_DAMAGE;
        wolf.hurtFlash = 0.18;
        wolf.provoked = true;
        wolf.lostTimer = 0;
        if (wolf.health <= 0) this.world.killWolf(wolf);
        else {
          if (wolf.mode !== "retreating") wolf.mode = "chase";
          this.world.knockbackWolf(wolf, BARREL_KNOCKBACK, BARREL_KNOCKBACK_STUN);
        }
        this.world.emit({ type: "wolf-hit", wolfId: wolf.id });
        hit = true;
        break;
      }
      if (!hit) {
        for (const critter of this.world.critters) {
          if (critter.mode === "dead") continue;
          if (distanceSquared(barrel, critter) > BARREL_HIT_RADIUS * BARREL_HIT_RADIUS) continue;
          critter.health -= BARREL_THROW_DAMAGE;
          if (critter.health <= 0) this.world.killCritter(critter);
          hit = true;
          break;
        }
      }
      if (!hit && flight.travelled < BARREL_THROW_RANGE) continue;
      barrel.placement = "ground";
      barrel.rotation = this.world.random() * Math.PI * 2;
      this.thrownBarrels.splice(index, 1);
    }
  }

  private findLitFireNear(point: Vec2, maxDistance: number): CampDefinition | null {
    let best: CampDefinition | null = null;
    let bestSq = maxDistance * maxDistance;
    for (const camp of this.world.campDefinitions) {
      if (this.world.camps[camp.id].fuel <= 0) continue;
      const value = distanceSquared(point, camp);
      if (value >= bestSq) continue;
      bestSq = value;
      best = camp;
    }
    return best;
  }

  private detonateBarrel(barrel: FuelBarrelState, camp: CampDefinition): void {
    barrel.placement = "spent";
    this.world.camps[camp.id].fuel = clamp(
      this.world.camps[camp.id].fuel + BARREL_BLAST_FIRE_BONUS,
      0,
      300,
    );
    for (const wolf of this.world.wolves) {
      if (wolf.mode === "dead" || wolf.mode === "grabbed") continue;
      const away = Math.sqrt(distanceSquared(camp, wolf));
      if (away > BARREL_BLAST_RADIUS) continue;
      const falloff = 1 - (1 - BARREL_BLAST_EDGE_SCALE) * (away / BARREL_BLAST_RADIUS);
      wolf.health -= BARREL_BLAST_DAMAGE * falloff;
      wolf.hurtFlash = 0.25;
      wolf.provoked = true;
      if (wolf.health <= 0) this.world.killWolf(wolf);
      else {
        if (wolf.mode === "airborne") wolf.mode = "chase";
        this.world.knockbackWolf(wolf, BARREL_BLAST_KNOCKBACK, BARREL_BLAST_STUN);
        this.world.emit({ type: "wolf-hit", wolfId: wolf.id });
      }
    }
    this.world.emit({ type: "barrel-blast", x: camp.x, z: camp.z });
  }

  private throwStone(): void {
    this.armThrow();
    const player = this.world.player;
    const inCone = <T extends Vec2>(list: T[], alive: (item: T) => boolean): T | undefined => list
      .filter((item) => alive(item)
        && distanceSquared(player, item) <= STONE_THROW_RANGE * STONE_THROW_RANGE
        && dot(player.facing, direction(player, item)) >= 0.3)
      .sort((a, b) => distanceSquared(player, a) - distanceSquared(player, b))[0];
    const target = inCone(this.world.wolves, (wolf) => wolf.mode !== "dead")
      ?? inCone(this.world.critters, (critter) => critter.mode !== "dead");
    if (target) player.facing = direction(player, target);

    const slot = this.thrownStones.find((stone) => !stone.active);
    const stone: ThrownStone = slot ?? {
      id: this.thrownStones.length,
      x: 0,
      z: 0,
      dirX: 0,
      dirZ: 0,
      travelled: 0,
      progress: 0,
      active: true,
    };
    stone.x = player.x + player.facing.x * 0.8;
    stone.z = player.z + player.facing.z * 0.8;
    stone.dirX = player.facing.x;
    stone.dirZ = player.facing.z;
    stone.travelled = 0;
    stone.progress = 0;
    stone.active = true;
    if (!slot) this.thrownStones.push(stone);

    player.carrying = null;
    this.world.noteActivity();
    this.world.emit({ type: "stone-thrown" });
  }

  private updateThrownStones(delta: number): void {
    for (const stone of this.thrownStones) {
      if (!stone.active) continue;
      const step = STONE_THROW_SPEED * delta;
      stone.x += stone.dirX * step;
      stone.z += stone.dirZ * step;
      stone.travelled += step;
      stone.progress = Math.min(1, stone.travelled / STONE_THROW_RANGE);

      let hit = false;
      for (const wolf of this.world.wolves) {
        if (wolf.mode === "dead") continue;
        if (distanceSquared(stone, wolf) > STONE_HIT_RADIUS * STONE_HIT_RADIUS) continue;
        wolf.health -= STONE_THROW_DAMAGE;
        wolf.hurtFlash = 0.18;
        wolf.provoked = true;
        wolf.lostTimer = 0;
        if (wolf.health <= 0) this.world.killWolf(wolf);
        else {
          if (wolf.mode !== "retreating") wolf.mode = "chase";
          this.world.knockbackWolf(wolf, STONE_KNOCKBACK, STONE_KNOCKBACK_STUN);
        }
        this.world.emit({ type: "wolf-hit", wolfId: wolf.id });
        hit = true;
        break;
      }
      if (!hit) {
        for (const critter of this.world.critters) {
          if (critter.mode === "dead") continue;
          if (distanceSquared(stone, critter) > STONE_HIT_RADIUS * STONE_HIT_RADIUS) continue;
          critter.health -= STONE_THROW_DAMAGE;
          if (critter.health <= 0) this.world.killCritter(critter);
          hit = true;
          break;
        }
      }
      if (!hit && stone.travelled < STONE_THROW_RANGE) continue;
      stone.active = false;
      this.landStone(stone);
      this.world.emit({ type: "stone-landed", hit });
    }
  }

  private landStone(stone: ThrownStone): void {
    const existing = this.world.items.find((item) => !item.active);
    const item: GroundItem = existing ?? {
      id: this.world.items.length,
      x: stone.x,
      z: stone.z,
      kind: "stone",
      hp: 1,
      placed: false,
      active: true,
      rotation: 0,
    };
    item.x = stone.x;
    item.z = stone.z;
    item.kind = "stone";
    item.hp = BARRIER_STATS.stone.hp;
    item.placed = false;
    item.active = true;
    item.rotation = this.world.random() * Math.PI * 2;
    if (!existing) this.world.items.push(item);
  }
}
