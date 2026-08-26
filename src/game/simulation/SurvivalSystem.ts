import { clamp } from "./geometry";
import {
  COOL_ACTION_COOLDOWN,
  COOL_ACTION_WARMTH,
  HEALTH_DECAY,
  HEALTH_PASSIVE_NEED,
  HEALTH_PASSIVE_REGEN,
  HUNGER_DECAY,
  REST_IDLE_SECONDS,
  STAMINA_ACTIVE_REGEN,
  STAMINA_IDLE_REGEN,
  STAMINA_REST_REGEN,
  THERMAL_COMFORT_HIGH,
  THERMAL_COMFORT_LOW,
  WARM_ACTION_COOLDOWN,
  WARM_ACTION_WARMTH,
  WARMTH_COLD_ENTER,
  WARMTH_COLD_EXIT,
  WARMTH_DAY_BASE,
  WARMTH_DAY_FLOOR,
  WARMTH_FIRE_GAIN,
  WARMTH_HEAT_ENTER,
  WARMTH_HEAT_EXIT,
  WARMTH_MAX,
  WARMTH_MIN,
  WARMTH_NIGHT_CEILING,
  WARMTH_NIGHT_LOSS,
  WATER_DECAY,
} from "../balance/survival";
import type { EquipmentSystem } from "./EquipmentSystem";
import type { SimContext } from "./SimContext";
import { loc } from "./text";
import type { LocalizedText, SurvivalCondition } from "./types";

/**
 * 五轴生存模型：**体温、生命、水分、饥饿、劳力**，外加休息与就地冷暖。
 *
 * 这是整个游戏的心跳。数值在 balance/survival.ts，这里是规则：什么时候掉、
 * 掉多快、哪一条归零会死、中暑和失温怎么进怎么出、什么情况下才允许休息。
 *
 * ## 端口比 CollisionKernel 宽得多，这是没办法的事
 *
 * 碰撞内核只要三个成员，因为它连玩家是谁都不需要知道。五轴不一样 ——
 * 它要看昼夜（体温的地板和天花板反着来）、要看有没有火、要看刚才有没有挨打
 * （挨打后不许休息）、要看护甲（皮甲加劳力回复）。这些牵连是**玩法本身**的，
 * 不是没抽干净：把它们切断只能靠把参数一个个传进来，那不会让代码更好读。
 *
 * ## 一个不能动的顺序
 *
 * {@link tick} 里那一段调用顺序是有意的：代谢 → 劳力 → 连击窗口 → 体温 → 状态判定。
 * 连击窗口夹在中间看着突兀，但它原本就在这个位置（见 {@link SurvivalOwner.tickCombo}）。
 */
export interface SurvivalOwner extends SimContext {
  /** 搬油三选一的运行时效果。真相在 FuelPerkSystem，这里只是取值口。 */
  perkDecayScale(): number;
  perkBonusStaminaRegen(): number;
  /**
   * 本次交互开始前的静止时长。
   *
   * 劳力不够导致这次交互**什么也没发生**时，用它把 idleTime 还原回去 ——
   * 详见 {@link SurvivalSystem.spendStamina}。
   */
  readonly idleTimeBeforeAction: number;
  /**
   * 让连击窗口走一拍。
   *
   * 连击是战斗状态，本不该由生存系统来推，但它原先就写在代谢和体温之间的那一行，
   * 挪位置就等于改了同一帧内的先后关系。所以留一个钩子，**在原来的位置**调它。
   */
  tickCombo(delta: number): void;
  /**
   * 这一帧的掉血记成"自然耗尽"。
   *
   * tick 跑在狼 AI 之前。若同一帧随后被狼咬，damagePlayer 会把来源覆盖成 killed；
   * 没被咬则保留 exhausted，正好对应真正补掉最后一点体力的来源。
   */
  noteMetabolicDamage(): void;
}

export class SurvivalSystem {
  /** 就地降温的冷却。公开给 HUD 显示还要等多久。 */
  coolCooldown = 0;
  /** 就地取暖的冷却。 */
  warmCooldown = 0;

  /** 护甲影响劳力回复，所以装备直接传进来，不摊进端口 —— 理由同 EquipmentSystem。 */
  constructor(
    private readonly owner: SurvivalOwner,
    private readonly equipment: EquipmentSystem,
  ) {}

  /** 两个冷却各走一拍。 */
  tickCooldowns(delta: number): void {
    this.coolCooldown = Math.max(0, this.coolCooldown - delta);
    this.warmCooldown = Math.max(0, this.warmCooldown - delta);
  }

  tick(delta: number): void {
    const player = this.owner.player;

    // --- 代谢：水分与饥饿独立衰减，任一归零立即死亡 ---
    // 省着点吃（rationing）乘在这里：两条轴同一个倍率，别只减一条。
    const decay = this.owner.perkDecayScale();
    player.water = clamp(player.water - delta * WATER_DECAY * decay, 0, 100);
    player.hunger = clamp(player.hunger - delta * HUNGER_DECAY * decay, 0, 100);

    // --- 体力恒定流失：把"吃饭"从可拖延的提示变成硬心跳（基准 -0.7/600HP）---
    player.health -= delta * HEALTH_DECAY;
    this.owner.noteMetabolicDamage();
    /*
     * 吃饱喝足时把流失抵掉（净 +0.06/s，回不了血）—— 见 HEALTH_PASSIVE_REGEN。
     *
     * `health > 0` 这道闸是后加的，它挡的是一条很窄但真实存在的缝：
     * 这段回复跑在 update 末尾的死亡判定**之前**，所以血正好落在 0 的那一帧
     * 会被抬到 +0.018，`health <= 0` 于是不成立，玩家顶着 0 血继续玩。
     *
     * 实战里够不着（狼一口 18~20，血只会越过 0 掉到负数），但"回复能把人从
     * 死亡线上拽回来"本身就是错的顺序 —— 一旦以后有小额伤害（毒、灼烧、
     * 每秒掉 1 点那类），这条缝会立刻变成"永远死不了"。
     * 同样的闸也加在下面休息回复那条上。
     */
    if (player.health > 0
      && player.hunger > HEALTH_PASSIVE_NEED && player.water > HEALTH_PASSIVE_NEED) {
      player.health = Math.min(player.health + delta * HEALTH_PASSIVE_REGEN, player.maxHealth);
    }

    // --- 劳力回复：休息最快，静止其次，移动最慢 ---
    // 护甲整体缩放这三档：皮甲把防御换成产出（×1.35 时一个白天多回 99 点劳力
    // ≈ 6.6 次挖矿）；铁甲保持基础回复速度，不再额外扣减。
    const staminaRegen = (player.resting
      ? STAMINA_REST_REGEN
      : player.idleTime > 0.4
        ? STAMINA_IDLE_REGEN
        : STAMINA_ACTIVE_REGEN) * this.equipment.armorStats().staminaScale
      // 调匀呼吸是**平坦加值**，加在护甲倍率之后 —— 卡面写着 +2/秒，
      // 就必须对皮甲和铁甲玩家都正好是 +2/秒。
      + this.owner.perkBonusStaminaRegen();
    player.stamina = clamp(player.stamina + delta * staminaRegen, 0, player.maxStamina);

    // --- 连击窗口：手停下来层数就掉 ---
    this.owner.tickCombo(delta);

    // === 体温 ===
    // 两个独立分量相加：昼/夜基线，加上贴着篝火时的火焰增益。
    //
    //   白天无火 = +0.69/s      白天贴火 = +3.85/s
    //   夜晚无火 = −1.05/s      夜晚贴火 = +2.11/s
    //
    // **没有"劳作产热"这一项** —— 它曾经存在（+0.9/s），但那是白天基线的 2.7 倍，
    // 直接导致"正常采集必然中暑且无法自救"，已在 WARMTH_FIRE_GAIN 上方那条注释里
    // 说明为何移除。所以移动、采集、休息都**完全不影响体温**，玩家能动的只有
    // 三件事：喝水降温、贴火升温、以及就地调节（requestThermalAction）。
    //
    // 白天一定会热：地板 15 按 +0.69/s 爬到中暑线 100 要 123 秒，而白天有 180 秒。
    // 所以"白天必须喝水"不是建议，是硬性节奏。
    const nearFire = this.owner.hasLitFireNearby();
    let warmthDelta = 0;
    if (nearFire) warmthDelta += WARMTH_FIRE_GAIN;
    if (this.owner.phase === "day") warmthDelta += WARMTH_DAY_BASE;
    else warmthDelta -= WARMTH_NIGHT_LOSS;
    let warmth = player.warmth + delta * warmthDelta;

    // 昼夜反向夹逼：白天有地板、夜晚有天花板。
    // 结果是中暑只可能发生在白天、失温只可能发生在夜晚，两者的反制手段完全不同
    // （白天靠喝水降温，夜晚靠篝火回温）。这是本作节奏的骨架。
    if (this.owner.phase === "day") warmth = Math.max(warmth, WARMTH_DAY_FLOOR);
    else warmth = Math.min(warmth, WARMTH_NIGHT_CEILING);
    player.warmth = clamp(warmth, WARMTH_MIN, WARMTH_MAX);

    this.updateCondition();
  }

  /** 就地调节体温：太热降温、太冷升温，各自 120 秒冷却。这是自救阀门，不是常规手段。 */
  requestThermalAction(): void {
    if (!this.owner.running) return;
    const player = this.owner.player;
    const warmth = player.warmth;
    if (warmth > THERMAL_COMFORT_HIGH) {
      if (this.coolCooldown > 0) {
        this.owner.emit({ type: "message", key: "msg.31", params: { v0: Math.ceil(this.coolCooldown) } });
        return;
      }
      this.owner.noteActivity();
      this.coolCooldown = COOL_ACTION_COOLDOWN;
      player.warmth = clamp(warmth - COOL_ACTION_WARMTH, WARMTH_MIN, WARMTH_MAX);
      this.updateCondition();
      this.owner.emit({ type: "thermal", direction: "cool" });
      this.owner.emit({ type: "message", key: "msg.32", params: { v0: COOL_ACTION_WARMTH } });
      return;
    }
    if (warmth < THERMAL_COMFORT_LOW) {
      if (this.warmCooldown > 0) {
        this.owner.emit({ type: "message", key: "msg.33", params: { v0: Math.ceil(this.warmCooldown) } });
        return;
      }
      this.owner.noteActivity();
      this.warmCooldown = WARM_ACTION_COOLDOWN;
      player.warmth = clamp(warmth + WARM_ACTION_WARMTH, WARMTH_MIN, WARMTH_MAX);
      this.updateCondition();
      this.owner.emit({ type: "thermal", direction: "warm" });
      this.owner.emit({ type: "message", key: "msg.34", params: { v0: WARM_ACTION_WARMTH } });
      return;
    }
    this.owner.emit({ type: "message", key: "msg.35" });
  }

  /**
   * 中暑 / 失温的进出判定。**进和出用的是不同的阈值**（100 进 / 92 出，5 进 / 14 出）——
   * 单阈值会让玩家在临界点上反复进出状态，一秒钟弹三条提示。
   */
  updateCondition(): void {
    const player = this.owner.player;
    const warmth = player.warmth;
    let next: SurvivalCondition = player.condition;
    if (next === "heatstroke") {
      if (warmth <= WARMTH_HEAT_EXIT) next = "normal";
    } else if (next === "hypothermia") {
      if (warmth >= WARMTH_COLD_EXIT) next = "normal";
    } else if (warmth >= WARMTH_HEAT_ENTER) {
      next = "heatstroke";
    } else if (warmth <= WARMTH_COLD_ENTER) {
      next = "hypothermia";
    }
    if (next === player.condition) return;
    player.condition = next;
    this.owner.emit({ type: "condition", condition: next });
    if (next === "heatstroke") this.owner.emit({ type: "message", key: "msg.36" });
    else if (next === "hypothermia") this.owner.emit({ type: "message", key: "msg.37" });
    else this.owner.emit({ type: "message", key: "msg.38" });
  }

  /** 中暑近乎瘫痪、失温更甚。体温不致死，但这两个倍率会让你走不动、也打不快。 */
  conditionSpeedScale(): number {
    if (this.owner.player.condition === "heatstroke") return 0.4;
    if (this.owner.player.condition === "hypothermia") return 0.25;
    return 1;
  }

  conditionCooldownScale(): number {
    if (this.owner.player.condition === "heatstroke") return 2;
    if (this.owner.player.condition === "hypothermia") return 2.85;
    return 1;
  }

  /** 现在为什么不能休息；能休息返回 null。HUD 直接把这句话显示出来。 */
  restBlocker(): LocalizedText | null {
    const player = this.owner.player;
    if (player.condition === "heatstroke") return loc("sim.37");
    if (player.condition === "hypothermia") return loc("sim.38");
    if (player.hunger < 20) return loc("sim.39");
    if (player.water < 20) return loc("sim.40");
    if (this.owner.phase === "night" && player.warmth <= 30) return loc("sim.41");
    // 只有"刚挨过打"才禁止休息，而不是"附近有狼"。
    // 按距离判定会让夜里任何时候都休息不了 —— 夜间地图上本来就有几十只狼，
    // 20 米的追击半径几乎覆盖全图，玩家只会看到一句解释不了的"附近有狼"。
    if (this.owner.combatTimer > 0) return loc("sim.42", { v0: Math.ceil(this.owner.combatTimer) });
    if (player.idleTime < REST_IDLE_SECONDS) return loc("sim.43", { v0: Math.ceil(REST_IDLE_SECONDS - player.idleTime) });
    return null;
  }

  updateRest(delta: number): void {
    const player = this.owner.player;
    // 劳力没满时也值得休息 —— 休息是劳力的主要回复途径。
    const wantsRecovery = player.health < player.maxHealth || player.stamina < player.maxStamina;
    const canRest = player.idleTime >= REST_IDLE_SECONDS && wantsRecovery && this.restBlocker() === null;
    this.setResting(canRest);
    // 恒定流失是 HEALTH_DECAY，休息的净回复要减掉它才是玩家实际看到的速度。
    // 净回复 1.5 → 1.9 → 2.6（吃不饱时仍是 1.1）。站定的门槛本来就不低，
    // 回得太慢的话"休息"只是名义上的选择：满血 66 秒 → 53 秒 → 38 秒。
    // 38 秒仍然是一段要主动付出的时间，但在手机上不再长到让人宁可继续跑。
    // 饥渴档没跟着提：吃饱喝足才回得快，这条差距是"先去吃饭"的动力所在。
    const healingRate = (player.hunger < 40 || player.water < 40 ? 1.1 : 2.6) + HEALTH_DECAY;
    // health > 0：跟被动回复同一道闸，血已经归零就不许再被拽回来。见 tick()。
    if (player.resting && player.health > 0) {
      player.health = clamp(player.health + delta * healingRate, 0, player.maxHealth);
    }
  }

  setResting(active: boolean): void {
    if (this.owner.player.resting === active) return;
    this.owner.player.resting = active;
    this.owner.emit({ type: "rest", active });
  }

  /** 花掉劳力；不够则什么也不做并返回 false。 */
  spendStamina(cost: number): boolean {
    const player = this.owner.player;
    if (player.stamina < cost) {
      /*
       * 劳力不够 = **这次点击什么也没发生**，所以"站着不动"的计时不该被它清零。
       *
       * 原先 requestInteraction 一进来就 noteActivity()，于是脱力时狂点捡柴
       * 会把 idleTime 永远压在 0，人就再也进不了休息 —— 而休息正是劳力唯一的
       * 快速回复途径。玩家因此卡在"没劳力→点不动→不能休息→还是没劳力"里。
       * 提水、挖矿、割仙人掌、建造走的是同一个函数，一起修好。
       */
      player.idleTime = this.owner.idleTimeBeforeAction;
      this.owner.emit({ type: "exhausted" });
      this.owner.emit({ type: "message", key: "msg.5" });
      return false;
    }
    player.stamina -= cost;
    return true;
  }
}
