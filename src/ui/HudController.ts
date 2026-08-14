import type { EquipTier, GameSimulation } from "../game/simulation/GameSimulation";
import { t, tx } from "../i18n";
import { clamp } from "../game/simulation/geometry";
import { describeRecords, formatDuration, loadRecords, submitRun } from "./Records";
import { STRUCTURE_SPECS } from "../game/simulation/types";
import type {
  GameEvent,
  InventoryItemKind,
  StructureKind,
} from "../game/simulation/types";

const required = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};

/**
 * 界面里所有靠"种类"取的文案都走 i18n 键。
 *
 * 装备与物品的名字**不再写死在 UI 层** —— 键跟着种类走（`equip.saber-2.name`、
 * `item.hide.name`），文案落在语言表里。这样加一门语言不用碰这个文件。
 *
 * 装备标签统一用**绝对值**口径（攻击 46 而不是 攻击+18）：原先武器写累计增量、
 * 配方表写单阶增量，同一件装备在两个地方是两个数字。
 */

/**
 * 每条线一个颜色，和 GameRenderer 的 WEAPON_VISUALS 取同一个色相。
 * 背包一开就知道自己走的哪条线，**而且和世界里那把刀是同一个颜色**。
 * 颜色不进语言表 —— 它不是文案。
 */
const LINE_COLORS: Record<string, string> = {
  none: "#8a8072",
  saber: "#6f8ba8",
  sword: "#d9a441",
  scale: "#7d868f",
  hide: "#c08a5a",
};

/** 物品格里的单字图标。字形本身也要翻译：英文用两个字母，中文用一个汉字。 */
const itemGlyph = (kind: InventoryItemKind): string => t(`item.${kind}.glyph`);
const itemName = (kind: InventoryItemKind): string => t(`item.${kind}.name`);

export class HudController {
  private readonly simulation: GameSimulation;
  private readonly hud = required<HTMLElement>("hud");
  private readonly intro = required<HTMLElement>("intro");
  private readonly gameOver = required<HTMLElement>("game-over");
  private readonly victory = required<HTMLElement>("victory");
  private readonly inventoryOverlay = required<HTMLElement>("inventory-overlay");
  private readonly healthBar = required<HTMLElement>("health-bar");
  private readonly warmthBar = required<HTMLElement>("warmth-bar");
  private readonly hungerBar = required<HTMLElement>("hunger-bar");
  private readonly waterBar = required<HTMLElement>("water-bar");
  private readonly staminaBar = required<HTMLElement>("stamina-bar");
  private readonly healthValue = required<HTMLElement>("health-value");
  private readonly warmthValue = required<HTMLElement>("warmth-value");
  private readonly craftCookButton = required<HTMLButtonElement>("craft-cook-button");
  private readonly buildButtons: Array<[HTMLButtonElement, StructureKind]> = [
    [required<HTMLButtonElement>("build-stake-button"), "stake"],
  ];
  private readonly hungerValue = required<HTMLElement>("hunger-value");
  private readonly waterValue = required<HTMLElement>("water-value");
  private readonly staminaValue = required<HTMLElement>("stamina-value");
  private readonly conditionBadge = required<HTMLElement>("condition-badge");
  private readonly drainNote = required<HTMLElement>("drain-note");
  private readonly huntProgress = required<HTMLElement>("hunt-progress");
  /** 随身补给的只读计数；消耗一律回背包里点物品格。 */
  private readonly supplies: Array<[HTMLElement, InventoryItemKind]> = [
    [required<HTMLElement>("supply-water"), "water"],
    [required<HTMLElement>("supply-juice"), "cactus-juice"],
    [required<HTMLElement>("supply-meat"), "cooked-meat"],
  ];
  private readonly bagUsage = required<HTMLElement>("bag-usage");
  private readonly thermalButton = required<HTMLButtonElement>("thermal-button");
  private readonly thermalState = required<HTMLElement>("thermal-state");

  /**
   * 体温调节按钮：一个键管两个方向，所以它必须自己说清楚现在按下去会发生什么，
   * 以及还要等多久 —— 否则玩家分不清"按了没反应"和"在冷却中"。
   */
  private syncThermalButton(warmth: number): void {
    const hot = warmth > 62;
    const cold = warmth < 35;
    const cooldown = hot ? this.simulation.coolCooldown : this.simulation.warmCooldown;
    // 按钮原先是「静态标签 Warmth」+「状态词」两行，读出来是 "Warmth / Warm"。
    // 现在只剩一行，由状态词自己把话说完：两个可按的状态是动词短语（Cool down /
    // Warm up），两个不可按的状态自己带上名词（Warmth OK / Warmth 120s）——
    // 否则冷却态会变成一颗没有标签的 "120s"，而 120 秒冷却恰恰是最常驻的状态。
    if (!hot && !cold) {
      this.thermalState.textContent = t("thermal.fine");
      this.thermalButton.disabled = true;
      return;
    }
    if (cooldown > 0) {
      this.thermalState.textContent = t("thermal.cooldown", { seconds: Math.ceil(cooldown) });
      this.thermalButton.disabled = true;
      return;
    }
    this.thermalState.textContent = t(hot ? "thermal.cool" : "thermal.warm");
    this.thermalButton.disabled = false;
  }
  private readonly objective = required<HTMLElement>("objective");
  private readonly dayLabel = required<HTMLElement>("day-label");
  private readonly phaseLabel = required<HTMLElement>("phase-label");
  private readonly timeLabel = required<HTMLElement>("time-label");
  private readonly clock = required<HTMLElement>("clock");
  private readonly prompt = required<HTMLElement>("prompt");
  private readonly restIndicator = required<HTMLElement>("rest-indicator");
  private readonly gatherIndicator = required<HTMLElement>("gather-indicator");
  private readonly actionButton = required<HTMLButtonElement>("action-button");
  private readonly recordsLine = required<HTMLElement>("records-line");
  private readonly toast = required<HTMLElement>("toast");
  private readonly resultCopy = required<HTMLElement>("result-copy");
  private readonly victoryCopy = required<HTMLElement>("victory-copy");
  private readonly handsStatus = required<HTMLElement>("hands-status");
  private readonly coatStatus = required<HTMLElement>("coat-status");
  private readonly weaponStatus = required<HTMLElement>("weapon-status");
  private readonly statHealth = required<HTMLElement>("stat-health");
  private readonly statStamina = required<HTMLElement>("stat-stamina");
  private readonly statAttack = required<HTMLElement>("stat-attack");
  private readonly statDefense = required<HTMLElement>("stat-defense");
  private readonly comboArc = required<HTMLElement>("combo-arc");
  private readonly armorUpgradeSlot = required<HTMLElement>("armor-upgrade-slot");
  private readonly weaponUpgradeSlot = required<HTMLElement>("weapon-upgrade-slot");
  /** 换线的二次确认：第一下只亮出代价，第二下才执行。 */
  private pendingSwitch: { slot: "weapon" | "armor"; id: string } | null = null;
  /** 升级区上一次渲染的内容签名，用来跳过无意义的重绘。 */
  private readonly upgradeSignatures = new Map<string, string>();
  private readonly slots: HTMLButtonElement[];
  private toastTimer = 0;
  private lastHudUpdate = 0;
  private inventoryOpen = false;

  constructor(simulation: GameSimulation) {
    this.simulation = simulation;
    this.slots = [...document.querySelectorAll<HTMLButtonElement>(".inventory-slot")];
    this.slots.forEach((slot) => {
      slot.addEventListener("click", () => {
        const index = Number(slot.dataset.slot);
        this.simulation.useInventorySlot(index);
        this.updateInventory();
      });
    });
    required<HTMLButtonElement>("backpack-button").addEventListener("click", () => this.toggleInventory());
    required<HTMLButtonElement>("inventory-close").addEventListener("click", () => this.closeInventory());
    // 升级区的按钮是每次 renderUpgradeSlot() 重新生成的，事件在那里现绑，
    // 这里不再有固定的升级按钮。
    for (const [button, kind] of this.buildButtons) {
      button.addEventListener("click", () => {
        // 建造要看着放置结果，所以放完直接关掉背包回到游戏。
        if (this.simulation.build(kind)) this.closeInventory();
        else this.updateInventory();
      });
    }
    this.craftCookButton.addEventListener("click", () => {
      this.simulation.craftCookedMeat();
      this.updateInventory();
    });
  }

  showGame(): void {
    this.intro.classList.add("hidden");
    this.hud.classList.remove("hidden");
  }

  isGameplayBlocked(): boolean {
    return this.inventoryOpen;
  }

  toggleInventory(): void {
    if (!this.simulation.running) return;
    this.inventoryOpen = !this.inventoryOpen;
    this.inventoryOverlay.classList.toggle("hidden", !this.inventoryOpen);
    if (this.inventoryOpen) this.updateInventory();
  }

  closeInventory(): void {
    this.inventoryOpen = false;
    this.inventoryOverlay.classList.add("hidden");
  }

  update(deltaSeconds: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= deltaSeconds;
      if (this.toastTimer <= 0) this.toast.classList.add("hidden");
    }
    this.lastHudUpdate += deltaSeconds;
    if (this.lastHudUpdate < 0.08) return;
    this.lastHudUpdate = 0;

    const player = this.simulation.player;
    this.setMeter(this.healthBar, this.healthValue, player.health);
    this.setMeter(this.waterBar, this.waterValue, player.water);
    this.setMeter(this.hungerBar, this.hungerValue, player.hunger);
    this.setMeter(this.warmthBar, this.warmthValue, player.warmth);
    this.setMeter(this.staminaBar, this.staminaValue, player.stamina, player.maxStamina);
    this.healthBar.closest(".meter")?.classList.toggle("critical", player.health < 30);
    // 水分与饱食是"归零即死"的轴，所以告警阈值比体温更保守。
    this.waterBar.closest(".meter")?.classList.toggle("critical", player.water < 25);
    this.hungerBar.closest(".meter")?.classList.toggle("critical", player.hunger < 25);
    this.warmthBar.closest(".meter")?.classList.toggle("critical", player.condition !== "normal");
    this.staminaBar.closest(".meter")?.classList.toggle("critical", player.stamina < 12);

    // 连击弧：剑线专属，刀线上根本不显示（它的击退在画面上是自明的 —— 狼被推开了）。
    const combo = this.simulation.getComboState();
    this.comboArc.classList.toggle("active", combo.max > 0 && combo.stacks > 0);
    this.comboArc.classList.toggle("full", combo.max > 0 && combo.stacks >= combo.max);
    if (combo.max > 0) this.comboArc.style.setProperty("--combo", String(combo.stacks / combo.max));

    this.updateConditionBadge();
    this.updateDrainNote();
    this.updateHuntProgress();

    for (const [element, kind] of this.supplies) {
      const count = this.simulation.getInventoryCount(kind);
      const value = element.querySelector("b");
      if (value) value.textContent = String(count);
      element.classList.toggle("empty", count === 0);
    }
    this.syncThermalButton(player.warmth);
    this.bagUsage.textContent = `${player.inventory.filter(Boolean).length}/8`;
    this.objective.textContent = tx(this.simulation.getObjective());
    this.dayLabel.textContent = t("hud.dayLine", {
      day: this.simulation.day,
      place: tx(this.simulation.getCurrentLocationLabel()),
      dogs: this.simulation.wolves.filter((wolf) => wolf.mode !== "dead").length,
    });
    this.phaseLabel.textContent = t(this.simulation.phase === "day" ? "phase.day" : "phase.night");
    this.clock.classList.toggle("night", this.simulation.phase === "night");
    const seconds = Math.max(0, Math.ceil(this.simulation.phaseTime));
    this.timeLabel.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    // 取水和休息在模拟层本来就互斥（取水时 getRestBlocker 返回"取水中"），这里再显式
    // 互斥一次：竖屏上中央栏和右上状态栏之间只剩 10px 余量，两个胶囊同时出现就会顶上去。
    // 把这条保证放在布局本地，将来改模拟层也不会悄悄把它弄坏。
    const gathering = player.gatherTimer > 0;
    this.gatherIndicator.classList.toggle("hidden", !gathering);
    this.restIndicator.classList.toggle("hidden", gathering || !player.resting);
    if (gathering) this.gatherIndicator.textContent = t("hud.gathering", { seconds: player.gatherTimer.toFixed(1) });

    const hint = this.simulation.getInteractionHint();
    const touchLayout = matchMedia("(pointer: coarse)").matches || window.innerWidth <= 760;
    this.actionButton.textContent = t(`action.${hint.action}`);
    if (hint.action === "none") {
      this.prompt.classList.add("hidden");
    } else if (touchLayout) {
      // 提示就贴在"行动"键上方，键名由那颗按钮自己说 —— 这里再写一遍纯属重复。
      this.prompt.textContent = tx(hint.text);
      this.prompt.classList.remove("hidden");
    } else {
      this.prompt.innerHTML = `<kbd>E</kbd>${tx(hint.text)}`;
      this.prompt.classList.remove("hidden");
    }
    if (this.inventoryOpen) this.updateInventory();
  }

  private updateConditionBadge(): void {
    const player = this.simulation.player;
    // 中暑/失温优先于脱力显示：前者会让你走不动，后者只是打得轻。
    const condition = player.condition;
    if (condition !== "normal") {
      this.conditionBadge.className = `condition-badge ${condition}`;
      this.conditionBadge.textContent = t(`condition.${condition}`);
      return;
    }
    if (player.stamina < 12) {
      this.conditionBadge.className = "condition-badge exhausted";
      this.conditionBadge.textContent = t("condition.spent");
      return;
    }
    this.conditionBadge.className = "condition-badge hidden";
  }

  /**
   * 体力恒定流失最容易被误读成"被看不见的东西攻击"，所以要有一行说明 ——
   * 但**不必常驻**。满血时它只是噪音，而右上角本来就挤。
   * 只在两种时候出现：站定却回不了血（必须说清是哪条挡住了，否则像 bug），
   * 或者体力已经掉到值得管的程度。
   *
   * "休息中"交给顶部的状态胶囊，这里不再重复；"正在被攻击"也去掉了 ——
   * 受击有屏幕震动和红闪，而那句话还在指一个矮屏上根本不显示的小地图。
   */
  private updateDrainNote(): void {
    const player = this.simulation.player;
    const blocker = player.resting ? null : this.simulation.getRestBlocker();
    const worthSaying = blocker !== null || player.health < 70;
    this.drainNote.classList.toggle("hidden", !worthSaying);
    if (!worthSaying) return;
    this.drainNote.textContent = blocker
      ? t("hud.drain.blocked", { reason: tx(blocker) })
      : t("hud.drain.hint");
  }

  /**
   * 通关进度 = 车里的油。
   *
   * 这块常驻的小字以前写的是"猎杀 12/40"，也就是**目标行说什么它就重复什么**。
   * 现在两者分工：目标行说"此刻该干嘛"（会被口渴、失温、扛着桶一路抢走），
   * 这块只说"离赢还有多远"—— 无论目标行正在喊什么，它都不变。
   */
  private updateHuntProgress(): void {
    const fuel = this.simulation.getFuelProgress();
    this.huntProgress.textContent = t("hunt.fuel", { loaded: fuel.loaded, required: fuel.required });
  }

  handle(event: GameEvent): void {
    if (event.type === "message") this.showToast(t(event.key, event.params), 3.1);
    if (event.type === "phase") {
      this.showToast(t(event.phase === "night" ? "toast.nightfall" : "toast.daybreak", { day: event.day }), 3.4);
    }
    if (event.type === "pickup" && (event.kind === "raw-meat" || event.kind === "hide" || event.kind === "water")) {
      const label = t(`loot.${event.kind}`);
      this.showToast(label, 1.4);
    }
    if (event.type === "critter-killed") {
      const label = this.simulation.getCritterLabel(event.kind);
      this.showToast(t(event.kind === "oryx" ? "toast.huntBig" : "toast.hunt", { name: label }), 1.8);
    }
    if (event.type === "fuel-loaded") {
      this.showToast(t("toast.fuelLoaded", { loaded: event.loaded, required: event.required }), 2.6);
    }
    if (event.type === "truck-depart") {
      this.closeInventory();
      this.showToast(t("toast.truckDepart"), 5);
    }
    if (event.type === "victory") {
      this.closeInventory();
      this.showVictory();
    }
    if (event.type === "game-over") {
      this.closeInventory();
      this.showGameOver();
    }
  }

  showToast(text: string, seconds = 2.3): void {
    this.toast.textContent = text;
    this.toast.classList.remove("hidden");
    this.toastTimer = seconds;
  }

  private updateInventory(): void {
    const player = this.simulation.player;
    this.slots.forEach((slot, index) => {
      const stack = player.inventory[index];
      if (!stack) {
        slot.innerHTML = "";
        slot.classList.add("empty");
        slot.disabled = true;
        slot.setAttribute("aria-label", t("pack.slot.empty", { index: index + 1 }));
        return;
      }
      slot.classList.remove("empty");
      slot.disabled = false;
      slot.innerHTML = `<span class="item-glyph">${itemGlyph(stack.kind)}</span><span class="item-name">${itemName(stack.kind)}</span><b class="item-count">${stack.count}</b>`;
      slot.setAttribute("aria-label", t("pack.slot.filled", { name: itemName(stack.kind), count: stack.count }));
    });
    this.handsStatus.textContent = player.carrying ? t(`carry.${player.carrying}`) : t("carry.empty");
    this.coatStatus.textContent = t(`equip.${player.armor}.hud`);
    this.weaponStatus.textContent = t(`equip.${player.weapon}.hud`);
    this.statHealth.textContent = `${Math.round(player.health)}/${player.maxHealth}`;
    this.statStamina.textContent = `${Math.round(player.stamina)}/${player.maxStamina}`;
    this.statAttack.textContent = String(this.simulation.getAttackPower());
    this.statDefense.textContent = String(this.simulation.getDefense());
    for (const [button, kind] of this.buildButtons) {
      const spec = STRUCTURE_SPECS[kind];
      const parts = spec.cost.map(([item, count]) =>
        `${itemName(item)} ${this.simulation.getInventoryCount(item)}/${count}`);
      button.textContent = t("build.button", { name: t(`structure.${kind}.name`), parts: parts.join(" + "), stamina: spec.stamina });
      button.disabled = spec.cost.some(([item, count]) => this.simulation.getInventoryCount(item) < count);
    }
    this.renderUpgradeSlot("armor");
    this.renderUpgradeSlot("weapon");
    const raws = this.simulation.getInventoryCount("raw-meat");
    this.craftCookButton.textContent = raws > 0
      ? t("craft.cook", { raws, health: 14 })
      : t("craft.cook.none");
    this.craftCookButton.disabled = raws < 1;
  }

  /**
   * 升级区有且只有三种状态，由 getUpgradeOptions() 返回的候选数量决定：
   *
   *   2 个 —— 阶 0，两条线的一阶同时可造 → **分叉卡**
   *   1 个 —— 已分叉未满级 → **升级卡**（当前 vs 下阶并排）
   *   0 个 —— 已满级 → **属性总览**
   *
   * 分叉卡刻意不做成两个并排的按钮：按钮只有一行字的预算，而这是全局最重的
   * 一次决策 —— 它决定接下来四天你去挖矿还是去捡柴。背包本来就暂停游戏，
   * 信息量不用省。
   */
  private renderUpgradeSlot(slot: "weapon" | "armor"): void {
    const host = slot === "weapon" ? this.weaponUpgradeSlot : this.armorUpgradeSlot;
    const options = this.simulation.getUpgradeOptions(slot);
    const equipped = this.simulation.getEquipped(slot);
    const noun = t(slot === "weapon" ? "slot.weapon" : "slot.armor");

    // 背包开着时这个方法每 0.08 秒被调一次。无脑重写 innerHTML 会让按钮一秒
    // 重建 12 次 —— 落在两次重建之间的点击会被整个吞掉。所以先算一个签名，
    // 只有真的有东西变了才重绘。
    const signature = [
      equipped.id,
      ...options.map((tier) => tier.id),
      ...options.flatMap((tier) => tier.cost.map(([kind, count]) => `${kind}${Math.min(this.simulation.getInventoryCount(kind), count)}`)),
      this.simulation.findNearestLitFire(10) === null ? "nofire" : "fire",
      this.pendingSwitch && this.pendingSwitch.slot === slot ? this.pendingSwitch.id : "-",
    ].join("|");
    if (this.upgradeSignatures.get(slot) === signature) return;
    this.upgradeSignatures.set(slot, signature);

    const html = options.length >= 2
      ? `<p class="upgrade-head">${t("upgrade.pickLine", { slot: noun })}</p>
         <div class="fork-card">${options.map((tier) => this.renderForkColumn(slot, tier)).join("")}</div>`
      : options.length === 1
        ? `<p class="upgrade-head">${noun} <span class="tier-pips">${this.renderPips(equipped.tier)}</span></p>
           ${this.renderUpgradeCard(equipped, options[0])}`
        : `<p class="upgrade-head">${noun} <span class="tier-pips">${this.renderPips(3)}</span> ${t("upgrade.maxed")}</p>
           <div class="upgrade-card maxed">
             <b style="color:${LINE_COLORS[equipped.line]}">${this.tierName(equipped)}</b>
             <span>${this.tierBlurb(equipped)}</span>
           </div>`;

    const switches = this.simulation.getSwitchOptions(slot);
    host.innerHTML = html + (switches.length === 0 ? "" : this.renderSwitchRow(slot, switches));
    this.bindUpgradeSlot(host, slot);
  }

  /** 装备的名字与说明都落在语言表里，键跟着装备 id 走。 */
  private tierName(tier: EquipTier): string {
    return t(`equip.${tier.id}.name`);
  }

  private tierBlurb(tier: EquipTier): string {
    return tier.tier === 0 ? "" : t(`equip.${tier.id}.blurb`);
  }

  private renderPips(tier: number): string {
    return [1, 2, 3].map((step) => (step <= tier ? "●" : "○")).join("");
  }

  /** 配方逐项打勾。缺什么一眼看得见，不用回头数背包。 */
  private renderCost(tier: EquipTier): string {
    return tier.cost.map(([kind, count]) => {
      const have = this.simulation.getInventoryCount(kind);
      return `<span class="${have >= count ? "ok" : "missing"}">${itemName(kind)} ${have}/${count}</span>`;
    }).join("");
  }

  /** 缺不缺火要分状态说：「需要火」和「火就在旁边」是两条不同的信息。 */
  private renderFireNote(tier: EquipTier): string {
    if (!tier.needsFire) return `<span class="ok">${t("fire.anywhere")}</span>`;
    return this.simulation.findNearestLitFire(10) !== null
      ? `<span class="ok">${t("fire.here")}</span>`
      : `<span class="missing">${t("fire.needed")}</span>`;
  }

  private blockedReason(tier: EquipTier): string | null {
    const missing = tier.cost.filter(([kind, count]) => this.simulation.getInventoryCount(kind) < count);
    if (missing.length > 0) {
      return t("blocked.missing", { parts: missing.map(([kind, count]) => `${itemName(kind)}×${count - this.simulation.getInventoryCount(kind)}`).join(" ") });
    }
    if (tier.needsFire && this.simulation.findNearestLitFire(10) === null) return t("blocked.needFire");
    return null;
  }

  /**
   * 分叉卡的一栏。五行的顺序不能换 —— **先说线的性格，再说这一件武器**：
   * 玩家要选的是一条路，不是一把刀。最后那行"终点"提醒他这是三阶的承诺。
   */
  private renderForkColumn(slot: "weapon" | "armor", tier: EquipTier): string {
    const blocked = this.blockedReason(tier);
    const finale = this.simulation.getLineFinale(slot, tier.line);
    return `
      <div class="fork-column" style="--line:${LINE_COLORS[tier.line]}">
        <b class="fork-title">${t(`line.${tier.line}.name`)}</b>
        <span class="fork-personality">${t(`line.${tier.line}.personality`)}</span>
        <b class="fork-item">${this.tierName(tier)}</b>
        <span class="fork-blurb">${this.tierBlurb(tier)}</span>
        <span class="fork-cost">${this.renderCost(tier)}</span>
        <span class="fork-fire">${this.renderFireNote(tier)}</span>
        <span class="fork-finale">${this.renderPips(1)} ${t("upgrade.finale", { name: finale ? t(`equip.${finale.id}.name`) : "—" })}</span>
        <button type="button" data-craft="${tier.id}" ${blocked ? "disabled" : ""}>${blocked ?? t("upgrade.craft", { name: this.tierName(tier) })}</button>
      </div>`;
  }

  /** 当前与下阶并排，属性同列对齐 —— 只写下一阶的话玩家得自己记住原来是多少。 */
  private renderUpgradeCard(current: EquipTier, next: EquipTier): string {
    const blocked = this.blockedReason(next);
    return `
      <div class="upgrade-card" style="--line:${LINE_COLORS[next.line]}">
        <div class="upgrade-row"><em>${t("upgrade.current")}</em><b>${this.tierName(current)}</b><span>${this.tierBlurb(current) || t("equip.starter")}</span></div>
        <div class="upgrade-arrow">↓</div>
        <div class="upgrade-row next"><em>${t("upgrade.next")}</em><b>${this.tierName(next)}</b><span>${this.tierBlurb(next)}</span></div>
        <span class="fork-cost">${this.renderCost(next)}</span>
        <span class="fork-fire">${this.renderFireNote(next)}</span>
        <button type="button" data-craft="${next.id}" ${blocked ? "disabled" : ""}>${blocked ?? t("upgrade.craft", { name: this.tierName(next) })}</button>
      </div>`;
  }

  /**
   * 换线。点第一下只是**亮出代价**，再点确认才执行 ——
   * 不用 window.confirm()：它在触屏上会顶出系统弹窗，样式也失控。
   */
  private renderSwitchRow(slot: "weapon" | "armor", switches: EquipTier[]): string {
    const pending = this.pendingSwitch;
    if (pending && pending.slot === slot) {
      const target = switches.find((tier) => tier.id === pending.id);
      if (target) {
        return `<div class="confirm-bar">
          <span>${t("switch.warning", { current: this.tierName(this.simulation.getEquipped(slot)), next: this.tierName(target) })}</span>
          <button type="button" data-craft="${target.id}">${t("switch.confirm")}</button>
          <button type="button" data-cancel="1">${t("switch.cancel")}</button>
        </div>`;
      }
    }
    return `<div class="switch-row">${switches.map((tier) =>
      `<button type="button" class="switch-button" data-switch="${tier.id}" style="--line:${LINE_COLORS[tier.line]}">${t("switch.to", { line: t(`line.${tier.line}.name`) })}</button>`
    ).join("")}</div>`;
  }

  private bindUpgradeSlot(host: HTMLElement, slot: "weapon" | "armor"): void {
    host.querySelectorAll<HTMLButtonElement>("button[data-craft]").forEach((button) => {
      button.addEventListener("click", () => {
        this.simulation.craftEquip(slot, button.dataset.craft ?? "");
        this.pendingSwitch = null;
        this.updateInventory();
      });
    });
    host.querySelectorAll<HTMLButtonElement>("button[data-switch]").forEach((button) => {
      button.addEventListener("click", () => {
        this.pendingSwitch = { slot, id: button.dataset.switch ?? "" };
        this.updateInventory();
      });
    });
    host.querySelectorAll<HTMLButtonElement>("button[data-cancel]").forEach((button) => {
      button.addEventListener("click", () => {
        this.pendingSwitch = null;
        this.updateInventory();
      });
    });
  }

  private setMeter(bar: HTMLElement, valueLabel: HTMLElement, rawValue: number, max = 100): void {
    const value = clamp(rawValue, 0, max);
    bar.style.width = `${(value / max) * 100}%`;
    valueLabel.textContent = String(Math.round(value));
  }

  /**
   * 结算本局并返回一句"破纪录 / 历史最好"的话。
   * 破了纪录就只报破的那几项 —— 平局时再念一遍旧纪录只会冲淡成就感。
   */
  private submitAndDescribe(won: boolean): string {
    const fuel = this.simulation.getFuelProgress();
    const { records, brokeEscape, brokeFuel } = submitRun({
      day: this.simulation.day,
      seconds: this.simulation.elapsed,
      fuel: fuel.loaded,
      won,
    });
    this.refreshRecordsLine();
    // 破了纪录就只报破的那一项 —— 平局时再念一遍旧纪录只会冲淡成就感。
    if (brokeEscape) {
      return t("records.escapeNew", { time: formatDuration(records.bestEscapeSeconds), day: records.bestEscapeDay });
    }
    if (brokeFuel) return t("records.fuelNew", { fuel: records.bestFuel });
    if (records.bestEscapeSeconds > 0) {
      return t("records.bestEscapeLong", {
        time: formatDuration(records.bestEscapeSeconds),
        day: records.bestEscapeDay,
      });
    }
    return t("records.bestFuelLong", { fuel: records.bestFuel });
  }

  /** 开场页那一行；没玩过时整行隐藏，不占版面。 */
  refreshRecordsLine(): void {
    const text = describeRecords(loadRecords());
    this.recordsLine.textContent = text ?? "";
    this.recordsLine.classList.toggle("hidden", text === null);
  }

  private showGameOver(): void {
    const wolfCount = this.simulation.wolves.filter((wolf) => wolf.mode !== "dead").length;
    const cause = this.simulation.deathCause;
    const causeText = t(`death.${cause ?? "killed"}`);
    // 体温越界本身不致死，但 -60%/-75% 的减速经常才是真凶。
    // 不点出来的话，玩家只会记住"被狼咬死了"，学不到该去烤火或降温。
    const condition = this.simulation.deathCondition;
    const conditionText = condition === "heatstroke"
      ? t("death.note.heatstroke")
      : condition === "hypothermia"
        ? t("death.note.hypothermia")
        : "";
    this.resultCopy.textContent = [
      t("over.summary", { day: this.simulation.day, kills: this.simulation.player.kills }),
      causeText,
      conditionText,
      t("over.remaining", { count: wolfCount }),
      this.submitAndDescribe(false),
    ].filter(Boolean).join(" ");
    this.gameOver.classList.remove("hidden");
  }

  private showVictory(): void {
    const player = this.simulation.player;
    this.victoryCopy.textContent = [
      t("win.summary", { day: this.simulation.day, kills: player.kills }),
      this.submitAndDescribe(true),
    ].filter(Boolean).join(" ");
    this.victory.classList.remove("hidden");
  }
}
