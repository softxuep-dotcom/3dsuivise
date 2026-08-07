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
import { campGatePosition, isTerrainWalkable, terrainHeightAt } from "../terrain/TerrainModel";
import { NavigationGrid } from "./NavigationGrid";
import type {
  BerryPatch,
  CampKind,
  CampDefinition,
  CampState,
  GameEvent,
  GroundItem,
  InteractionHint,
  IronNode,
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
const FIRST_DAY_DURATION = 55;
const FIRST_NIGHT_DURATION = 105;
const LATER_DAY_DURATION = 120;
const SECOND_NIGHT_DURATION = 120;
const LATER_NIGHT_DURATION = 135;
const MAX_WOLVES = 120;
const DROP_LIFETIME = 180;

// === 体温系统 ===
// 体温是生死指标：0 = 冻死，100 = 中暑/过热死亡，50 = 中性起点
const WARMTH_MIN = 0;
const WARMTH_MAX = 100;
const WARMTH_INITIAL = 50;
// 各项速率（每秒）—— 三者独立累加，皮衣/地形不再影响体温
//   篝火：+3.0/s   白天：+1.2/s   夜晚：-1.6/s
//   组合示例：白天火边 = 3 + 1.2 = +4.2/s；夜晚火边 = 3 - 1.6 = +1.4/s
const WARMTH_FIRE_GAIN = 3.0;      // 篝火边回温（独立分量，始终为正）
const WARMTH_DAY_REGEN = 1.2;      // 白天基础回暖（独立分量）
const WARMTH_NIGHT_LOSS = 1.6;     // 夜间寒冷流失（独立分量，始终为负）

const CAMP_LABELS: Record<CampKind, string> = {
  "windy-ridge": "风口高地",
  "deep-cave": "背风崖穴",
  "abandoned-camp": "废弃营地",
};

export class GameSimulation {
  readonly world: WorldDefinition;
  readonly camps: CampState[];
  readonly items: GroundItem[];
  readonly berries: BerryPatch[];
  readonly ironNodes: IronNode[];
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
  private duskWarningSent = false;
  private largeWolfAnnounced = false;
  // 死因记录，供 UI 显示游戏结束文案
  deathCause: "frozen" | "overheated" | "killed" | null = null;

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
    this.ironNodes = world.ironNodes.map((node) => ({ ...node }));
    this.player = {
      x: startCamp.x,
      z: startCamp.z + 1.5,
      facing: { x: 0.7, z: 0.7 },
      health: 100,
      maxHealth: 100,
      attack: 28,
      defense: 2,
      warmth: WARMTH_INITIAL,
      hunger: 82,
      inventory: Array.from({ length: INVENTORY_CAPACITY }, () => null),
      carrying: null,
      hasLeatherCoat: false,
      weapon: "wood-club",
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

    // 游戏结束判定：体温归零（冻死）/ 体温爆表（过热）/ 生命归零（被狼杀死或饿死）
    if (!this.gameOverSent) {
      if (this.player.warmth <= WARMTH_MIN) {
        this.player.warmth = WARMTH_MIN;
        this.endGame("frozen");
      } else if (this.player.warmth >= WARMTH_MAX) {
        this.player.warmth = WARMTH_MAX;
        this.endGame("overheated");
      } else if (this.player.health <= 0) {
        this.player.health = 0;
        this.endGame("killed");
      }
    }
  }

  private endGame(cause: "frozen" | "overheated" | "killed"): void {
    this.setResting(false);
    this.running = false;
    this.gameOverSent = true;
    this.deathCause = cause;
    this.events.push({ type: "game-over" });
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
      return;
    }

    const ironNode = this.findNearestIron(2.8);
    if (ironNode) {
      if (!this.addInventory("iron-ore", 1)) {
        this.events.push({ type: "message", text: "背包已满" });
        return;
      }
      ironNode.ore -= 1;
      this.events.push({ type: "pickup", kind: "iron-ore" });
      this.events.push({ type: "message", text: "获得铁矿 · 可在燃烧的篝火旁制作粗铁矛" });
    }
  }

  requestAttack(): void {
    if (!this.running || this.player.attackCooldown > 0 || this.player.carrying) return;
    this.noteActivity();
    this.player.attackCooldown = this.player.weapon === "iron-spear" ? 0.58 : 0.5;
    this.player.attackFlash = 0.22;
    this.events.push({ type: "attack" });
    let hit = false;

    const attackRange = this.player.weapon === "iron-spear" ? 3.8 : 3.1;
    const assistedTarget = this.wolves
      .filter((wolf) => wolf.mode !== "dead" && distanceSquared(this.player, wolf) <= attackRange * attackRange)
      .sort((a, b) => distanceSquared(this.player, a) - distanceSquared(this.player, b))[0];
    if (assistedTarget) this.player.facing = direction(this.player, assistedTarget);
    for (const wolf of this.wolves) {
      if (wolf.mode === "dead" || distanceSquared(this.player, wolf) > attackRange * attackRange) continue;
      const towardWolf = direction(this.player, wolf);
      if (dot(this.player.facing, towardWolf) < -0.15) continue;
      const wasRetreating = wolf.mode === "retreating";
      const conditionMultiplier = this.player.hunger < 15 || this.player.warmth < 20 ? 0.8 : 1;
      const damage = Math.max(1, Math.round(this.player.attack * conditionMultiplier) - wolf.defense);
      wolf.health -= damage;
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
      if (this.player.hunger >= 99 && this.player.health >= this.player.maxHealth) return;
      this.removeFromSlot(index, 1);
      this.player.hunger = clamp(this.player.hunger + 18, 0, 100);
      this.player.health = clamp(this.player.health + 3, 0, this.player.maxHealth);
      this.events.push({ type: "eat", kind: "berry" });
      return;
    }
    if (stack.kind === "cooked-meat") {
      if (this.player.hunger >= 99 && this.player.health >= this.player.maxHealth) return;
      this.removeFromSlot(index, 1);
      this.player.hunger = clamp(this.player.hunger + 38, 0, 100);
      this.player.health = clamp(this.player.health + 8, 0, this.player.maxHealth);
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
    if (stack.kind === "iron-ore") {
      this.events.push({ type: "message", text: this.player.weapon === "iron-spear" ? "已经装备粗铁矛" : "3块铁矿和1张狼皮可制作粗铁矛" });
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
    this.player.defense += 4;
    this.events.push({ type: "craft-coat" });
    this.events.push({ type: "message", text: "基础皮衣完成 · 防御+4，寒冷流失降低35%" });
    return true;
  }

  craftIronSpear(): boolean {
    if (!this.running || this.player.weapon === "iron-spear") return false;
    if (!this.findNearestLitCamp(5.2)) {
      this.events.push({ type: "message", text: "粗铁矛必须在燃烧的篝火旁制作" });
      return false;
    }
    if (this.getInventoryCount("iron-ore") < 3 || this.getInventoryCount("wolf-hide") < 1) {
      this.events.push({ type: "message", text: "粗铁矛需要3块铁矿和1张狼皮" });
      return false;
    }
    this.noteActivity();
    this.removeInventory("iron-ore", 3);
    this.removeInventory("wolf-hide", 1);
    this.player.weapon = "iron-spear";
    this.player.attack += 18;
    this.events.push({ type: "craft-weapon" });
    this.events.push({ type: "message", text: "粗铁矛完成 · 攻击+18" });
    return true;
  }

  getInventoryCount(kind: InventoryItemKind): number {
    return this.player.inventory.reduce((total, stack) => total + (stack?.kind === kind ? stack.count : 0), 0);
  }

  getInteractionHint(): InteractionHint {
    if (this.player.carrying) {
      const camp = this.findNearestCamp(4.3);
      if (camp && this.player.carrying === "wood") return { action: "feed", text: "添入圆木 · 篝火延长95秒" };
      return { action: "drop", text: `放下${this.player.carrying === "wood" ? "圆木" : "大石"}${this.player.carrying === "stone" ? " · 一块即可封住窄口" : ""}` };
    }
    const item = this.findNearestItem(2.5);
    if (item) return { action: "pickup", text: `双手搬起${item.kind === "wood" ? "圆木" : "大石"}` };
    if (this.findNearestBerry(2.7)) return { action: "berry", text: "采集野果到背包" };
    if (this.findNearestIron(2.8)) return { action: "mine", text: "敲取铁矿 · 篝火旁可制作粗铁矛" };
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
    return 1 - Math.min(1, this.phaseTime / fade);
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

  getCurrentLocationLabel(): string {
    const camp = this.findNearestCamp(14);
    return camp ? CAMP_LABELS[camp.kind] : "荒山雪原";
  }

  getNearestThreat(): WolfState | null {
    let nearest: WolfState | null = null;
    let best = 24 * 24;
    for (const wolf of this.wolves) {
      if (wolf.mode === "dead" || wolf.mode === "retreating") continue;
      const value = distanceSquared(this.player, wolf);
      if (value >= best) continue;
      nearest = wolf;
      best = value;
    }
    return nearest;
  }

  getObjective(): string {
    if (!this.clockStarted) return "移动或拿起圆木，开始第一天";
    if (this.player.resting) return this.player.hunger < 40 ? "休息中 · 饥饿使恢复降至0.6/秒" : "休息中 · 生命每秒恢复1点";
    // 体温端点警告（新机制）
    if (this.player.warmth <= 10) return "即将冻死 · 立刻回到篝火边";
    if (this.player.warmth >= 90) return "即将过热 · 远离篝火降温";
    if (this.player.warmth < 25) return "体温过低 · 移动与攻击减弱";
    if (this.player.warmth > 75) return "体温偏高 · 暂时离开篝火";
    if (this.player.hunger <= 0) return "饥饿归零 · 生命正在流失";
    if (this.player.hunger < 20) return "严重饥饿 · 无法休息且攻击减弱";
    if (this.phase === "day" && this.day === 1 && this.phaseTime <= 14) return "天快黑了 · 用入口大石封住缺口";
    if (this.phase === "night") {
      const lit = this.getNearestLitCamp();
      if (!lit) return "篝火熄灭 · 体温正在下降，尽快添柴";
      if (lit.fuel < 25) return "火快灭了：再搬一根圆木";
      return "守住火光；狼死亡会掉落肉和皮";
    }
    const retreatingWolves = this.wolves.filter((wolf) => wolf.mode === "retreating").length;
    if (retreatingWolves > 0) return `天亮了 · ${retreatingWolves}只狼正在撤离`;
    if (this.objectiveStage === 0) return "拿起身边的圆木";
    if (this.objectiveStage === 1) return "把圆木送到篝火旁添柴";
    if (this.objectiveStage === 2) return "找到入口旁的大石并搬到缺口中央";
    if (!this.player.hasLeatherCoat && this.getInventoryCount("wolf-hide") > 0) return "收集4张狼皮制作基础皮衣";
    if (this.getInventoryCount("berry") === 0) return "搜集木材、野果与铁矿";
    return "选择有利山坳，补充食物并准备武器";
  }

  private updatePlayerMovement(delta: number, rawMovement: Vec2, isMoving: boolean): void {
    if (!isMoving) return;
    this.noteActivity();
    const movement = normalize(rawMovement);
    this.player.facing = movement;
    const carryingPenalty = this.player.carrying === "stone" ? 0.54 : this.player.carrying ? 0.82 : 1;
    const conditionPenalty = this.player.warmth < 25 || this.player.hunger < 12 ? 0.84 : 1;
    const speed = 8.2 * carryingPenalty * conditionPenalty;
    this.moveEntity(this.player, movement.x * speed * delta, movement.z * speed * delta, PLAYER_RADIUS, true);
  }

  private updateNeeds(delta: number): void {
    // 饥饿下降速率 0.55/s，约 3 分钟满→空
    this.player.hunger = clamp(this.player.hunger - delta * 0.55, 0, 100);

    // === 体温系统 ===
    // 规则：三个独立分量相加，互不依赖，皮衣/地形不再影响体温。
    //   篝火边：+WARMTH_FIRE_GAIN（+3.0/s）
    //   白天  ：+WARMTH_DAY_REGEN（+1.2/s）
    //   夜晚  ：+WARMTH_NIGHT_LOSS（-1.6/s，本身是负值方向，用减法表达）
    // 组合：
    //   白天火边 = 3.0 + 1.2         = +4.2/s
    //   白天无火 = 1.2               = +1.2/s
    //   夜晚火边 = 3.0 - 1.6         = +1.4/s
    //   夜晚无火 = -1.6              = -1.6/s
    const nearFire = this.camps.some((camp) => {
      if (camp.fuel <= 0) return false;
      return distanceSquared(this.player, this.world.camps[camp.id]) < 8.2 * 8.2;
    });
    let warmthDelta = 0;
    if (nearFire) warmthDelta += WARMTH_FIRE_GAIN;
    if (this.phase === "day") warmthDelta += WARMTH_DAY_REGEN;
    else warmthDelta -= WARMTH_NIGHT_LOSS;
    this.player.warmth = clamp(this.player.warmth + delta * warmthDelta, WARMTH_MIN, WARMTH_MAX);

    // 饥饿归零仍扣血（保留原机制），体温端点改为直接触发游戏结束（见 update()）
    if (this.player.hunger <= 0) this.player.health -= delta * 2.6;
  }

  private updateRest(delta: number): void {
    const nearbyThreat = this.wolves.some((wolf) => {
      if (wolf.mode === "dead") return false;
      const dangerRadius = wolf.mode === "chase" ? 20 : wolf.mode === "raid" ? 11 : 0;
      return dangerRadius > 0 && distanceSquared(wolf, this.player) < dangerRadius * dangerRadius;
    });
    const temperatureAllowsRest = this.phase === "day" || this.player.warmth > 30;
    const canRest = this.player.idleTime >= 5
      && this.player.health < this.player.maxHealth
      && this.player.hunger >= 20
      && temperatureAllowsRest
      && !nearbyThreat;
    this.setResting(canRest);
    const healingRate = this.player.hunger < 40 ? 0.6 : 1;
    if (this.player.resting) this.player.health = clamp(this.player.health + delta * healingRate, 0, this.player.maxHealth);
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
    // 每夜目标狼数大幅上调：D1 26→40，D2 36→55，D3+ 46→70，压力明显增强
    const target = Math.min(90, 40 + (this.day - 1) * 15);
    if (this.phase === "night" && livingCount < MAX_WOLVES && this.spawnedThisNight < target) {
      this.spawnCountdown -= delta;
      if (this.spawnCountdown <= 0) {
        this.spawnWolf();
        this.spawnedThisNight += 1;
        const nightProgress = clamp(1 - this.phaseTime / this.getPhaseDuration(), 0, 1);
        const nightlyPressure = Math.max(0.78, 1 - (this.day - 1) * 0.09);
        // 刷怪间隔曲线整体压缩：从 0.9~5.7s 缩到 0.7~4.0s，前期更密集
        const curvedInterval = 0.7 + Math.pow(nightProgress, 0.8) * 3.3;
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
        const damage = Math.max(1, wolf.attack - this.player.defense);
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
        const barrierDamage = Math.round(wolf.attack * (wolf.kind === "large" ? 1.45 : 1.05));
        blockingItem.hp -= barrierDamage;
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
    this.createDrop(wolf, "raw-meat", -0.65, wolf.kind === "large" ? 2 : 1);
    this.createDrop(wolf, "wolf-hide", 0.65, wolf.kind === "large" ? 2 : 1);
    this.events.push({ type: "wolf-killed", wolfId: wolf.id });
  }

  private createDrop(position: Vec2, kind: InventoryItemKind, angleOffset: number, count = 1): void {
    const angle = Math.atan2(this.player.z - position.z, this.player.x - position.x) + angleOffset;
    const drop: WorldDrop = {
      id: this.dropId++,
      kind,
      count,
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
    const tutorialWolf = this.day === 1 && this.spawnedThisNight === 0;
    const side = Math.floor(this.random() * 4);
    const along = (this.random() - 0.5) * (this.world.size - 12);
    const edgeSpawn = side === 0 ? { x: -half, z: along }
      : side === 1 ? { x: half, z: along }
      : side === 2 ? { x: along, z: -half }
      : { x: along, z: half };
    const camp = tutorialWolf
      ? this.world.camps[this.world.startCampId]
      : this.world.camps[Math.floor(this.random() * this.world.camps.length)];
    const spawnCandidate = tutorialWolf ? {
      x: camp.x + Math.cos(camp.entranceAngle) * (camp.radius + 18),
      z: camp.z + Math.sin(camp.entranceAngle) * (camp.radius + 18),
    } : edgeSpawn;
    const spawn = this.findNearestWalkablePoint(spawnCandidate);
    const anchorAngle = this.random() * TAU;
    const anchorDistance = 12 + this.random() * 10;
    const raiderChance = Math.min(0.35, 0.16 + (this.day - 1) * 0.06);
    const raider = tutorialWolf || this.random() < raiderChance;
    const largeChance = Math.min(0.58, 0.22 + (this.day - 1) * 0.09);
    const kind = tutorialWolf || this.random() >= largeChance ? "small" : "large";
    const maxHealth = tutorialWolf ? 28 : kind === "large" ? 112 : 58;
    const attack = tutorialWolf ? 5 : kind === "large" ? 16 + Math.min(4, this.day - 1) : 10 + Math.min(3, Math.floor((this.day - 1) * 0.7));
    const defense = tutorialWolf ? 0 : kind === "large" ? 5 : 1;
    const anchor = this.findNearestWalkablePoint({
      x: camp.x + Math.cos(anchorAngle) * anchorDistance,
      z: camp.z + Math.sin(anchorAngle) * anchorDistance,
    });
    this.wolves.push({
      id: this.wolfId++,
      kind,
      ...spawn,
      facing: direction(spawn, anchor),
      health: maxHealth,
      maxHealth,
      attack,
      defense,
      mode: raider ? "raid" : "entering",
      raider,
      anchor,
      patrolAngle: this.random() * TAU,
      speed: tutorialWolf ? 3.05 : kind === "large" ? 2.85 + this.random() * 0.55 : 3.65 + this.random() * 0.75,
      attackCooldown: this.random(),
      lostTimer: 0,
      hurtFlash: 0,
      deathTimer: 0,
      dropsCreated: false,
    });
    if (tutorialWolf) this.events.push({ type: "message", text: "侦察小狼正在逼近 · 面向它攻击" });
    if (kind === "large" && !this.largeWolfAnnounced) {
      this.largeWolfAnnounced = true;
      this.events.push({ type: "message", text: "发现大狼 · 生命、防御和破坏力都更高" });
    }
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
    const startHeight = terrainHeightAt(this.world, start) + 1.15;
    const endHeight = terrainHeightAt(this.world, end) + 1.15;
    for (let step = 1; step < 8; step += 1) {
      const t = step / 8;
      const point = { x: start.x + (end.x - start.x) * t, z: start.z + (end.z - start.z) * t };
      const sightHeight = startHeight + (endHeight - startHeight) * t;
      if (terrainHeightAt(this.world, point) > sightHeight + 0.35) return true;
    }
    for (const item of this.items) {
      if (item.active && item.placed && segmentIntersectsCircle(start, end, item, item.kind === "stone" ? 1.48 : 0.65)) return true;
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
      const clusterSize = this.items.filter((other) => other.active && other.placed && distanceSquared(item, other) < 4.2 * 4.2).length;
      if (item.kind === "wood" && clusterSize < 2) continue;
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
    if (!this.duskWarningSent && this.phase === "day" && this.day === 1 && this.phaseTime <= 14) {
      this.duskWarningSent = true;
      this.events.push({ type: "message", text: "天色正在变暗 · 入口的大石一块就能封住窄口" });
    }
    if (this.objectiveStage === 0 && this.player.carrying) {
      this.objectiveStage = 1;
      this.events.push({ type: "message", text: "圆木用于添火；入口旁的大石负责封路" });
    } else if (this.objectiveStage === 1 && this.camps.some((camp) => camp.fuel > 90)) {
      this.objectiveStage = 2;
      this.events.push({ type: "message", text: "火已续上 · 把入口的大石搬到缺口中央" });
    } else if (this.objectiveStage === 2 && this.world.camps.some((camp) => this.isEntranceBlocked(camp))) {
      this.objectiveStage = 3;
      this.events.push({ type: "message", text: "封口完成 · 石头会挡路并承受狼的攻击" });
    }
  }

  private isEntranceBlocked(camp: CampDefinition): boolean {
    const entrance = campGatePosition(camp);
    return this.items.some((item) => item.active && item.placed && item.kind === "stone" && distanceSquared(item, entrance) < 3.6 * 3.6);
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

  private findNearestIron(maxDistance: number): IronNode | null {
    let nearest: IronNode | null = null;
    let best = maxDistance * maxDistance;
    for (const node of this.ironNodes) {
      if (node.ore <= 0) continue;
      const value = distanceSquared(this.player, node);
      if (value < best) {
        nearest = node;
        best = value;
      }
    }
    return nearest;
  }

  private findNearestWalkablePoint(origin: Vec2): Vec2 {
    if (isTerrainWalkable(this.world, origin)) return origin;
    for (let radius = 2; radius <= 24; radius += 2) {
      for (let step = 0; step < 16; step += 1) {
        const angle = (step / 16) * TAU;
        const candidate = {
          x: clamp(origin.x + Math.cos(angle) * radius, -this.world.size / 2 + 1, this.world.size / 2 - 1),
          z: clamp(origin.z + Math.sin(angle) * radius, -this.world.size / 2 + 1, this.world.size / 2 - 1),
        };
        if (isTerrainWalkable(this.world, candidate)) return candidate;
      }
    }
    return origin;
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
    item.hp = kind === "stone" ? 220 : 70;
    item.placed = true;
    item.active = true;
    item.rotation = Math.atan2(this.player.facing.z, this.player.facing.x);
    if (!existing) this.items.push(item);
    this.player.carrying = null;
    this.events.push({ type: "drop", kind });
  }

  private moveEntity(entity: Vec2, dx: number, dz: number, radius: number, collideWithItems: boolean): void {
    const originalX = entity.x;
    entity.x += dx;
    if (!this.canTraverseTerrain({ x: originalX, z: entity.z }, entity)) entity.x = originalX;
    this.resolveCollisions(entity, radius, collideWithItems);
    const originalZ = entity.z;
    entity.z += dz;
    if (!this.canTraverseTerrain({ x: entity.x, z: originalZ }, entity)) entity.z = originalZ;
    this.resolveCollisions(entity, radius, collideWithItems);
    const half = this.world.size / 2 - radius;
    entity.x = clamp(entity.x, -half, half);
    entity.z = clamp(entity.z, -half, half);
  }

  private resolveCollisions(entity: Vec2, radius: number, collideWithItems: boolean): void {
    for (let pass = 0; pass < 3; pass += 1) {
      for (const obstacle of this.world.walls) this.pushOutsideCircle(entity, radius, obstacle, obstacle.radius);
      if (!collideWithItems) continue;
      for (const item of this.items) {
        if (!item.active || !item.placed) continue;
        this.pushOutsideCircle(entity, radius, item, item.kind === "stone" ? 1.48 : 0.62);
      }
    }
  }

  private canTraverseTerrain(from: Vec2, to: Vec2): boolean {
    if (!isTerrainWalkable(this.world, to)) return false;
    const travel = Math.hypot(to.x - from.x, to.z - from.z);
    if (travel < 0.0001) return true;
    const rise = Math.abs(terrainHeightAt(this.world, to) - terrainHeightAt(this.world, from));
    return rise / travel <= this.world.terrain.maxWalkableSlope * 1.12;
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

}
