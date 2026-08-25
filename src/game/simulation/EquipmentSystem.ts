import { ARMOR_STATS, ARMOR_TIERS, WEAPON_STATS, WEAPON_TIERS, WOOD_ATTACK_BONUS, WOOD_ATTACK_CAP } from "../balance/equipment";
import type { ArmorStat, EquipTier, WeaponStat } from "../balance/equipment";
import type { InventorySystem } from "./InventorySystem";
import { describeCost, loc } from "./text";
import type { ArmorKind, EquipLine, GameEvent, InventoryItemKind, LocalizedText, PlayerState, WeaponKind } from "./types";

/**
 * 武器与护甲：**当前装着什么、还能造什么、造出来是多少属性**。
 *
 * 双线设计（刀 / 剑 / 铁甲 / 皮甲，各三阶）是这个游戏里规则最密的一块 ——
 * 分叉、换线退款、需不需要火、三阶统一卡狼牙，每一条都有它的理由，
 * 而这些理由原先散在 GameSimulation 三千行的中段。装备是近期改得最勤的玩法之一，
 * 给它一个自己的文件，改动就不再需要在别的系统之间穿行。
 *
 * 数值本身在 balance/equipment.ts，这里只有规则。
 *
 * ## 属性一律**派生**，不累加
 *
 * `getAttackPower()` / `getDefense()` 每次都从当前装备重新算，玩家身上没有
 * `attack` 字段。原先是"穿上就 += 增量"一路累加，那种写法在装备只有一条直线时
 * 勉强成立，一旦允许换装（骨剑 → 铁刀）就会重复计数：卸下的那件没有对应的减法，
 * 攻击力只增不减。派生之后换线、降级、读档都不会算错。
 */
export interface EquipmentOwner {
  readonly player: PlayerState;
  readonly running: boolean;
  emit(event: GameEvent): void;
  /** 造装备是站着就能做的事，只起表、不打断休息。 */
  noteInPlaceAction(): void;
  /** 身边有没有点着的火。判定半径与取暖、烤肉统一走 FIRE_WARMTH_RADIUS。 */
  hasLitFireNearby(): boolean;
  /** 换了武器。上一把剑攒的连击层数不该跟着走 —— 连击状态归战斗那边管。 */
  onWeaponChanged(): void;
}

export class EquipmentSystem {
  /** 见 {@link unlocked}。只置位、不复位。 */
  private unlockedFlag = false;

  /**
   * 背包**直接传进来**，不走端口。
   *
   * 造装备要读材料数、扣造价、退款入包 —— 三样都是背包操作。把它们摊成端口上的
   * 三个成员，只会让端口宽一圈，而 InventorySystem 本来就是个可以直接持有的对象。
   * 端口只留那些**只有 GameSimulation 答得上来**的问题。
   */
  constructor(
    private readonly owner: EquipmentOwner,
    private readonly inventory: InventorySystem,
  ) {}

  /**
   * 装备制作是否已解锁 —— 拿到过第一张兽皮或第一块铁矿之后为真。
   *
   * 四条一阶全都要兽皮或铁矿（sword 1皮+2木 / saber 3铁+1皮 / hide 4皮 / scale 2铁+2皮），
   * 而这两样开局都是 0、只能白天打猎或挖矿拿到。所以在此之前那两张分叉卡
   * **在逻辑上必然全部不可造** —— 不是"看着有点乱"，是可证明的死 UI。
   * 而它们顶着的是「选一条线，然后跟着它过四天」，全局最重的一句话，
   * 却出现在玩家还没挥过任何一把武器、背包 1/8 的时候。
   *
   * 第一分钟该做的事根本不在背包里（把枯木搬到火边按互动键），
   * 所以这里只是把装备树收起来，**不动搭树桩和烤肉** —— 尤其不能把搭树桩往前推：
   * 第一根枯木进树桩而不进火堆，当晚就没燃料了。
   *
   * 只置位不复位：造完装备材料花光了，树也不该再消失。
   */
  get unlocked(): boolean {
    return this.unlockedFlag;
  }

  /** 背包的入包钩子转到这里。挂在那一处的理由见 InventorySystem.InventoryOwner。 */
  noteAcquired(kind: InventoryItemKind): void {
    if (kind === "hide" || kind === "iron-ore") this.unlockedFlag = true;
  }

  private tiersFor(slot: "weapon" | "armor"): EquipTier[] {
    return slot === "weapon" ? WEAPON_TIERS : ARMOR_TIERS;
  }

  /** 当前装着的那一件。 */
  equipped(slot: "weapon" | "armor"): EquipTier {
    const tiers = this.tiersFor(slot);
    const current = slot === "weapon" ? this.owner.player.weapon : this.owner.player.armor;
    return tiers.find((tier) => tier.id === current) ?? tiers[0];
  }

  /**
   * 某个槽位现在能造哪些东西。**这是升级 UI 的唯一接口** —— 三种界面状态都能
   * 从返回值的长度推出来：
   *
   *   长度 2  阶 0，两条线的一阶同时可造 → 渲染分叉卡
   *   长度 1  已分叉未满级，只能升同线的下一阶 → 渲染升级卡
   *   长度 0  已满级 → 渲染属性总览
   *
   * **返回值不表达"还没解锁"** —— 那是 {@link unlocked} 的事。
   * 长度 0 已经被"已满级"占了，用空数组兼表未解锁会让开局显示满级卡。
   *
   * 换线不在这里 —— 它走 {@link craft} 直接指定另一条线的一阶。
   * **一阶换线全额退材料，二阶起才不返还**（见 craft 里那段）。
   * 之所以是软锁而不是硬锁：单局最长 5 天，硬锁会让第一次玩的玩家在信息不足时
   * 做出不可逆的错误选择。真正的硬约束在材料池里 —— 双铁线要吃掉全图一半到
   * 四分之三的铁矿，你根本没有余量在同一局里再爬一遍另一条铁线。
   */
  upgradeOptions(slot: "weapon" | "armor"): EquipTier[] {
    const tiers = this.tiersFor(slot);
    const current = this.equipped(slot);
    if (current.line === "none") return tiers.filter((tier) => tier.tier === 1);
    return tiers.filter((tier) => tier.line === current.line && tier.tier === current.tier + 1);
  }

  /** 某条线的三阶终点。分叉卡用它告诉玩家"这条路通向哪"。 */
  lineFinale(slot: "weapon" | "armor", line: EquipLine): EquipTier | null {
    return this.tiersFor(slot).find((tier) => tier.line === line && tier.tier === 3) ?? null;
  }

  /** 另一条线的一阶。已经在某条线上时用于渲染"改走另一条线"的入口。 */
  switchOptions(slot: "weapon" | "armor"): EquipTier[] {
    const tiers = this.tiersFor(slot);
    const current = this.equipped(slot);
    if (current.line === "none") return [];
    return tiers.filter((tier) => tier.tier === 1 && tier.line !== current.line);
  }

  /** 这个槽位只剩一个可造项时直接造它。两个（阶 0 的分叉）或零个都不做事。 */
  craftOnly(slot: "weapon" | "armor"): boolean {
    const options = this.upgradeOptions(slot);
    if (options.length !== 1) return false;
    return this.craft(slot, options[0].id);
  }

  /** 按 id 制作某件装备。UI 从 {@link upgradeOptions} / {@link switchOptions} 里取 id。 */
  craft(slot: "weapon" | "armor", id: string): boolean {
    const next = this.tiersFor(slot).find((tier) => tier.id === id);
    if (!next) return false;
    const allowed = [...this.upgradeOptions(slot), ...this.switchOptions(slot)];
    if (!allowed.some((tier) => tier.id === id)) {
      this.owner.emit({ type: "message", key: "msg.15", params: { v0: loc(`equip.${next.id}.name`) } });
      return false;
    }
    /*
     * 一阶换线全额退材料，二阶起才真正锁定。
     *
     * 四条线的手感差得很远（剑单体连击 / 刀 220~280° 横扫 / 皮甲闪避加回复 /
     * 铁甲高防反伤减速），可玩家要在**挥过任何一把之前**，凭 line.*.personality
     * 那两行字做一个跟四天的不可逆选择。选错的人不会回头攒材料重来，他会关标签页。
     *
     * 退了材料之后，"跟着一条线走四天"的设定一点没松 —— 只是把承诺点从"选之前"
     * 挪到"用过之后"。真正的硬约束一直在材料池里（双铁线要吃掉全图一半以上的铁矿），
     * 那条没动。
     */
    const current = this.equipped(slot);
    const isTier1Sidegrade = current.tier === 1 && next.tier === 1 && next.line !== current.line;
    return this.buy(next, (tier) => {
      if (slot === "weapon") {
        this.owner.player.weapon = tier.id as WeaponKind;
        this.owner.onWeaponChanged();
        this.owner.emit({ type: "craft-weapon" });
      } else {
        this.owner.player.armor = tier.id as ArmorKind;
        this.owner.emit({ type: "craft-coat" });
      }
    }, isTier1Sidegrade ? current.cost : []);
  }

  /**
   * @param refund 退还的材料（一阶换线时是被替换掉那件的造价，见 {@link craft}）。
   *
   * 退款和造价先**轧差**再验价，而不是"先退再收" —— 否则想试第二条线就得攒两份材料，
   * "一阶随便换"就名存实亡了。轧完差先扣正项、后补负项：扣掉的那部分先腾出格子，
   * 补回来的东西才装得下。
   */
  private buy(next: EquipTier, apply: (tier: EquipTier) => void, refund: EquipTier["cost"] = []): boolean {
    if (!this.owner.running) return false;
    if (next.needsFire && !this.owner.hasLitFireNearby()) {
      this.owner.emit({ type: "message", key: "msg.16", params: { v0: loc(`equip.${next.id}.name`) } });
      return false;
    }
    const net = new Map<InventoryItemKind, number>();
    for (const [kind, count] of next.cost) net.set(kind, (net.get(kind) ?? 0) + count);
    for (const [kind, count] of refund) net.set(kind, (net.get(kind) ?? 0) - count);

    const missing = [...net].filter(([kind, count]) => count > 0 && this.inventory.count(kind) < count);
    if (missing.length > 0) {
      const need = describeCost(next.cost);
      this.owner.emit({ type: "message", key: "msg.17", params: { v0: loc(`equip.${next.id}.name`), v1: need } });
      return false;
    }
    this.owner.noteInPlaceAction();
    for (const [kind, count] of net) if (count > 0) this.inventory.remove(kind, count);
    for (const [kind, count] of net) {
      // 背包塞不下退款时不静默吞掉 —— 和捡东西满包一样给一句提示。
      if (count < 0 && !this.inventory.add(kind, -count)) this.owner.emit({ type: "message", key: "msg.3" });
    }
    apply(next);
    this.owner.emit({ type: "message", key: "msg.18", params: { v0: loc(`equip.${next.id}.name`), v1: loc(`equip.${next.id}.blurb`) } });
    return true;
  }

  /** 「下一件能造的是什么」的一句话，给目标行和材料到手时的提示用。 */
  describeNextUpgrade(slot: "weapon" | "armor"): LocalizedText {
    const options = this.upgradeOptions(slot);
    const noun = loc(slot === "weapon" ? "slot.weapon" : "slot.armor");
    if (options.length === 0) return loc("sim.1", { v0: noun, v1: loc(`equip.${this.equipped(slot).id}.name`) });
    if (options.length === 1) return loc("sim.2", { v0: loc(`equip.${options[0].id}.name`), v1: loc(`equip.${options[0].id}.blurb`) });
    return loc("sim.3", { v0: noun, v1: loc(options.length === 2 ? "sim.lineChoice" : "sim.lineChoiceOne", { a: loc(`equip.${options[0].id}.name`), b: loc(`equip.${options[options.length - 1].id}.name`) }) });
  }

  /** 当前武器的战斗参数（攻程、扇形、劳力、破甲、暴击、连击上限、移速）。 */
  weaponStats(): WeaponStat {
    return WEAPON_STATS[this.owner.player.weapon];
  }

  /** 当前护甲的战斗参数（闪避、反伤、移速、劳力回复倍率）。 */
  armorStats(): ArmorStat {
    return ARMOR_STATS[this.owner.player.armor];
  }

  /** 武器攻击力 + 随身枯木的边际加成（每根 +2，最多两根）。 */
  attackPower(): number {
    const logs = Math.min(this.inventory.count("wood"), WOOD_ATTACK_CAP);
    return (this.equipped("weapon").attack ?? 0) + logs * WOOD_ATTACK_BONUS;
  }

  /** 护甲防御力。 */
  defense(): number {
    return this.equipped("armor").defense ?? 0;
  }
}
