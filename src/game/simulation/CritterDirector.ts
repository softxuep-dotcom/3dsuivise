import { direction, distance, distanceSquared, normalize, rotateToward, TAU } from "./geometry";
import { isTerrainWalkable } from "../terrain/TerrainModel";
import { getSteeredDirection, moveEntity } from "./collision";
import type { CollisionWorld } from "./collision";
import { CRITTER_SPECS } from "./types";
import type {
  CritterKind, CritterState, GameEvent, InventoryItemKind, PlayerState, Vec2,
} from "./types";
import {
  CRITTER_LOD_DISTANCE,
  CRITTER_LOD_STRIDE,
  TUTORIAL_PREY,
  TUTORIAL_PREY_COUNT,
  TUTORIAL_PREY_RADIUS,
  TUTORIAL_PREY_SPREAD,
} from "./balance";

/**
 * 猎物种群能看到的世界。
 *
 * 和 WolfWorld 一套口径：动态状态全走 getter，取值必须是实时的。这张表就是
 * 猎物和模拟层之间**全部**的耦合面 —— 短得多，因为猎物不打人：它们不需要
 * 知道相位、难度、装备、护甲，只要知道玩家在哪、地形能不能走、掉落往哪儿撒。
 *
 * 继承 {@link CollisionWorld} 是因为逃跑要走真正的碰撞（会绕石头和树桩），
 * 那一层本来就只要 world / items / structures 三样。
 */
export interface CritterWorld extends CollisionWorld {
  readonly player: PlayerState;
  /** 出生点与初始朝向：教学猎物按它撒，不能用玩家当前位置（撒的时候他早走开了）。 */
  readonly spawnAnchor: Vec2;
  readonly spawnFacing: number;
  random(): number;
  emit(event: GameEvent): void;
  createDrop(position: Vec2, kind: InventoryItemKind, angleOffset: number, count?: number): void;
  findNearestWalkablePoint(origin: Vec2): Vec2;
}

/**
 * 荒漠猎物。
 *
 * 全部不攻击玩家。难度只由「警觉半径 + 逃跑速度 + 冲刺时长」三项决定：
 * 冲刺耗尽后它们会停下喘气，所以再快的猎物只要肯追都追得到 ——
 * 代价是你自己的劳力和体温（奔跑产热，白天很容易把自己追到中暑）。
 *
 * 从 GameSimulation 里抽出来，和 WolfDirector 同一个形状：种群数组归它自己，
 * 模拟层保留一个同名 getter，渲染层和测试都不用改。
 */
export class CritterDirector {
  readonly critters: CritterState[] = [];
  private nextId = 0;
  private respawnCountdown = 4;
  /** LOD 错峰用的帧计数。 */
  private lodFrame = 0;

  constructor(private readonly ctx: CritterWorld) {}

  update(delta: number): void {
    this.respawnCountdown -= delta;
    if (this.respawnCountdown <= 0) {
      this.respawnCountdown = 6;
      this.replenish();
    }
    /*
     * 和狼同一套降频，理由见 WolfDirector 的 LOD_DISTANCE。
     * 猎物比狼更该降：它们不追人、不攻击，远处那几十只纯粹在自己溜达。
     * 半径同样取 50 米，压过渲染层 45 米的剔除线。
     */
    this.lodFrame += 1;
    const lodCutoff = CRITTER_LOD_DISTANCE * CRITTER_LOD_DISTANCE;
    for (const critter of this.critters) {
      if (distanceSquared(critter, this.ctx.player) > lodCutoff) {
        critter.lodAccum += delta;
        if ((critter.id + this.lodFrame) % CRITTER_LOD_STRIDE !== 0) continue;
      }
      this.updateOne(critter, critter.lodAccum > 0 ? critter.lodAccum + delta : delta);
      critter.lodAccum = 0;
    }
    for (let index = this.critters.length - 1; index >= 0; index -= 1) {
      const critter = this.critters[index];
      if (critter.mode === "dead" && critter.deathTimer <= 0) this.critters.splice(index, 1);
    }
  }

  /** 每种猎物各自维持自己的目标数量，在远离玩家的地方补回来。 */
  /**
   * 开局把整个种群一次撒满。
   * 之前只靠每 6 秒补 1 只，玩家开局面对的是一片空荡荡的沙漠，
   * 要一分钟后才慢慢有东西可打 —— 第一天的觅食完全没法进行。
   */
  seed(): void {
    for (const kind of Object.keys(CRITTER_SPECS) as CritterKind[]) {
      const spec = CRITTER_SPECS[kind];
      for (let index = 0; index < spec.population; index += 1) {
        // 头几只教学猎物撒在出生点脚边（见 tutorialPreySpot），其余照旧满图散。
        // 它们**算在自己那一种的 population 里面**，所以 replenishCritters 的账不变：
        // 教学猎物被打死之后由常规补充在远处补回，脚边不会源源不断地刷。
        const point = kind === TUTORIAL_PREY && index < TUTORIAL_PREY_COUNT
          ? this.tutorialPreySpot(index)
          // 开局允许离玩家近一些，否则第一天要跑很远才见得到活物。
          : this.findSpawnPoint(14);
        if (point) this.spawn(kind, point);
      }
    }
  }

  /**
   * 教学猎物的落点：出生点前方 5.5~7.0 米，散在初始朝向的左中右。
   *
   * 一只在正前方（玩家开局面朝卡车，它必定在画面里），左右各一只岔开约 35°，
   * 于是无论玩家先转向哪边都会撞见一只。
   *
   * 这一步要教的不是"这游戏能打猎"，是"按这个键，眼前的东西就没了" ——
   * 拾骨鸦 10 血、初始匕首 30 伤害，和入夜后扑上来那只教学犬（28 血 / 防御 0）
   * 完全相同的结算。玩家在鸟身上学会的那一下，正是 30 秒后救他命的那一下。
   *
   * 改之前最近的可攻击目标在 27 米外，一直挥刀的玩家第一次命中要到第 43 秒 ——
   * 而第一天白天只有 40 秒，考试比课先到。
   *
   * 角度和半径都是写死的常量，不走 this.ctx.random()：一是这三只本来就该稳定出现在
   * 同一个地方，二是不额外消费随机流，免得整张地图的布局跟着抖。
   */
  private tutorialPreySpot(index: number): Vec2 {
    const spread = TUTORIAL_PREY_SPREAD[index] ?? 0;
    const radius = TUTORIAL_PREY_RADIUS[index] ?? 6;
    const angle = this.ctx.spawnFacing + spread;
    return {
      x: this.ctx.spawnAnchor.x + Math.cos(angle) * radius,
      z: this.ctx.spawnAnchor.z + Math.sin(angle) * radius,
    };
  }

  private replenish(): void {
    for (const kind of Object.keys(CRITTER_SPECS) as CritterKind[]) {
      const spec = CRITTER_SPECS[kind];
      const alive = this.critters.filter((c) => c.kind === kind && c.mode !== "dead").length;
      if (alive >= spec.population) continue;
      const point = this.findSpawnPoint();
      if (point) this.spawn(kind, point);
    }
  }

  private findSpawnPoint(minPlayerDistance = 30): Vec2 | null {
    for (let guard = 0; guard < 24; guard += 1) {
      const point = {
        x: (this.ctx.random() - 0.5) * (this.ctx.world.size - 20),
        z: (this.ctx.random() - 0.5) * (this.ctx.world.size - 20),
      };
      // 别在玩家眼皮底下凭空出现。
      if (distanceSquared(point, this.ctx.player) < minPlayerDistance * minPlayerDistance) continue;
      if (!isTerrainWalkable(this.ctx.world, point)) continue;
      return point;
    }
    return null;
  }

  private spawn(kind: CritterKind, origin: Vec2): void {
    const spec = CRITTER_SPECS[kind];
    const spawn = this.ctx.findNearestWalkablePoint(origin);
    const facingAngle = this.ctx.random() * TAU;
    this.critters.push({
      id: this.nextId++,
      kind,
      ...spawn,
      // 一个角度、一次取样。原先是 `{ cos(random()), sin(random()) }` —— **两次**取样，
      // 出来的根本不是单位向量（实测长度 0.68）。渲染只看 atan2(z, x) 所以一直没露馅，
      // 直到朝向开始参与转向限速的插值：非单位向量会让第一步的转角算错。
      facing: { x: Math.cos(facingAngle), z: Math.sin(facingAngle) },
      lodAccum: 0,
      health: spec.maxHealth,
      maxHealth: spec.maxHealth,
      mode: "graze",
      anchor: { ...spawn },
      wanderAngle: this.ctx.random() * TAU,
      sprint: spec.sprintSeconds,
      hurtFlash: 0,
      deathTimer: 0,
      dropsCreated: false,
    });
  }

  private updateOne(critter: CritterState, delta: number): void {
    critter.hurtFlash = Math.max(0, critter.hurtFlash - delta);
    if (critter.mode === "dead") {
      critter.deathTimer -= delta;
      return;
    }

    const spec = CRITTER_SPECS[critter.kind];
    const playerDistance = distance(critter, this.ctx.player);
    const startled = playerDistance < spec.alertRadius && critter.sprint > 0;

    if (startled) {
      critter.mode = "flee";
      critter.sprint = Math.max(0, critter.sprint - delta);
    } else {
      critter.mode = "graze";
      // 只有玩家离得够远才回气，否则站在旁边等它回满就太廉价了。
      if (playerDistance > spec.alertRadius * 1.35) {
        critter.sprint = Math.min(spec.sprintSeconds, critter.sprint + delta * (spec.sprintSeconds / spec.sprintRecovery));
      }
    }

    let desired: Vec2;
    let pace: number;
    if (critter.mode === "flee") {
      desired = direction(this.ctx.player, critter);
      pace = spec.fleeSpeed;
    } else {
      // 游荡：绕着锚点慢慢晃，离得太远就往回收。
      critter.wanderAngle += delta * (0.3 + (critter.id % 5) * 0.04);
      const anchorPull = distance(critter, critter.anchor) > 14 ? direction(critter, critter.anchor) : { x: 0, z: 0 };
      desired = normalize({
        x: Math.cos(critter.wanderAngle) + anchorPull.x * 2.2,
        z: Math.sin(critter.wanderAngle * 0.82) + anchorPull.z * 2.2,
      });
      pace = spec.grazeSpeed;
    }

    // 转向限速，**而且移动跟着限速后的朝向走**，不是跟着 desired 走。
    //
    // 分开的话（朝向平滑、位移瞬时）动物会侧着身子滑行，比甩头还怪。
    // 合起来之后逃跑变成画弧：长角羚 2.6 rad/s 掉个头要 1.2 秒，
    // 这 1.2 秒就是玩家抄近路截它的窗口 —— 它 10.5 的移速比玩家 8.2 快，
    // 但快不代表甩得掉。
    const steered = getSteeredDirection(this.ctx, critter, desired);
    critter.facing = rotateToward(critter.facing, steered, spec.turnRate * delta);
    moveEntity(this.ctx, critter, critter.facing.x * pace * delta, critter.facing.z * pace * delta, 0.4, false);
  }

  kill(critter: CritterState): void {
    if (critter.dropsCreated) return;
    const spec = CRITTER_SPECS[critter.kind];
    critter.dropsCreated = true;
    critter.mode = "dead";
    critter.health = 0;
    critter.deathTimer = 0.7;
    if (spec.meat > 0) this.ctx.createDrop(critter, "raw-meat", -0.6, spec.meat);
    if (spec.hide > 0) this.ctx.createDrop(critter, "hide", 0.6, spec.hide);
    // 长角羚是唯一会掉水的猎物：沙漠里猎杀大型有蹄类取体液是真实做法。
    if (spec.water > 0) this.ctx.createDrop(critter, "water", 1.8, spec.water);
    this.ctx.emit({ type: "critter-killed", critterId: critter.id, kind: critter.kind });
  }
}
