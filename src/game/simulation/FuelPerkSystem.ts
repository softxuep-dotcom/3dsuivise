import {
  ARMOR_PLATE_DEFENSE,
  BARREL_BRACE_DAMAGE_MULT,
  BLOOD_RUSH_COOLDOWN,
  BLOOD_RUSH_HEALTH,
  CARRY_BASE_SCALE,
  CARRY_RIG_PENALTY_MULT,
  DEN_BREAKER_DAMAGE_BONUS,
  EMPTY_RUN_SECONDS,
  EMPTY_RUN_SPEED_BONUS,
  FUEL_PERKS,
  FUEL_PERK_BY_ID,
  OFFER_SIZE,
  RATIONING_DECAY_MULT,
  STEADY_BREATH_REGEN,
  TRUCK_SUPPLIES_HEALTH,
  TRUCK_SUPPLIES_HUNGER,
  TRUCK_SUPPLIES_WATER,
  type FuelPerkId,
  type FuelPerkLine,
} from "../balance/fuelPerks";
import type { SimContext } from "./SimContext";

/**
 * 搬油三选一。规格见 docs/搬油三选一-开发交接.md。
 *
 * ## 它是奖励状态的唯一真相来源
 *
 * HUD 只做两件事：调 {@link pendingOffer} 读这次给哪三张，调 {@link choose}
 * 把选择送回来校验。**渲染层不许自己记层数**，否则暂停、重开、广告这几条路径
 * 各自漏一次同步，就会出现"卡面写着 Ⅱ 而实际效果是 Ⅰ"这种查不出来的错。
 *
 * ## 只活一局
 *
 * 死亡、通关、软重开全部清零（{@link reset}），也不写 localStorage ——
 * 记录板仍然只存最快脱出和最远油量。这是刻意的：一旦奖励能跨局累积，
 * 它就变成局外成长，而这个游戏的全部张力在"这一局能不能把六桶搬完"。
 */
export interface FuelPerkWorld extends SimContext {
  /** 后座补给要直接改这三条轴，走 owner 的结算口而不是自己碰 player。 */
  restoreNeeds(health: number, water: number, hunger: number): void;
  /**
   * 场上还有没有活着的守巢狼。
   *
   * 清巢老手（den-breaker）只在有目标时才发得出去 —— 五只全死之后它是一张
   * 废卡，而"绝不发无效卡"是硬规矩（交接文档 §4）。
   */
  hasLivingGuards(): boolean;
}

export class FuelPerkSystem {
  private readonly stacks = new Map<FuelPerkId, number>();
  private offer: FuelPerkId[] | null = null;
  private previousOffer: FuelPerkId[] | null = null;
  /** 最近一次选的是哪条线。层数打平时用它决定主路线。 */
  private lastLine: FuelPerkLine | null = null;
  /** 熟门熟路的剩余加速秒数。 */
  private speedBurst = 0;
  /** 见血回神的冷却。 */
  private bloodRushCooldown = 0;

  constructor(private readonly ctx: FuelPerkWorld) {}

  /** 软重开、死亡、通关都要调。 */
  reset(): void {
    this.stacks.clear();
    this.offer = null;
    this.previousOffer = null;
    this.lastLine = null;
    this.speedBurst = 0;
    this.bloodRushCooldown = 0;
  }

  stacksOf(id: FuelPerkId): number {
    return this.stacks.get(id) ?? 0;
  }

  /** 这次给哪三张；没有待选时是 null。HUD 每帧读它决定要不要开弹层。 */
  pendingOffer(): readonly FuelPerkId[] | null {
    return this.offer;
  }

  tick(delta: number): void {
    if (this.speedBurst > 0) this.speedBurst = Math.max(0, this.speedBurst - delta);
    if (this.bloodRushCooldown > 0) this.bloodRushCooldown = Math.max(0, this.bloodRushCooldown - delta);
  }

  // ── 触发 ───────────────────────────────────────────────────────────────

  /**
   * 装车完成时由 TruckSystem 调。
   *
   * `loaded` 是**装完之后**的桶数。第 6 桶不弹 —— 那时游戏就要结束了，
   * 给了也来不及用，反而把「装满 → 上车 → 发车」那串收尾拆开。
   */
  noteFuelLoaded(loaded: number, required: number): void {
    // 后座补给每次装车都结算，和弹不弹卡无关。
    this.applyTruckSupplies();
    if (this.speedBurstDuration() > 0) this.speedBurst = this.speedBurstDuration();
    if (loaded >= required) return;
    const drawn = this.draw();
    if (drawn.length === 0) return;
    this.offer = drawn;
    this.ctx.emit({ type: "fuel-perk-offer", loaded });
  }

  /**
   * 玩家选了一张。
   *
   * **必须校验 id 在本次 offer 里** —— HUD 是可以被改的，而层数上限是这个
   * 系统的全部平衡前提。不在 offer 里就拒绝，返回 false 让调用方知道没生效。
   */
  choose(id: FuelPerkId): boolean {
    if (!this.offer || !this.offer.includes(id)) return false;
    const def = FUEL_PERK_BY_ID[id];
    const next = this.stacksOf(id) + 1;
    if (next > def.maxStacks) return false;
    this.stacks.set(id, next);
    this.lastLine = def.line;
    this.previousOffer = this.offer;
    this.offer = null;
    // 选中当下就把这一层的即时效果结算掉，否则第一层会表现成"选了没反应"。
    if (id === "truck-supplies") this.applyTruckSupplies(1);
    if (id === "empty-run") this.speedBurst = this.speedBurstDuration();
    this.ctx.emit({ type: "fuel-perk-chosen", id, stacks: next });
    return true;
  }

  // ── 抽卡 ───────────────────────────────────────────────────────────────

  /**
   * 受控随机。用 ctx.random()（模拟层自己的 mulberry32），**不碰 Math.random** ——
   * 探针和测试要能按 seed 复现整局，UI 里摇一次骰子就毁掉这件事。
   *
   * 规则（见交接文档 §4）：
   *   第一次     三条线各抽一张，然后洗牌（免得玩家形成"左边永远是搬运"的肌肉记忆）
   *   之后       ① 主路线（当前层数最多的那条）抽一张，保证能继续构筑
   *              ② 另外两条里抽一张，保留转型机会
   *              ③ 全池随机
   *
   * 过滤后不足三张时，按「先放宽主路线保证 → 再放宽与上一组不重复」的顺序退让。
   * **绝不突破层数上限，也绝不发无效卡** —— 那两条是硬的。
   */
  private draw(): FuelPerkId[] {
    const pool = FUEL_PERKS.filter((perk) => this.isDrawable(perk.id));
    if (pool.length === 0) return [];

    const first = this.previousOffer === null;
    const picked: FuelPerkId[] = [];
    const takeFrom = (candidates: FuelPerkId[]): void => {
      const left = candidates.filter((id) => !picked.includes(id));
      if (left.length === 0) return;
      picked.push(left[Math.floor(this.ctx.random() * left.length)]);
    };

    if (first) {
      for (const line of ["carry", "combat", "survival"] as const) {
        takeFrom(pool.filter((perk) => perk.line === line).map((perk) => perk.id));
      }
    } else {
      const main = this.mainLine();
      takeFrom(pool.filter((perk) => perk.line === main).map((perk) => perk.id));
      takeFrom(pool.filter((perk) => perk.line !== main).map((perk) => perk.id));
      takeFrom(pool.map((perk) => perk.id));
    }
    // 还不够就全池补，直到没牌可发。
    while (picked.length < OFFER_SIZE && picked.length < pool.length) {
      takeFrom(pool.map((perk) => perk.id));
    }

    /*
     * 和上一组完全相同就重洗一次。
     *
     * 只试一次、失败就接受 —— 池子小的时候（大部分卡满层了）"完全不同"可能
     * 根本做不到，为它无限重试会挂死。防重复是**软约束**，层数上限才是硬的。
     */
    if (this.sameAsPrevious(picked) && pool.length > OFFER_SIZE) {
      const retry = this.drawPlain(pool.map((perk) => perk.id));
      if (!this.sameAsPrevious(retry)) return this.shuffle(retry);
    }
    return this.shuffle(picked);
  }

  private drawPlain(ids: FuelPerkId[]): FuelPerkId[] {
    const left = [...ids];
    const out: FuelPerkId[] = [];
    while (out.length < OFFER_SIZE && left.length > 0) {
      out.push(left.splice(Math.floor(this.ctx.random() * left.length), 1)[0]);
    }
    return out;
  }

  private shuffle(ids: FuelPerkId[]): FuelPerkId[] {
    const out = [...ids];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.ctx.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  private sameAsPrevious(picked: FuelPerkId[]): boolean {
    const prev = this.previousOffer;
    if (!prev || prev.length !== picked.length) return false;
    return picked.every((id) => prev.includes(id));
  }

  /** 层数最多的那条线；打平时用最近一次选择。 */
  private mainLine(): FuelPerkLine {
    const totals = new Map<FuelPerkLine, number>();
    for (const perk of FUEL_PERKS) {
      totals.set(perk.line, (totals.get(perk.line) ?? 0) + this.stacksOf(perk.id));
    }
    let best: FuelPerkLine = this.lastLine ?? "carry";
    let bestCount = totals.get(best) ?? 0;
    for (const [line, count] of totals) {
      if (count > bestCount) { best = line; bestCount = count; }
    }
    return best;
  }

  /**
   * 这张卡还能不能发。
   *
   * `den-breaker`（清巢老手）在五只守巢狼全部死亡后退出候选池 —— 那时它已经
   * 没有目标了，发出去就是一张废卡，而"绝不发无效卡"是硬规矩。
   */
  private isDrawable(id: FuelPerkId): boolean {
    if (this.stacksOf(id) >= FUEL_PERK_BY_ID[id].maxStacks) return false;
    if (id === "den-breaker" && !this.ctx.hasLivingGuards()) return false;
    return true;
  }

  // ── 运行时效果 ─────────────────────────────────────────────────────────

  /** 扛东西时的移速倍率。见 fuelPerks.ts 里 CARRY_RIG_PENALTY_MULT 那段的表。 */
  carryScale(): number {
    const stacks = this.stacksOf("carry-rig");
    return 1 - (1 - CARRY_BASE_SCALE) * CARRY_RIG_PENALTY_MULT ** stacks;
  }

  /** 空手时的移速加成倍率。熟门熟路的窗口内是 1.2，否则 1。 */
  emptyRunScale(): number {
    return this.speedBurst > 0 ? 1 + EMPTY_RUN_SPEED_BONUS : 1;
  }

  private speedBurstDuration(): number {
    const stacks = this.stacksOf("empty-run");
    return stacks === 0 ? 0 : EMPTY_RUN_SECONDS[Math.min(stacks, EMPTY_RUN_SECONDS.length) - 1];
  }

  /** 加在装备防御之外的平坦防御。 */
  bonusDefense(): number {
    return this.stacksOf("armor-plate") * ARMOR_PLATE_DEFENSE;
  }

  /** 扛油时受到的伤害倍率。 */
  carriedDamageScale(): number {
    return BARREL_BRACE_DAMAGE_MULT ** this.stacksOf("barrel-brace");
  }

  /** 对守巢狼的伤害倍率。 */
  denDamageScale(guarding: boolean): number {
    if (!guarding) return 1;
    return 1 + DEN_BREAKER_DAMAGE_BONUS * this.stacksOf("den-breaker");
  }

  /** 平坦劳力回复加值。**加在护甲倍率之后**，一层永远正好 +1/s。 */
  bonusStaminaRegen(): number {
    return this.stacksOf("steady-breath") * STEADY_BREATH_REGEN;
  }

  /** 水分与饥饿的消耗倍率。 */
  decayScale(): number {
    return RATIONING_DECAY_MULT ** this.stacksOf("rationing");
  }

  /** 杀掉一只狼：见血回神。冷却内不重复触发。 */
  noteWolfKilled(): void {
    const stacks = this.stacksOf("blood-rush");
    if (stacks === 0 || this.bloodRushCooldown > 0) return;
    this.bloodRushCooldown = BLOOD_RUSH_COOLDOWN;
    const amount = BLOOD_RUSH_HEALTH[Math.min(stacks, BLOOD_RUSH_HEALTH.length) - 1];
    this.ctx.restoreNeeds(amount, 0, 0);
  }

  private applyTruckSupplies(stacks = this.stacksOf("truck-supplies")): void {
    if (stacks <= 0) return;
    this.ctx.restoreNeeds(
      TRUCK_SUPPLIES_HEALTH * stacks,
      TRUCK_SUPPLIES_WATER * stacks,
      TRUCK_SUPPLIES_HUNGER * stacks,
    );
  }
}
