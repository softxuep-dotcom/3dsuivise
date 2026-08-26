import { clamp, direction, distance, distanceSquared, dot, TAU } from "./geometry";
import { isTerrainWalkable } from "../terrain/TerrainModel";
import { BARRIER_STATS, STONE_COLLIDE_RADIUS, STRUCTURE_SPECS, WOLF_RADIUS } from "./types";
import type { NavigationGrid } from "./NavigationGrid";
import type { DifficultyTuning } from "./difficulty";
import type {
  CampDefinition, GameEvent, GroundItem, InventoryItemKind, Phase, PlacedStructure,
  PlayerState, Vec2, WolfKind, WolfRole, WolfState, WorldDefinition,
} from "./types";

const MAX_WOLVES = 120;

/** 前三夜总放出量；第 4 夜起回到后期公式。 */
const EARLY_NIGHT_WOLF_TARGETS = [30, 45, 60] as const;

/** 前三夜真正扑向玩家/营地的固定配额，避免独立抽签造成难度尖峰。 */
const EARLY_NIGHT_RAID_TARGETS = [5, 9, 14] as const;

/**
 * 攻营犬**分波**动身，一夜三波。
 *
 * 为什么非要排这个班：刷怪间隔是 0.7 + progress^0.8 × 3.3 秒，积分下来
 * **30 只狗全在夜晚的前 45 秒刷完**；而它们从同一个巢口出发、跟同一张流场、
 * 速度只差一点，于是排着队一起到 —— 实测第 1 夜五只攻营犬的到达时刻是
 * 63/64/65/66/68 秒，相邻间隔 0.4~2.5 秒，之后一百多秒一只不来。
 * 玩家看到的就是"几只狗同时出现"，然后整夜没事。
 *
 * **分波而不是一只一只放**：把 5 只摊成 5 个单独时刻试过，那不叫"陆续到达"，
 * 那叫"一整夜零星来五只"，而且落单的那只在台地营地经常自己卡在坡下 ——
 * 实测风脊营地整夜只剩 1 只摸到玩家（回归测试要求至少 2 只）。
 * 一波两三只则既有节奏又有分量：一波打完能喘口气，喘完下一波又来。
 *
 * 末尾留出的那 40% 是给路上用的：巢到营地约 53 米，跑完要三十多秒，
 * 最后一波再晚就赶不上天亮前咬到人了。
 */
const RAID_WAVES_PER_NIGHT = 3;
/**
 * 一波至少这么多只。
 *
 * 台地营地（风脊）逼出来的下限：单只狗常常自己卡在坡下十来米上不来，
 * 而两三只挤在同一条坡道上会互相推着过去 —— 实测第 1 夜按"五只摊成五个时刻"
 * 放，风脊整夜只有 1 只摸到玩家；按每波 2~3 只放就回到 2 只以上。
 * 所以波数不是死的 3，而是"先保证每波有分量，再看能分几波"。
 */
const RAID_MIN_WAVE_SIZE = 2.5;
const RAID_RELEASE_WINDOW = 0.6;
/** 同一波内的错身抖动（占一波间隔的比例）：一起来，但不要像列队一样整齐。 */
const RAID_RELEASE_JITTER = 0.16;

/**
 * 远处的狼降频更新。
 *
 * 实测（夜里 40 狼 + 52 猎物，台式 CPU）：`sim.update` 每帧 2.05 ms，其中
 * `updateWolves` 占 1.38 ms = 67.6%。而渲染层整条 CPU 路径才 0.87 ms ——
 * **模拟层比渲染贵 2.3 倍**，且台式机上的 2.9 ms 换到低端安卓（单线程慢 10~20 倍）
 * 就是 29~58 ms，而 25 fps 的帧预算只有 40 ms。Poki 的 MEDIAN FPS 被便宜安卓拖着，
 * 所以真正该省的是主线程 JS，不是 GPU。
 *
 * 钱花在哪：`updateWolf` 里的 findBlockingItem **对每只狼遍历全部 ~97 件地物**，
 * 40 只狼就是每帧近 4000 次检查 —— 而其中 92% 的狼在 45 米外，根本没画出来。
 *
 * 50 米这个半径：渲染层的剔除线是 45 米，这里留 5 米余量，
 * **保证凡是画得出来的狼都是满帧更新的**，降频只发生在看不见的地方。
 *
 * 攒时间而不是直接乘 N：帧长本来就抖，`lodAccum` 把跳过的那几帧原样攒起来，
 * 轮到它时一次交清。狼走的距离、冷却、计时器因此和满帧完全一致，
 * 只是位置更新变成一跳一跳的 —— 反正没人看得见。
 */
const LOD_DISTANCE = 50;
/** 远处狼每几帧更新一次。按 id 错开，避免每 N 帧集中爆一次。 */
const LOD_STRIDE = 4;

const REST_COMBAT_LOCK = 6;

/** 小狼与大狼的数值封顶在第几夜。到这一夜为止照常成长，之后不再变强。 */
const PACK_SCALING_MAX_DAY = 3;

/** Dawn withdrawal cadence: small packs peel away instead of the whole raid vanishing at once. */
const RETREAT_BATCH_SIZE = 5;

const RETREAT_BATCH_INTERVAL = 2.4;

const RETREAT_WITHIN_BATCH_STAGGER = 0.22;

/**
 * 守巢的大狼数量、仇恨半径，以及它们离锚点多远就放弃追击折回。
 *
 * 14 米这个数是从布局倒推的：三桶油就在守卫脚下（2~5 米），所以去拿桶必定惊动它们；
 * 而卡车停在 30 米外，所以走到车边、装车、发车全程都不会拉到仇恨。
 * 「先去看车、再决定要不要打」因此是一个能安全做出的判断。
 */
const DEN_GUARD_COUNT = 5;

const GUARD_AGGRO_RADIUS = 14;

const GUARD_LEASH = 22;

/**
 * 狼群 AI 需要的外部世界。
 *
 * 这个接口就是**这次拆分的全部意义**：狼群和模拟层之间原本有三十来处隐式耦合，
 * 散在 3600 行里根本看不出来。列成一张表之后，"狼群到底依赖什么"变成一个
 * 可以一眼读完、也可以逐条削减的问题 —— 下一刀该往哪切，看这张表就知道。
 *
 * 读多写少：只有 combatTimer 是狼群要回写的（咬到人要封锁休息），
 * 所以它走 setCombatTimer 而不是直接暴露字段。
 */
export interface WolfWorld {
  readonly world: WorldDefinition;
  readonly player: PlayerState;
  readonly items: GroundItem[];
  readonly structures: PlacedStructure[];
  readonly navigation: NavigationGrid;
  readonly retreatNavigations: NavigationGrid[];
  readonly tuning: DifficultyTuning;
  readonly phase: Phase;
  readonly phaseTime: number;
  readonly day: number;
  readonly elapsed: number;
  readonly reviveGrace: number;
  random(): number;
  emit(event: GameEvent): void;
  /** 统一记录玩家受到的狼伤害，供结算页精确区分“被咬死”和自然耗尽。 */
  damagePlayer(amount: number, attacker: WolfState): void;
  setCombatTimer(seconds: number): void;
  noteActivity(): void;
  getDefense(): number;
  getPhaseDuration(): number;
  getPlayerShelter(): CampDefinition | null;
  createDrop(position: Vec2, kind: InventoryItemKind, angleOffset: number, count?: number): void;
  moveEntity(entity: Vec2, dx: number, dz: number, radius: number, collideWithItems: boolean,
    terrainSlopeAllowance?: number): void;
  canStepToward(from: Vec2, dir: Vec2, radius?: number, collideWithItems?: boolean): boolean;
  findSteppableDirection(from: Vec2, desired: Vec2, collideWithItems?: boolean): Vec2 | null;
  findNearestWalkablePoint(origin: Vec2): Vec2;
  lineOfSightBlocked(start: Vec2, end: Vec2): boolean;
  hasMeleeLine(start: Vec2, end: Vec2): boolean;
  distanceToWorldEdge(point: Vec2): number;
  getSteeredDirection(entity: Vec2, desired: Vec2): Vec2;
  getBarrierDamage(wolf: WolfState, armor: number): number;
  /**
   * 玩家护甲的闪避 / 反伤。狼群只需要这两个数，不该把整张 ARMOR_STATS 表
   * 和四条护甲线的知识搬进来 —— 那是玩家侧的事。
   */
  getPlayerArmor(): { dodge: number; thorns: number };
  isBlockingGroundItem(item: GroundItem): boolean;
}

/**
 * 夜袭犬、白天的野狗、守巢犬 —— 出生、感知、寻路、攻击、撤退、死亡掉落，全在这里。
 *
 * 从 GameSimulation 里切出来的第一刀（738 行）。选它打头是因为：
 * 2026-08 那一串"狗站着不动"的 bug 五个全在这块，而它和五轴生存模型几乎不耦合，
 * 切口最干净。
 */
export class WolfDirector {
  readonly wolves: WolfState[] = [];
  private wolfId = 0;
  private spawnCountdown = 3;
  private spawnedThisNight = 0;
  /** LOD 错峰用的帧计数，见 LOD_STRIDE。 */
  private lodFrame = 0;
  private raidersSpawnedThisNight = 0;
  private wildRespawnCountdown = 0;
  /** 今晚计划放出的攻营犬总数，见 getRaidQuota。 */
  private raidQuotaThisNight = 1;

  constructor(private readonly ctx: WolfWorld) {}

  /** 入夜：重置本夜的刷怪配额。相位由 GameSimulation 掌管，狼群只负责自己的计数。 */
  beginNight(): void {
    this.spawnCountdown = 0.45;
    this.spawnedThisNight = 0;
    this.raidersSpawnedThisNight = 0;
    this.raidQuotaThisNight = this.getRaidQuota();
  }

  /**
   * 今晚一共会有几只攻营犬 —— 排放行班次要先知道分母。
   *
   * 前三夜是写死的配额（乘难度倍率）；第 4 夜起走概率式，那就用期望值，
   * 反正只是用来均分时间窗，差一两只不影响节奏。
   */
  private getRaidQuota(): number {
    const base = EARLY_NIGHT_RAID_TARGETS[this.ctx.day - 1];
    if (base !== undefined) return Math.max(1, Math.round(base * this.ctx.tuning.raid));
    const chance = Math.min(1, Math.min(0.35, 0.2 + (this.ctx.day - 1) * 0.05) * this.ctx.tuning.raid);
    return Math.max(1, Math.round(this.getNightWolfTarget() * chance));
  }

  /**
   * 这一只该跟着第几波动身，换算成绝对时刻。返回 0 表示"现在就走"。
   *
   * 波次按**出生顺序**分组（第 1~2 只是第一波、第 3~4 只是第二波……），
   * 而不是按时间分组 —— 刷怪全挤在前 45 秒，按时间分会把整夜的狗都塞进第一波。
   *
   * 已经过去的夜晚时间要扣掉：第 5 只出生时夜晚才走了三十几秒，
   * 而它那一波排在 50% 处，真正的等待就发生在这个差值上。
   */
  private scheduleRaidRelease(): number {
    const quota = Math.max(1, this.raidQuotaThisNight);
    const waveCount = clamp(Math.round(quota / RAID_MIN_WAVE_SIZE), 1, RAID_WAVES_PER_NIGHT);
    const waveSize = Math.max(1, Math.ceil(quota / waveCount));
    // raidersSpawnedThisNight 在调用处已经自增过，所以这里减 1 回到 0 基。
    const wave = Math.min(waveCount - 1, Math.floor((this.raidersSpawnedThisNight - 1) / waveSize));
    const nightDuration = this.ctx.getPhaseDuration();
    const nightElapsed = nightDuration - this.ctx.phaseTime;
    const window = nightDuration * RAID_RELEASE_WINDOW;
    const gap = window / waveCount;
    const jitter = (this.ctx.random() - 0.5) * gap * RAID_RELEASE_JITTER * 2;
    const releaseIn = (wave + 0.5) * gap + jitter - nightElapsed;
    // 半秒以内的等待没有意义，直接放行 —— 第一波多半落在这里。
    return releaseIn > 0.5 ? this.ctx.elapsed + releaseIn : 0;
  }

  /** 天亮：白天的野狗过两秒开始补员。 */
  beginDay(): void {
    this.wildRespawnCountdown = 2;
  }

  /**
   * 守巢的五只大狼，开局就站在巢边那组油桶旁。
   *
   * 它们和夜袭犬是两回事：不随夜晚刷新、天亮不撤退、死了不补 ——
   * 打赢一次就永久打开了那条近路。这是"升级装备"这条线唯一的实质回报，
   * 所以必须是一次性的：会重生的话，玩家没有理由为它投资装备。
   */
  seedDenGuards(): void {
    const guarded = this.ctx.world.barrels.filter((barrel) => barrel.guarded);
    if (guarded.length === 0) return;
    const centre = {
      x: guarded.reduce((sum, barrel) => sum + barrel.x, 0) / guarded.length,
      z: guarded.reduce((sum, barrel) => sum + barrel.z, 0) / guarded.length,
    };
    for (let index = 0; index < DEN_GUARD_COUNT; index += 1) {
      const angle = (index / DEN_GUARD_COUNT) * TAU + 0.4;
      this.spawnWolf({
        role: "guard",
        forceKind: "large",
        origin: this.ctx.findNearestWalkablePoint({
          x: centre.x + Math.cos(angle) * 4.8,
          z: centre.z + Math.sin(angle) * 4.8,
        }),
      });
    }
  }

  /**
   * 把半径内的狗推到半径外，并让它们暂时丢失目标。
   *
   * **不能只算一次落点**：直接沿"背离玩家"推出去，落点常常是崖壁或陡坡，
   * 而 findNearestWalkablePoint 会把它拉回最近的可走格 —— 那一拉很可能又回到圈里。
   * 实测第一版 8 只只推走 5 只，剩下 3 只贴着玩家，复活的意义直接没了。
   *
   * 所以改成**沿它原来的方位扇形试角度**：先试正背面，不行就左右各偏 22.5° 一路扫，
   * 找到第一个既可走、又确实在圈外的落点。狗因此仍然大致留在它原来那一侧，
   * 只是被顶开了 —— 比统一丢到某个方向自然。
   */
  pushWolvesAway(radius: number): void {
    const target = radius + 1.5;
    for (const wolf of this.wolves) {
      if (wolf.mode === "dead") continue;
      if (distance(wolf, this.ctx.player) >= radius) continue;
      const bearing = distance(wolf, this.ctx.player) < 0.001
        ? this.ctx.random() * TAU
        : Math.atan2(wolf.z - this.ctx.player.z, wolf.x - this.ctx.player.x);
      let placed: Vec2 | null = null;
      for (let step = 0; step < 16 && !placed; step += 1) {
        // 0, +22.5°, −22.5°, +45°, −45° … 从正背面往两边扫。
        const offset = Math.ceil(step / 2) * (Math.PI / 8) * (step % 2 === 0 ? 1 : -1);
        const angle = bearing + offset;
        const candidate = {
          x: clamp(this.ctx.player.x + Math.cos(angle) * target, -this.ctx.world.size / 2 + 1, this.ctx.world.size / 2 - 1),
          z: clamp(this.ctx.player.z + Math.sin(angle) * target, -this.ctx.world.size / 2 + 1, this.ctx.world.size / 2 - 1),
        };
        if (!isTerrainWalkable(this.ctx.world, candidate)) continue;
        if (distance(candidate, this.ctx.player) < radius) continue;
        placed = candidate;
      }
      if (placed) {
        wolf.x = placed.x;
        wolf.z = placed.z;
      }
      // 找不到落点的极端情况（四面都是崖）也要断掉仇恨，别让它贴脸继续咬。
      wolf.mode = "patrol";
      wolf.lostTimer = 0;
      wolf.attackCooldown = Math.max(wolf.attackCooldown, 1.2);
    }
  }

  /**
   * 刀线击退。
   *
   * 真正值钱的是 `knockbackStun` 那一项，不是推开的距离 —— 狼移速 3~5 m/s，
   * 0.7 米两百毫秒就走回来了；但狼的咬击间隔是 1.15 秒，你每 0.55 秒给它
   * +0.4 秒，等于把它的输出压掉七成。乘上"同时打五六只"，这就是刀线守夜能力
   * 的真正来源 —— 不在伤害上，在减伤上。
   *
   * 精英狼体型太重，免疫击退；它仍然只是普通狼种，不再拥有独立 BOSS 逻辑。
   */
  applyKnockback(wolf: WolfState, stats: { knockback: number; knockbackStun: number }): void {
    if (stats.knockback <= 0 || wolf.kind === "elite") return;
    wolf.attackCooldown += stats.knockbackStun;
    const away = direction(this.ctx.player, wolf);
    // 击退也必须走完整路障碰撞。旧代码把 collideWithItems 关掉，刀一挥就能把狼
    // 推进石头或树桩内部，下一帧的“推出重叠”再把它弹到路障另一侧，看起来就是穿墙。
    this.ctx.moveEntity(wolf, away.x * stats.knockback, away.z * stats.knockback, WOLF_RADIUS, true);
    this.ctx.emit({ type: "knockback", wolfId: wolf.id });
  }

  updateWolves(delta: number): void {
    this.updateWildWolves(delta);
    const livingCount = this.wolves.filter((wolf) => wolf.mode !== "dead").length;
    const target = this.getNightWolfTarget();
    if (this.ctx.phase === "night" && livingCount < MAX_WOLVES && this.spawnedThisNight < target) {
      this.spawnCountdown -= delta;
      if (this.spawnCountdown <= 0) {
        this.spawnWolf({ role: "raider" });
        this.spawnedThisNight += 1;
        const nightProgress = clamp(1 - this.ctx.phaseTime / this.ctx.getPhaseDuration(), 0, 1);
        const nightlyPressure = Math.max(0.78, 1 - (this.ctx.day - 1) * 0.09);
        // 刷怪间隔曲线整体压缩：从 0.9~5.7s 缩到 0.7~4.0s，前期更密集
        const curvedInterval = 0.7 + Math.pow(nightProgress, 0.8) * 3.3;
        this.spawnCountdown = curvedInterval * nightlyPressure * this.ctx.tuning.spawnInterval * (0.85 + this.ctx.random() * 0.3);
      }
    }

    // 放狼/撤退这两道闸每帧都查：它们只是和 elapsed 比大小，便宜，
    // 而且晚一帧放狼会让整波节奏漂掉。贵的是 updateWolf，只有它降频。
    this.lodFrame += 1;
    const lodCutoff = LOD_DISTANCE * LOD_DISTANCE;
    for (const wolf of this.wolves) {
      if (wolf.raidAt > 0 && this.ctx.elapsed >= wolf.raidAt) this.releaseRaider(wolf);
      if (wolf.retreatAt > 0 && this.ctx.elapsed >= wolf.retreatAt) this.beginRetreat(wolf);
      if (distanceSquared(wolf, this.ctx.player) > lodCutoff) {
        wolf.lodAccum += delta;
        if ((wolf.id + this.lodFrame) % LOD_STRIDE !== 0) continue;
      }
      this.updateWolf(wolf, wolf.lodAccum > 0 ? wolf.lodAccum + delta : delta);
      wolf.lodAccum = 0;
    }
    for (let index = this.wolves.length - 1; index >= 0; index -= 1) {
      const wolf = this.wolves[index];
      if (wolf.mode === "dead" && wolf.deathTimer <= 0) this.wolves.splice(index, 1);
      else if (wolf.mode === "retreating" && (
        this.isAtWorldEdge(wolf)
        || wolf.lostTimer >= 34
        || (wolf.lostTimer >= 18 && distanceSquared(wolf, this.ctx.player) > 45 * 45)
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
    // 夜袭狼靠视野主动锁定；白天的普通野狼只有被激怒后才会追击；精英狼与守巢犬昼夜都在猎杀。
    const hunting = wolf.kind === "elite" || wolf.role === "guard" ? true
      : wolf.role === "wild" ? wolf.provoked
        : this.ctx.phase === "night";
    const canSeePlayer = hunting && wolf.mode !== "retreating" && this.wolfCanSeePlayer(wolf);
    if (canSeePlayer) {
      wolf.mode = "chase";
      wolf.lostTimer = 0;
      // 守油犬是一组岗哨，不是五个互不通气的野怪。惊动其中一只，其余四只同时出动，
      // 否则玩家仍能贴着警戒圈逐只拉走，增加数量只会变成重复五次同一场单挑。
      if (wolf.role === "guard") {
        for (const guard of this.wolves) {
          if (guard.role !== "guard" || guard.mode === "dead") continue;
          guard.mode = "chase";
          guard.lostTimer = 0;
        }
      }
    } else if (wolf.mode === "chase") {
      wolf.lostTimer += delta;
      // 守巢犬的绳子短得多（22 米对 38 米）：它们的职责是看住那三桶油，
      // 不是满图追人。绳子短，"把它们引开再回来偷桶"才有可能不成立 ——
      // 想要那三桶就得真打赢，这正是这条路线该有的价格。
      const leash = wolf.role === "guard" ? GUARD_LEASH : 38;
      const beyondLeash = distance(wolf, wolf.anchor) > leash;
      if ((wolf.lostTimer > 4.5 && distance(wolf, this.ctx.player) > 13) || beyondLeash) {
        /*
         * 追丢之后**攻营犬回 raid，不是回 patrol**。
         *
         * 旧写法一律退回 patrol，而 patrol 只绕自己的锚点转圈，且**没有任何一条
         * 边通回 raid** —— 于是每只攻营犬这一夜只有一次机会：扑上来、被躲开或
         * 被打退一次，就永久变成一只在营地外 12~22 米绕圈的观光犬。
         *
         * 实测（会动的玩家、第 1 夜、五座营地各跑满 180 秒）：配额 5 只攻营犬
         * 全部在中途退回巡逻，营地 0 整夜只累计 26 狗秒进入咬击距离 ——
         * 屏幕上就是"狼跑过来又跑走，真咬到人的没几只"。
         *
         * raid 模式跟的是每 0.65 秒朝玩家重建一次的流场，所以回 raid = 重新找路
         * 扑过来，而不是原地发呆。天亮的撤退调度先把 retreatAt 打上再切 patrol，
         * 所以这里要放过已排队撤退的狗，否则黎明那批会掉头回来。
         */
        wolf.mode = wolf.raider && wolf.raidAt <= 0 && wolf.retreatAt <= 0 && this.ctx.phase === "night"
          ? "raid"
          : "patrol";
        wolf.lostTimer = 0;
      }
    }

    let target: Vec2;
    if (wolf.mode === "retreating") {
      target = wolf.anchor;
    } else if (wolf.mode === "entering") {
      target = wolf.anchor;
      // 排到班还没到点的攻营犬，先当巡逻犬在巢边待着（raidAt 到点后由 releaseRaider 切进 raid）。
      if (distanceSquared(wolf, wolf.anchor) < 3 * 3) {
        wolf.mode = wolf.raider && wolf.raidAt <= 0 ? "raid" : "patrol";
      }
    } else if (wolf.mode === "chase") {
      target = this.ctx.player;
    } else if (wolf.mode === "raid") {
      target = this.getRaidTarget();
      if (distanceSquared(wolf, this.ctx.player) < 15 * 15) wolf.mode = "chase";
    } else {
      wolf.patrolAngle += delta * (0.22 + (wolf.id % 5) * 0.015);
      target = {
        x: wolf.anchor.x + Math.cos(wolf.patrolAngle) * 7,
        z: wolf.anchor.z + Math.sin(wolf.patrolAngle * 0.83) * 5,
      };
    }

    const playerDistance = distance(wolf, this.ctx.player);
    if (wolf.mode === "chase" && playerDistance < 1.75 && this.ctx.hasMeleeLine(wolf, this.ctx.player)) {
      if (wolf.attackCooldown <= 0) {
        wolf.attackCooldown = 1.15;
        const armor = this.ctx.getPlayerArmor();
        this.ctx.setCombatTimer(REST_COMBAT_LOCK);
        this.ctx.noteActivity();
        // 闪避在减防御**之前**判定，闪掉的是整次咬击。
        // 但"挨打后 6 秒不能休息"的锁照常上 —— 闪开了也还是在战斗里。
        if (armor.dodge > 0 && this.ctx.random() < armor.dodge) {
          this.ctx.emit({ type: "dodge" });
          return;
        }
        // 复活后的无敌窗口：伤害整个免掉，但受击特效照常 ——
        // 玩家要看得见"它咬到我了、只是没扣血"，否则会以为狗卡住了。
        const damage = this.ctx.reviveGrace > 0 ? 0 : Math.max(1, wolf.attack - this.ctx.getDefense());
        this.ctx.damagePlayer(damage, wolf);
        this.ctx.player.hurtFlash = 0.3;
        this.ctx.emit({ type: "player-hit", amount: damage });
        // 反伤按狼**未经防御削减**的原始攻击力算 —— 它咬的是一身铁，
        // 崩到几颗牙跟你穿得多厚没关系。
        if (armor.thorns > 0) {
          const reflected = Math.max(1, Math.round(wolf.attack * armor.thorns));
          wolf.health -= reflected;
          wolf.hurtFlash = 0.18;
          wolf.provoked = true;
          this.ctx.emit({ type: "thorns", wolfId: wolf.id, amount: reflected });
          if (wolf.health <= 0) {
            wolf.mode = "dead";
            this.killWolf(wolf);
          }
        }
      }
      return;
    }

    let desired = direction(wolf, target);
    // 攻营犬**始终**跟流场走；追击犬在直线被挡时才切过去。
    //
    // 差别在于攻营是长途（狗巢到营地 53 米，中间要翻一道沙脊、再爬一条回头弯坡道），
    // 而"直线被挡"这个判定只看两点之间，走到崖脚前它一直是 false —— 狼于是笔直
    // 撞上崖壁，等判定终于变 true 时它已经贴死在坡面上，流场也拉不动了。
    if (wolf.mode === "raid") desired = this.ctx.navigation.directionFrom(wolf);
    else if (wolf.mode === "chase"
      && (this.ctx.lineOfSightBlocked(wolf, this.ctx.player) || !this.ctx.canStepToward(wolf, desired))) {
      // 「看不见」之外还要加一条「迈不动」。
      //
      // 站在营地崖脚抬头看台上的玩家，视线是**通的** —— 于是旧代码判定"直线可用"，
      // 让狗笔直顶着崖壁走。而那个方向每一帧都被 canTraverseTerrain 拒掉，
      // 狗就一动不动地站在下面盯着人，一整夜都不上来。视线和可通行是两回事，
      // 拿前者代替后者，恰好在落差地形上必错。
      desired = this.ctx.navigation.directionFrom(wolf);
    }
    // Retreats always follow a terrain-aware flow field. A straight line to the
    // edge can look clear while still crossing an unwalkable heightfield slope.
    if (wolf.mode === "retreating") desired = this.getRetreatNavigation(wolf).directionFrom(wolf);
    // 树桩挡在前面时先拆桩 —— 这正是它存在的意义：把狼的时间从"咬你"换成"咬木头"。
    const blockingStructure = wolf.mode === "retreating" ? null : this.findBlockingStructure(wolf, desired);
    if (blockingStructure) {
      if (wolf.attackCooldown <= 0) {
        wolf.attackCooldown = 0.95;
        blockingStructure.hp -= this.ctx.getBarrierDamage(wolf, STRUCTURE_SPECS[blockingStructure.kind].armor);
        this.ctx.emit({ type: "barrier-hit", itemId: -1 - blockingStructure.id, material: "wood" });
        if (blockingStructure.hp <= 0) {
          blockingStructure.active = false;
          this.ctx.emit({ type: "structure-destroyed", kind: blockingStructure.kind });
        }
      }
      return;
    }

    const blockingItem = wolf.mode === "retreating" ? null : this.findBlockingItem(wolf, desired);
    if (blockingItem) {
      const obstacleRadius = blockingItem.kind === "stone" ? STONE_COLLIDE_RADIUS : 0.62;
      const attackReach = WOLF_RADIUS + obstacleRadius + 0.2;
      const barrierDistance = distance(wolf, blockingItem);
      if (barrierDistance > attackReach) {
        // Once a wolf commits to breaching a barrier, approach that barrier
        // directly instead of running it through getSteeredDirection(). The
        // generic item avoidance starts farther out than bite range and used
        // to turn wolves around before they could ever damage a boulder.
        const approach = direction(wolf, blockingItem);
        wolf.facing = approach;
        const pace = wolf.mode === "chase"
          ? wolf.speed * (wolf.role === "guard" ? 1.7 : 1.2)
          : wolf.speed;
        this.ctx.moveEntity(
          wolf,
          approach.x * pace * delta,
          approach.z * pace * delta,
          WOLF_RADIUS,
          true,
        );
        return;
      }
      if (wolf.attackCooldown <= 0) {
        wolf.attackCooldown = 0.95;
        const barrierDamage = this.ctx.getBarrierDamage(wolf, BARRIER_STATS[blockingItem.kind].armor);
        blockingItem.hp -= barrierDamage;
        this.ctx.emit({
          type: "barrier-hit",
          itemId: blockingItem.id,
          material: blockingItem.kind === "stone" ? "stone" : "wood",
        });
        if (blockingItem.hp <= 0) blockingItem.active = false;
      }
      return;
    }

    let steered = this.ctx.getSteeredDirection(wolf, desired);
    /*
     * 最后一道兜底：选定的方向迈不动，就在它左右张开找一个迈得动的。
     *
     * 巡逻犬**不走流场**（它绕的是自己的锚点，不是玩家），所以一旦被地形卡住
     * 就没有任何恢复手段 —— 上面那些流场修复一条都轮不到它。实测岩壁洞窟外
     * 有四只狗以 flow=UNREACHABLE 的姿态一动不动站到天亮，就是这一类。
     * 撤退犬**也**要走这里。它自带的解卡只放宽**坡度**，对墙体碰撞毫无作用 ——
     * 实测天亮后 27 只狗全部卡在离地图边缘 30.2 米处，`retreating` 状态挂了 200 秒
     * 一步没动，就是被墙顶住而坡度放宽救不了。
     */
    // 撤退犬在 moveEntity 里是 collideWithItems = false 的，探针也必须用同一个值，
    // 否则它会误判"这边有石头走不了"，而实际它根本不撞石头。
    const collideWithItems = wolf.mode !== "retreating";
    if (!this.ctx.canStepToward(wolf, steered, WOLF_RADIUS, collideWithItems)) {
      steered = this.ctx.findSteppableDirection(wolf, steered, collideWithItems) ?? steered;
    }
    wolf.facing = steered;
    const pace = wolf.mode === "retreating"
      ? wolf.speed * 1.45
      : wolf.mode === "chase"
        ? wolf.speed * (wolf.role === "guard" ? 1.7 : 1.2)
        : wolf.speed;
    const beforeX = wolf.x;
    const beforeZ = wolf.z;
    /*
     * 卡住就逐步放宽坡度限制 —— 撤退一直有这个机制，现在**所有模式**都有。
     *
     * 为什么非要有：pushOutsideCircle 完全不看地形，被墙推一下就可能把狗放到
     * 一个四面都迈不出去的点上（连上面那圈扇形试探也一个方向都找不到）。
     * 那时它不是"被崖壁挡住"，是**掉进地形里出不来**，会一直站到天亮。
     *
     * 追击/巡逻的上限压到 1.9，远低于撤退的 3.2：这只够它挪回可走地面，
     * 不足以让它顺着崖壁爬上营地台面 —— 回归测试里玩家和狗都仍然上不去。
     * 而且它只在"这一帧确实没挪动"时才累积，一旦动起来立刻归零，
     * 所以正常情况下永远是 1。
     */
    const stuckAllowance = wolf.mode === "retreating"
      ? Math.min(3.2, 1.55 + wolf.retreatStuckTimer * 0.9)
      : Math.min(1.9, 1 + wolf.retreatStuckTimer * 0.6);
    this.ctx.moveEntity(
      wolf,
      steered.x * pace * delta,
      steered.z * pace * delta,
      WOLF_RADIUS,
      wolf.mode !== "retreating",
      stuckAllowance,
    );
    const advanced = Math.hypot(wolf.x - beforeX, wolf.z - beforeZ);
    wolf.retreatStuckTimer = advanced < pace * delta * 0.12 ? wolf.retreatStuckTimer + delta : 0;
  }

  /**
   * 到点动身：这只攻营犬从"在巢边等着"切进 raid。
   *
   * 锚点**在这一刻才算**，不在出生时算 —— 它是这只狗被打退后要退回去的地方，
   * 而玩家在等待的这几十秒里完全可能换了营地。出生时定死的话，
   * 前半夜刷出来的那几只会退回一座玩家早就离开的空营地。
   */
  private releaseRaider(wolf: WolfState): void {
    wolf.raidAt = 0;
    if (wolf.mode === "dead" || wolf.mode === "retreating") return;
    wolf.mode = "raid";
    wolf.lostTimer = 0;
    const centre = this.ctx.getPlayerShelter() ?? this.ctx.player;
    const angle = this.ctx.random() * TAU;
    const spread = 12 + this.ctx.random() * 10;
    wolf.anchor = this.ctx.findNearestWalkablePoint({
      x: centre.x + Math.cos(angle) * spread,
      z: centre.z + Math.sin(angle) * spread,
    });
  }

  private beginRetreat(wolf: WolfState): void {
    if (wolf.mode === "dead") return;
    const half = this.ctx.world.size / 2 + 2;
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
    wolf.retreatAt = 0;
    wolf.retreatStuckTimer = 0;
    wolf.attackCooldown = 0;
  }

  scheduleRaiderRetreat(): void {
    const raiders = this.wolves
      .filter((wolf) => wolf.role === "raider" && wolf.mode !== "dead")
      // Wolves already near an edge form the first packs, keeping later packs
      // visible around the camps while the withdrawal unfolds.
      .sort((a, b) => this.ctx.distanceToWorldEdge(a) - this.ctx.distanceToWorldEdge(b) || a.id - b.id);

    for (let index = 0; index < raiders.length; index += 1) {
      const wolf = raiders[index];
      const batch = Math.floor(index / RETREAT_BATCH_SIZE);
      const withinBatch = index % RETREAT_BATCH_SIZE;
      wolf.mode = "patrol";
      wolf.provoked = false;
      wolf.anchor = { x: wolf.x, z: wolf.z };
      wolf.lostTimer = 0;
      // 天亮了就别再放行了 —— 还排着班的那几只直接跟着撤，不然会在黎明反向冲一波。
      wolf.raidAt = 0;
      wolf.retreatStuckTimer = 0;
      wolf.retreatAt = this.ctx.elapsed
        + 0.6
        + batch * RETREAT_BATCH_INTERVAL
        + withinBatch * RETREAT_WITHIN_BATCH_STAGGER
        + this.ctx.random() * 0.18;
    }
  }

  private getRetreatNavigation(wolf: WolfState): NavigationGrid {
    const horizontalExit = Math.abs(wolf.anchor.x) > this.ctx.world.size / 2;
    if (horizontalExit) return this.ctx.retreatNavigations[wolf.anchor.x < 0 ? 0 : 1];
    return this.ctx.retreatNavigations[wolf.anchor.z < 0 ? 2 : 3];
  }

  private isAtWorldEdge(wolf: WolfState): boolean {
    const edge = this.ctx.world.size / 2 - WOLF_RADIUS - 1;
    return Math.abs(wolf.x) >= edge || Math.abs(wolf.z) >= edge;
  }

  killWolf(wolf: WolfState): void {
    if (wolf.dropsCreated) return;
    wolf.dropsCreated = true;
    wolf.mode = "dead";
    wolf.retreatAt = 0;
    wolf.retreatStuckTimer = 0;
    wolf.health = 0;
    wolf.deathTimer = 0.8;
    this.ctx.player.kills += 1;

    // 守巢犬和白天的野狼掉一样的东西 —— 它们本来就是大狼，
    // 而且打赢它们的即时回报是那三桶油，掉落只是顺带。
    if (wolf.role === "guard") {
      this.ctx.createDrop(wolf, "raw-meat", -0.65, 2);
      this.ctx.createDrop(wolf, "hide", 0.65, 2);
      this.ctx.createDrop(wolf, "wolf-fang", 0, 1);
    }

    // 夜袭狼**什么都不掉**。
    // 这条把"守夜"和"打猎"彻底拆开 —— 夜里打赢只是活下来，资源必须白天出去拿。
    //
    // 不只是为了还原：一夜刷 40~90 只，按每只 1~2 块肉算就是几十上百块，
    // 而一个昼夜只需要约 6 块熟肉。夜袭掉落等于把食物供给放大十几倍，
    // 饥饿和体力这两条轴因此永远咬不住人。
    //
    /*
     * ……唯一的例外是**第一夜那只教学犬**，它掉 1 张兽皮。
     *
     * 第一夜原本是**纯风险零回报**：熬过 150 秒，手上什么也没多。对新手来说
     * 这是最差的留存形状 —— 而 Player Fit（1.0.14，n=500）里最高的一根柱子
     * 正好落在第一夜，录像显示大部分人没死就走了。给一件带得走的东西，
     * 天亮那一刻才有"我赚到了"而不是"我白熬了"。
     *
     * 三条边界让它不动经济：
     *
     *   只给教学犬，不给整夜。 第一夜配额 5 只，全给就是 5 张皮，等于把
     *     "白天出门打野狗攒皮"整条循环跳过去。教学犬是写死的剧本
     *     （28 血 / 5 咬伤 / 0 防），也是第一夜唯一一只必定打得赢的。
     *   给皮不给肉。 熟肉 +38 饱食，是真的能松动饥饿轴的东西。
     *
     * **2026-08-26 更正**：这段原本写着"1 张兽皮什么都做不了（兽皮衣要 4 张），
     * 它的全部价值是手里有个战利品"。**那是错的** —— 漏看了 sword-1：
     * 兽皮 ×1 + 枯木 ×2，而且 needsFire: false。也就是说这一张皮不是纪念品，
     * 它是**通往第一件装备最近的一步**，只差两根柴。
     *
     * 而开局口粮里柴是 0（见 balance/world.ts 的 STARTING_RATION），所以那张皮
     * 到手的时刻，玩家多半凑不齐 —— 就算捡到过柴，也多半烧掉了。
     * 这个时序错配是不是 94% 造不出装备的主因，已经挂上遥测（equip|ready），
     * 见 platform/RunProgress.ts。别再照着"这张皮没用"的前提做决定。
     *   数量写死 1。 不吃 kind、不吃难度倍率 —— 这一只本来就不吃那些。
     *
     * 顺带教会一件事：打死东西会掉东西。在这之前玩家没有任何理由相信这一点。
     */
    if (wolf.tutorial) this.ctx.createDrop(wolf, "hide", 0, 1);

    if (wolf.role === "wild") {
      const bulk = wolf.kind === "elite" ? 3 : wolf.kind === "large" ? 2 : 1;
      this.ctx.createDrop(wolf, "raw-meat", -0.65, bulk);
      this.ctx.createDrop(wolf, "hide", 0.65, bulk);
      // 狼牙：三阶装备的共同门槛，**只有白天的大狼和精英狼**掉。
      //
      // 大狼占比是 min(0.58, 0.22 + (天数−1)×0.09)，第 1 天只有 22%、第 5 天才 58%，
      // 这把三阶自动锁到第 3 天以后 —— 不需要写任何天数判定。而大狼（血 160 /
      // 护甲 7 / 攻击 20）拿一阶装备去打风险很高：三阶的门票是"你得敢主动
      // 找大狼打"，这比"再挖十块矿"有意思得多。
      if (wolf.kind === "large" || wolf.kind === "elite") {
        this.ctx.createDrop(wolf, "wolf-fang", 0, wolf.kind === "elite" ? 2 : 1);
      }
    }
    this.ctx.emit({ type: "wolf-killed", wolfId: wolf.id });
  }

  /**
   * 每夜的成长曲线：+3 攻击、+12 生命、+4% 移速，且不封顶。
   * 基准是每夜 +25 攻 +300 血（200 级上限），这里按我们 3~5 夜的体量缩放。
   */
  /**
   * 每夜的成长曲线：+3 攻击、+12 生命、+4% 移速。
   *
   * `maxNights` 是**封顶**。小狼与大狼封在第 3 夜（PACK_SCALING_MAX_DAY），
   * 因为不封顶的话第 10 夜的小狼咬伤 36，已经超过第 1 夜的大狼（20）——
   * 玩家攒到三阶装备之后反而越打越吃力，努力方向是反的。
   *
   * 封顶之后夜晚仍然会变难，只是换了个来源：配额还在涨（30 → 90，第 5 夜封顶）、
   * 大狼占比还在涨（22% → 58%）、精英狼从难度决定的那一夜开始出现且**不封顶**。
   * 也就是"来得更多、成分更凶"，而不是"每一只都变成海绵"。
   */
  getNightScaling(maxNights = Number.POSITIVE_INFINITY): { attack: number; health: number; speed: number } {
    const nights = Math.min(Math.max(0, this.ctx.day - 1), maxNights);
    return { attack: nights * 3, health: nights * 12, speed: 1 + nights * 0.04 };
  }

  private getNightWolfTarget(): number {
    return EARLY_NIGHT_WOLF_TARGETS[this.ctx.day - 1] ?? Math.min(90, 40 + (this.ctx.day - 1) * 15);
  }

  spawnWolf(options: { role?: WolfRole; forceKind?: WolfKind; origin?: Vec2 } = {}): void {
    const role = options.role ?? "raider";
    const half = this.ctx.world.size / 2 - 2;
    const tutorialWolf = role === "raider" && !options.forceKind && this.ctx.day === 1 && this.spawnedThisNight === 0;
    const side = Math.floor(this.ctx.random() * 4);
    const along = (this.ctx.random() - 0.5) * (this.ctx.world.size - 12);
    const edgeSpawn = side === 0 ? { x: -half, z: along }
      : side === 1 ? { x: half, z: along }
      : side === 2 ? { x: along, z: -half }
      : { x: along, z: half };
    const den = this.ctx.world.dens[0] ?? null;
    // 夜袭犬从**狗巢**涌出，不再从地图边缘随机刷。
    //
    // 旧写法有两处代价：一是玩家学不到东西 —— 狼从四条边随机冒出来，它不是
    // 从某处来的，它就是天气；二是大半个夜晚它们都在路上，实测第 1 夜配额
    // 40 只里只有 9 只（23%）真正走到营地 20 米内，配额和实际压力对不上账。
    //
    // 白天的野狼仍然满地图散布 —— 兽皮和狼牙要靠出门找，那条循环不受影响。
    const camp = tutorialWolf
      ? this.ctx.world.camps[this.ctx.world.startCampId]
      : this.ctx.world.camps[Math.floor(this.ctx.random() * this.ctx.world.camps.length)];
    const spawnCandidate = options.origin ?? (tutorialWolf ? {
      x: camp.x + Math.cos(camp.entranceAngle) * (camp.radius + 18),
      z: camp.z + Math.sin(camp.entranceAngle) * (camp.radius + 18),
    } : role === "raider" && den ? {
      // 在巢口外一小圈里散开，免得整夜都从同一个像素点冒出来。
      x: den.mouth.x + Math.cos(this.ctx.random() * TAU) * 2.2,
      z: den.mouth.z + Math.sin(this.ctx.random() * TAU) * 2.2,
    } : edgeSpawn);
    const spawn = this.ctx.findNearestWalkablePoint(spawnCandidate);

    const largeChance = Math.min(0.58, 0.22 + (this.ctx.day - 1) * 0.09);
    const eliteMinDay = this.ctx.tuning.eliteMinDay;
    const eliteChance = this.ctx.day < eliteMinDay ? 0 : Math.min(0.16, 0.04 + (this.ctx.day - eliteMinDay) * 0.03);
    const kindRoll = this.ctx.random();
    const kind: WolfKind = options.forceKind
      ?? (tutorialWolf ? "small" : kindRoll < eliteChance ? "elite" : kindRoll < eliteChance + largeChance ? "large" : "small");
    const scaling = this.getNightScaling();
    // 小狼与大狼吃封顶后的曲线；精英狼吃完整曲线，它才是后期压力的来源。
    const packScaling = this.getNightScaling(PACK_SCALING_MAX_DAY - 1);

    let maxHealth: number;
    let attack: number;
    let defense: number;
    let speed: number;
    if (kind === "elite") {
      // 精英狼是可重复出现的高阶狼种，不是唯一 BOSS；体型和数值明显高一档，但仍走普通狼 AI。
      maxHealth = 280 + scaling.health * 2;
      attack = 26 + scaling.attack;
      defense = 9;
      speed = (4.6 + this.ctx.random() * 0.4) * scaling.speed;
    } else if (tutorialWolf) {
      maxHealth = 28;
      attack = 5;
      defense = 0;
      speed = 3.05;
    } else if (kind === "large") {
      // 大狼是装备门槛，不该再被初始匕首几刀带走；生命、咬伤、护甲和追击速度一起抬高。
      maxHealth = 160 + packScaling.health;
      attack = 20 + packScaling.attack;
      defense = 7;
      speed = (4.2 + this.ctx.random() * 0.65) * packScaling.speed;
    } else {
      // 小狗 58 → 72 血：初始匕首（攻 30 − 防 1 = 29）从**两刀**变成三刀。
      // 每只多挨一刀，交火时间拉长 50%，被咬的次数才真正上去 ——
      // 这比加数量更省算力，也不会把第一夜变成一堵狗墙。
      maxHealth = 72 + packScaling.health;
      // 咬伤 10 → 9。夜里同时贴上来的多半是小狗，第 1 夜三只咬满一轮
      // 从 30 降到 27；每夜 +3 的成长曲线没动，所以后期差距会被抹平 ——
      // 这一刀只松开场，不松终局。
      attack = 9 + packScaling.attack;
      defense = 1;
      speed = (3.65 + this.ctx.random() * 0.75) * packScaling.speed;
    }
    // 野狼白天只在自己的地盘游荡，不参与夜袭的成长曲线，所以稍微弱一点。
    if (role === "wild") {
      maxHealth = Math.round(maxHealth * 0.85);
      attack = Math.max(6, Math.round(attack * 0.8));
    }
    // 难度倍率最后乘，这样上面那些手调过的基准值仍然是"简单档读什么就是什么"。
    // **教学犬不吃倍率** —— 第一夜第一只狗是写死的剧本（28 血 / 5 咬伤），
    // 它的作用是教玩家"面对它、挥一刀"，在令人发狂档把它变成硬骨头只会教错东西。
    if (!tutorialWolf) {
      maxHealth = Math.round(maxHealth * this.ctx.tuning.wolfHealth);
      attack = Math.round(attack * this.ctx.tuning.wolfAttack);
    }

    /*
     * 前三夜使用固定攻营配额 5 / 9 / 14。每次生成时按“剩余名额 ÷ 剩余生成数”
     * 抽签，相当于不放回抽样：顺序仍然随机，但整夜最终不会超过配额，也不会因为
     * 连续命中概率而突然扑来一大批。第一夜教学犬占第一个攻营名额。
     *
     * 第 4 夜以后继续沿用原来的 35% 攻营概率，保留后期压力。
     */
    const baseRaidTarget = EARLY_NIGHT_RAID_TARGETS[this.ctx.day - 1];
    // 配额是"整夜最多扑过来几只"，倍率乘完要取整；undefined 表示第 4 夜以后，
    // 那时走的是概率式，见下面的 raiderChance。
    const earlyRaidTarget = baseRaidTarget === undefined
      ? undefined
      : Math.round(baseRaidTarget * this.ctx.tuning.raid);
    const remainingSpawns = Math.max(1, this.getNightWolfTarget() - this.spawnedThisNight);
    const remainingRaiders = earlyRaidTarget === undefined
      ? 0
      : Math.max(0, earlyRaidTarget - this.raidersSpawnedThisNight);
    const raiderChance = earlyRaidTarget === undefined
      // 第 4 夜起的概率式也要吃倍率，否则后期三个难度只差狼的数值，攻营强度一模一样。
      ? Math.min(1, Math.min(0.35, 0.2 + (this.ctx.day - 1) * 0.05) * this.ctx.tuning.raid)
      : remainingRaiders / remainingSpawns;
    const raider = role === "raider" && (tutorialWolf || this.ctx.random() < raiderChance);
    if (raider) this.raidersSpawnedThisNight += 1;
    /*
     * 攻营犬的动身时刻。**教学犬（第一夜第一只）不排班**，它就是要立刻来 ——
     * 那只狗的全部作用是让玩家学会"面对它、挥一刀"，让他等三十秒等于没教。
     *
     * 其余的按第几只均分整夜的前 78%：第 i 只（从 0 数）在 (i+0.5)/N 那一档动身。
     * 已经过去的夜晚时间要扣掉 —— 刷怪全挤在前 45 秒，第 5 只出生时夜晚才走了
     * 三十几秒，而它那一档在 70% 处，所以真正的等待发生在这里。
     */
    const raidAt = raider && !tutorialWolf ? this.scheduleRaidRelease() : 0;
    // 排到班的那些先在**巢边**等，等到点由 releaseRaider 现算攻击锚点；
    // 立刻动身的（教学犬、以及班次已经过点的）沿用老路：锚点落在玩家附近。
    const assaultCamp = den ? (this.ctx.getPlayerShelter() ?? this.ctx.player) : camp;
    const waiting = raidAt > 0;

    const anchorAngle = this.ctx.random() * TAU;
    const anchorDistance = 12 + this.ctx.random() * 10;
    // 锚点决定这只狗整夜待在哪。
    //
    // **不是所有夜狗都来攻营** —— 前三夜按固定配额、之后按 35% 概率挂上
    // raider 标记去打营地，其余的在自己的锚点附近巡逻。这个分流机制本来就有，
    // 但原先所有夜狗的锚点都挑一座**随机营地**，于是巡逻的那批也漫无目的地
    // 在五座营地之间晃。
    //
    // 现在分成两处：攻营的锚在被攻营地外围，其余的守在**巢边**。
    // 于是狗巢不只是一根出怪管子，它是一个看得见、有狗在活动、可以主动去打的地方 ——
    // 玩家从营地望过去就知道今晚还剩多少没上来。
    // 守巢犬就地生根：锚点即出生点，也就是那三桶油旁边。
    const anchor = role === "wild" || role === "guard"
      ? this.ctx.findNearestWalkablePoint({ x: spawn.x, z: spawn.z })
      : raider && !waiting
        ? this.ctx.findNearestWalkablePoint({
          x: assaultCamp.x + Math.cos(anchorAngle) * anchorDistance,
          z: assaultCamp.z + Math.sin(anchorAngle) * anchorDistance,
        })
        : this.ctx.findNearestWalkablePoint(den ? {
          x: den.x + Math.cos(anchorAngle) * (den.radius + 3 + this.ctx.random() * 7),
          z: den.z + Math.sin(anchorAngle) * (den.radius + 3 + this.ctx.random() * 7),
        } : {
          x: camp.x + Math.cos(anchorAngle) * anchorDistance,
          z: camp.z + Math.sin(anchorAngle) * anchorDistance,
        });


    this.wolves.push({
      id: this.wolfId++,
      kind,
      role,
      ...spawn,
      facing: direction(spawn, anchor),
      health: maxHealth,
      maxHealth,
      attack,
      defense,
      mode: role === "wild" || role === "guard" ? "patrol" : raider && !waiting ? "raid" : "entering",
      raider,
      tutorial: tutorialWolf,
      provoked: false,
      anchor,
      patrolAngle: this.ctx.random() * TAU,
      speed,
      attackCooldown: this.ctx.random(),
      lostTimer: 0,
      lodAccum: 0,
      raidAt,
      retreatAt: 0,
      retreatStuckTimer: 0,
      hurtFlash: 0,
      deathTimer: 0,
      dropsCreated: false,
    });
    if (tutorialWolf) this.ctx.emit({ type: "message", key: "msg.41" });
  }

  /**
   * 白天在远离玩家的地方补充游荡野狼。
   * 它们不主动攻击，被打才反击 —— 是狼皮（进而是防具线）的唯一来源。
   */
  /**
   * 开场斥候：出生点外 27 米放一只白天野狗，开局第一帧就在。
   *
   * 不是加难度 —— wild 角色只有被打才还手。是为了**第一秒画面里有活的东西**。
   * 实测开局 40 米内野狗 0 只（updateWildWolves 明确拒绝在玩家 34 米内刷，
   * 而且每 9 秒才补一只、位置全图随机），第一只要到第 29 秒才晃进视野；
   * 而 Poki 那批会话时长中位数只有 52 秒 —— 超过一半的人开局看到的是一片不动的沙子。
   *
   * 它同时是兽皮的唯一来源，所以这只狗顺带把"打猎"这条循环也指出来了。
   * 挑方位时要求视线不被挡：藏在土垄后面的斥候等于没放。
   */
  seedOpeningScout(): void {
    const player = this.ctx.player;
    for (let index = 0; index < 16; index += 1) {
      // 从正右方起转一圈，取第一个站得住又看得见的点。
      const angle = (index / 16) * TAU;
      const point = this.ctx.findNearestWalkablePoint({
        x: player.x + Math.cos(angle) * 27,
        z: player.z + Math.sin(angle) * 27,
      });
      if (!isTerrainWalkable(this.ctx.world, point)) continue;
      if (this.ctx.lineOfSightBlocked(player, point)) continue;
      this.spawnWolf({ role: "wild", origin: point });
      return;
    }
  }

  private updateWildWolves(delta: number): void {
    if (this.ctx.phase !== "day") return;
    this.wildRespawnCountdown -= delta;
    if (this.wildRespawnCountdown > 0) return;
    this.wildRespawnCountdown = 9;
    const wildCount = this.wolves.filter((wolf) => wolf.role === "wild" && wolf.mode !== "dead").length;
    if (wildCount >= 5) return;
    for (let guard = 0; guard < 20; guard += 1) {
      const point = {
        x: (this.ctx.random() - 0.5) * (this.ctx.world.size - 24),
        z: (this.ctx.random() - 0.5) * (this.ctx.world.size - 24),
      };
      if (distanceSquared(point, this.ctx.player) < 34 * 34) continue;
      if (!isTerrainWalkable(this.ctx.world, point)) continue;
      this.spawnWolf({ role: "wild", origin: point });
      return;
    }
  }

  private wolfCanSeePlayer(wolf: WolfState): boolean {
    // 守巢犬**没有视野盲区**：它们在看着三桶油，绕到背后不该算偷袭成功。
    // 半径收到 14 米作为交换 —— 比别的狼看得近，但看得全。
    // 视线遮挡照旧生效，所以隔着土垄靠近仍然是有效的接近方式。
    if (wolf.role === "guard") {
      if (distanceSquared(wolf, this.ctx.player) > GUARD_AGGRO_RADIUS * GUARD_AGGRO_RADIUS) return false;
      return !this.ctx.lineOfSightBlocked(wolf, this.ctx.player);
    }
    const maxDistance = wolf.raider ? 17.5 : 14.5;
    if (distanceSquared(wolf, this.ctx.player) > maxDistance * maxDistance) return false;
    const towardPlayer = direction(wolf, this.ctx.player);
    if (dot(wolf.facing, towardPlayer) < 0.08 && distanceSquared(wolf, this.ctx.player) > 5 * 5) return false;
    return !this.ctx.lineOfSightBlocked(wolf, this.ctx.player);
  }

  /**
   * 夜袭犬奔向哪里。
   *
   * 围的是**玩家**，不是地图上任何一座亮着火的营地。原先这里找的是离**狼**最近
   * 的亮火营地 —— 玩家一旦离开营地在野外过夜，整队狗就会march 到那座空营地
   * 门口打转，而 raider 的视野只有 17.5 米，它们永远发现不了 50 米外的玩家。
   * 屏幕上的表现就是一条从狗巢排到空营地的长队。
   *
   * 现在只有玩家**确实躲在某座亮火营地里**时才改打那座营地的入口 ——
   * 那种情况下"堵门"才是有意义的；其余时候直接扑向玩家本人。
   */
  /**
   * 夜袭犬奔向哪里 —— 答案就是**玩家**，没有别的。
   *
   * 这里曾经有两版更聪明的写法，都错了：
   *   一版找"离狼最近的亮火营地"，于是玩家在野外过夜时整队狗去围一座空营地；
   *   一版沿 approach 折线手搓路点爬坡，但折线的直线段切在烘焙曲线内侧，
   *   狼照样蹭在崖壁上。
   *
   * 真正的路本来就有：NavigationGrid 每 0.65 秒朝玩家重建一次流场，
   * 它认得营地那条回头弯坡道（实测从巢口沿流场 49 步走到平台）。
   * 所以攻营犬只要"朝玩家"并**始终跟着流场走**就够了 ——
   * 围门这件事不需要脚本，地形自己就只留了一条路，狼会自然挤在那条坡上。
   */
  private getRaidTarget(): Vec2 {
    return this.ctx.player;
  }

  /** 挡在狼前进方向上的放置物。 */
  private findBlockingStructure(wolf: WolfState, desired: Vec2): PlacedStructure | null {
    let closest: PlacedStructure | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const structure of this.ctx.structures) {
      if (!structure.active) continue;
      const reach = STRUCTURE_SPECS[structure.kind].radius + 1.5;
      const structureDistance = distance(wolf, structure);
      if (structureDistance > reach) continue;
      if (dot(desired, direction(wolf, structure)) < 0.35) continue;
      if (structureDistance < closestDistance) {
        closest = structure;
        closestDistance = structureDistance;
      }
    }
    return closest;
  }

  private findBlockingItem(wolf: WolfState, desired: Vec2): GroundItem | null {
    let closest: GroundItem | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const item of this.ctx.items) {
      if (!this.ctx.isBlockingGroundItem(item)) continue;
      /*
       * 只啃**玩家布置**的路障。
       *
       * 天然石头也有碰撞（isBlockingGroundItem 认它，这是对的：撞不过去），
       * 但"有碰撞"不等于"该啃"。石头 1500 血 / 10 护甲，第一夜小狗每口
       * round(10 × 1.05) − 10 = **1 点**，冷却 0.95 秒 —— 啃穿要 1425 秒，
       * 而一夜只有 180 秒，等于八夜不吃不喝地啃一块石头。
       *
       * 而下面那两条分支每帧都 return，根本走不到 moveEntity。于是野地里
       * 27 块石头每一块都是捕狗夹：狗路过时只要贴到 2.36 米内、方向大致朝着它，
       * 就再也不走了，站在那儿啃到天亮 —— 玩家看到的就是"狗站着看我不过来"。
       * 实测五座营地合计 1605 狗秒、最长一只连续定住 143.9 秒，全是这么来的。
       *
       * 天然石头改成绕开走（碰撞 + 转向 + findSteppableDirection 已经够了），
       * 这也正是路障玩法本来的意思：**路障是玩家搬过去堵路的那块**，
       * 不是沙漠里本来就躺着的石头。
       */
      if (!item.placed) continue;
      const itemDistance = distance(wolf, item);
      // Acquire the barrier before the 3.2 m generic avoidance radius. Once
      // acquired, updateWolf deliberately approaches it until bite range.
      if (itemDistance > 3.4) continue;
      if (dot(desired, direction(wolf, item)) < 0.35) continue;
      const clusterSize = this.ctx.items.filter((other) => other.active && other.placed && distanceSquared(item, other) < 4.2 * 4.2).length;
      if (item.kind === "wood" && clusterSize < 2) continue;
      if (itemDistance < closestDistance) {
        closest = item;
        closestDistance = itemDistance;
      }
    }
    return closest;
  }
}
