import type { GameSimulation } from "../game/simulation/GameSimulation";
import { clamp } from "../game/simulation/geometry";
import { describeRecords, loadRecords, submitRun } from "./Records";
import { STRUCTURE_SPECS } from "../game/simulation/types";
import type {
  GameEvent,
  InteractionHint,
  InventoryItemKind,
  DeathCause,
  SurvivalCondition,
  WeaponKind,
  ArmorKind,
  StructureKind,
  WolfKind,
} from "../game/simulation/types";

const required = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};

/**
 * 装备标签统一用**绝对值**，和 EquipTier.attack / .defense 同口径。
 * 原先武器写累计增量（"攻击+34"）、配方表写单阶增量（"攻击+16"），
 * 同一件装备在两个地方是两个数字。
 */
const WEAPON_LABELS: Record<WeaponKind, string> = {
  "survival-knife": "求生匕首 · 攻击 28",
  "iron-spear": "粗铁矛 · 攻击 46",
  "fang-spear": "狼牙重矛 · 攻击 62",
};

const ARMOR_LABELS: Record<ArmorKind, string> = {
  none: "粗布衣 · 防御 2",
  leather: "兽皮衣 · 防御 6",
  reinforced: "镶铁重甲 · 防御 13 移速-5%",
};

const ITEM_PRESENTATION: Record<InventoryItemKind, { glyph: string; name: string }> = {
  "cactus-juice": { glyph: "汁", name: "仙人掌汁" },
  "raw-meat": { glyph: "肉", name: "生肉" },
  "cooked-meat": { glyph: "熟", name: "烤肉" },
  hide: { glyph: "皮", name: "兽皮" },
  "iron-ore": { glyph: "铁", name: "铁矿" },
  "wash-water": { glyph: "洗", name: "洗脸水" },
  water: { glyph: "水", name: "水" },
  wood: { glyph: "柴", name: "枯木" },
};

const ACTION_LABELS: Record<InteractionHint["action"], string> = {
  pickup: "拿起",
  drop: "放置",
  feed: "添柴",
  cactus: "取汁",
  mine: "采矿",
  well: "提水",
  none: "行动",
};

const CONDITION_COPY: Record<Exclude<SurvivalCondition, "normal">, string> = {
  heatstroke: "中暑 · 移速 −60% 攻速 −50%",
  hypothermia: "失温 · 移速 −75% 攻速 −65%",
};

const DEATH_COPY: Record<DeathCause, string> = {
  dehydrated: "水分见底，你倒在了滚烫的沙子上 —— 仙人掌就在几十步外，你没能走到。",
  starved: "饥饿耗尽，你再没有力气站起来。",
  killed: "狼群撕碎了你的最后一道防线。",
  // 体力恒定流失把血耗干 —— 可能全程一只狼都没碰到，文案必须说清是没吃饭。
  exhausted: "没有一只狼碰到你。是体力一点点流干的 —— 熟肉是唯一能大量回体力的东西。",
};

const WOLF_LABELS: Record<WolfKind, string> = {
  small: "小狼",
  large: "大狼",
  alpha: "头狼",
};

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
  private readonly craftWashButton = required<HTMLButtonElement>("craft-wash-button");
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
    [required<HTMLElement>("supply-wash"), "wash-water"],
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
    if (!hot && !cold) {
      this.thermalState.textContent = "适宜";
      this.thermalButton.disabled = true;
      return;
    }
    if (cooldown > 0) {
      this.thermalState.textContent = `${Math.ceil(cooldown)}s`;
      this.thermalButton.disabled = true;
      return;
    }
    this.thermalState.textContent = hot ? "降温" : "取暖";
    this.thermalButton.disabled = false;
  }
  private readonly objective = required<HTMLElement>("objective");
  private readonly dayLabel = required<HTMLElement>("day-label");
  private readonly phaseLabel = required<HTMLElement>("phase-label");
  private readonly timeLabel = required<HTMLElement>("time-label");
  private readonly clock = required<HTMLElement>("clock");
  private readonly bossBar = required<HTMLElement>("boss-bar");
  private readonly bossName = required<HTMLElement>("boss-name");
  private readonly bossStats = required<HTMLElement>("boss-stats");
  private readonly bossHealthBar = required<HTMLElement>("boss-health-bar");
  private readonly prompt = required<HTMLElement>("prompt");
  private readonly restIndicator = required<HTMLElement>("rest-indicator");
  private readonly gatherIndicator = required<HTMLElement>("gather-indicator");
  private readonly actionButton = required<HTMLButtonElement>("action-button");
  private readonly toast = required<HTMLElement>("toast");
  private readonly resultCopy = required<HTMLElement>("result-copy");
  private readonly victoryCopy = required<HTMLElement>("victory-copy");
  private readonly recordsLine = required<HTMLElement>("records-line");
  private readonly handsStatus = required<HTMLElement>("hands-status");
  private readonly coatStatus = required<HTMLElement>("coat-status");
  private readonly weaponStatus = required<HTMLElement>("weapon-status");
  private readonly statHealth = required<HTMLElement>("stat-health");
  private readonly statStamina = required<HTMLElement>("stat-stamina");
  private readonly statAttack = required<HTMLElement>("stat-attack");
  private readonly statDefense = required<HTMLElement>("stat-defense");
  private readonly craftButton = required<HTMLButtonElement>("craft-coat-button");
  private readonly craftSpearButton = required<HTMLButtonElement>("craft-spear-button");
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
    this.craftButton.addEventListener("click", () => {
      this.simulation.craftArmor();
      this.updateInventory();
    });
    this.craftSpearButton.addEventListener("click", () => {
      this.simulation.craftWeapon();
      this.updateInventory();
    });
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
    this.craftWashButton.addEventListener("click", () => {
      this.simulation.craftWashWater();
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
    this.objective.textContent = this.simulation.getObjective();
    this.dayLabel.textContent = `第 ${this.simulation.day} 天 · ${this.simulation.getCurrentLocationLabel()} · 狼 ${this.simulation.wolves.filter((wolf) => wolf.mode !== "dead").length}`;
    this.phaseLabel.textContent = this.simulation.phase === "day" ? "白昼" : "黑夜";
    this.clock.classList.toggle("night", this.simulation.phase === "night");
    const seconds = Math.max(0, Math.ceil(this.simulation.phaseTime));
    this.timeLabel.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    // 取水和休息在模拟层本来就互斥（取水时 getRestBlocker 返回"取水中"），这里再显式
    // 互斥一次：竖屏上中央栏和右上状态栏之间只剩 10px 余量，两个胶囊同时出现就会顶上去。
    // 把这条保证放在布局本地，将来改模拟层也不会悄悄把它弄坏。
    const gathering = player.gatherTimer > 0;
    this.gatherIndicator.classList.toggle("hidden", !gathering);
    this.restIndicator.classList.toggle("hidden", gathering || !player.resting);
    if (gathering) this.gatherIndicator.textContent = `取水中… ${player.gatherTimer.toFixed(1)}s`;

    // 只有头狼配得上一条常驻 BOSS 血槽；普通狼的血量走头顶跟随血条（见 GameRenderer）。
    const alpha = this.simulation.getAlpha();
    this.bossBar.classList.toggle("hidden", !alpha);
    if (alpha) {
      const ratio = clamp(alpha.health / alpha.maxHealth, 0, 1);
      this.bossName.textContent = WOLF_LABELS[alpha.kind];
      this.bossStats.textContent = `${Math.max(0, Math.ceil(alpha.health))} / ${alpha.maxHealth}`;
      this.bossHealthBar.style.width = `${ratio * 100}%`;
    }

    const hint = this.simulation.getInteractionHint();
    const touchLayout = matchMedia("(pointer: coarse)").matches || window.innerWidth <= 760;
    this.actionButton.textContent = ACTION_LABELS[hint.action];
    if (hint.action === "none") {
      this.prompt.classList.add("hidden");
    } else if (touchLayout) {
      // 提示就贴在"行动"键上方，键名由那颗按钮自己说 —— 这里再写一遍纯属重复。
      this.prompt.textContent = hint.text;
      this.prompt.classList.remove("hidden");
    } else {
      this.prompt.innerHTML = `<kbd>E</kbd>${hint.text}`;
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
      this.conditionBadge.textContent = CONDITION_COPY[condition];
      return;
    }
    if (player.stamina < 12) {
      this.conditionBadge.className = "condition-badge exhausted";
      this.conditionBadge.textContent = "脱力 · 站定回复劳力";
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
      ? `体力持续消耗 · ${blocker}`
      : "体力持续消耗 · 进食或站定 5 秒休息";
  }

  private updateHuntProgress(): void {
    const alpha = this.simulation.getAlpha();
    const progress = this.simulation.getAlphaProgress();
    this.huntProgress.classList.toggle("alpha", Boolean(alpha));
    // 头狼在场时血量由顶部 BOSS 条负责，这里只说进度，不重复报血。
    this.huntProgress.textContent = alpha
      ? "头狼已登场"
      : progress.spawned
        ? `猎杀 ${progress.kills}`
        : `猎杀 ${progress.kills}/${progress.required}`;
  }

  handle(event: GameEvent): void {
    if (event.type === "message") this.showToast(event.text, 3.1);
    if (event.type === "phase") {
      this.showToast(event.phase === "night" ? `第 ${event.day} 夜 · 狼群正在涌入` : `第 ${event.day} 天 · 狼群正在撤离`, 3.4);
    }
    if (event.type === "pickup" && (event.kind === "raw-meat" || event.kind === "hide" || event.kind === "water")) {
      const label = event.kind === "raw-meat" ? "获得生肉" : event.kind === "hide" ? "获得兽皮" : "取到水";
      this.showToast(label, 1.4);
    }
    if (event.type === "critter-killed") {
      const label = this.simulation.getCritterLabel(event.kind);
      this.showToast(event.kind === "camel" ? `猎到${label} · 大量肉与水` : `猎到${label}`, 1.8);
    }
    if (event.type === "alpha-spawned") this.showToast("头狼登场 · 击杀它即可获救", 4);
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
        slot.setAttribute("aria-label", `空格 ${index + 1}`);
        return;
      }
      const presentation = ITEM_PRESENTATION[stack.kind];
      slot.classList.remove("empty");
      slot.disabled = false;
      slot.innerHTML = `<span class="item-glyph">${presentation.glyph}</span><span class="item-name">${presentation.name}</span><b class="item-count">${stack.count}</b>`;
      slot.setAttribute("aria-label", `${presentation.name} ${stack.count}个`);
    });
    this.handsStatus.textContent = player.carrying === "stone" ? "大石" : "空闲";
    this.coatStatus.textContent = ARMOR_LABELS[player.armor];
    this.weaponStatus.textContent = WEAPON_LABELS[player.weapon];
    this.statHealth.textContent = `${Math.round(player.health)}/${player.maxHealth}`;
    this.statStamina.textContent = `${Math.round(player.stamina)}/${player.maxStamina}`;
    this.statAttack.textContent = String(this.simulation.getAttackPower());
    this.statDefense.textContent = String(this.simulation.getDefense());
    for (const [button, kind] of this.buildButtons) {
      const spec = STRUCTURE_SPECS[kind];
      const parts = spec.cost.map(([item, count]) =>
        `${ITEM_PRESENTATION[item].name} ${this.simulation.getInventoryCount(item)}/${count}`);
      button.textContent = `搭${spec.label} · ${parts.join(" + ")} · 劳力 ${spec.stamina}`;
      button.disabled = spec.cost.some(([item, count]) => this.simulation.getInventoryCount(item) < count);
    }
    this.syncUpgradeButton(this.craftButton, "armor");
    this.syncUpgradeButton(this.craftSpearButton, "weapon");
    const raws = this.simulation.getInventoryCount("raw-meat");
    this.craftCookButton.textContent = raws > 0
      ? `烤肉 · 生肉 ${raws} → 熟肉（回体力 ${14}）· 需燃烧篝火`
      : "烤肉 · 没有生肉";
    this.craftCookButton.disabled = raws < 1;
    const waters = this.simulation.getInventoryCount("water");
    this.craftWashButton.textContent = waters > 0
      ? `兑洗脸水 · 水 ${waters} → 降温 25~50`
      : "兑洗脸水 · 需要 1 份水";
    this.craftWashButton.disabled = waters < 1;
  }

  /**
   * 升级按钮自己说清三件事：下一阶叫什么、还差多少材料、缺不缺篝火。
   * 材料以「已有/需要」显示，玩家不用回头数背包。
   */
  private syncUpgradeButton(button: HTMLButtonElement, line: "weapon" | "armor"): void {
    const next = this.simulation.getNextTier(line);
    if (!next) {
      button.textContent = line === "armor" ? "护甲已满级" : "武器已满级";
      button.disabled = true;
      return;
    }
    const parts = next.cost.map(([kind, count]) => {
      const have = this.simulation.getInventoryCount(kind);
      return `${ITEM_PRESENTATION[kind].name} ${have}/${count}`;
    });
    const fire = next.needsFire ? " · 需燃烧篝火" : "";
    button.textContent = `${next.label} · ${parts.join(" + ")}${fire} · ${next.blurb}`;
    button.disabled = next.cost.some(([kind, count]) => this.simulation.getInventoryCount(kind) < count);
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
    const { records, brokeDay, brokeKills } = submitRun({
      day: this.simulation.day,
      kills: this.simulation.player.kills,
      won,
    });
    this.refreshRecordsLine();
    if (brokeDay && brokeKills) return `新纪录：第 ${records.bestDay} 天 · 猎杀 ${records.bestKills}。`;
    if (brokeDay) return `新纪录：活到了第 ${records.bestDay} 天。`;
    if (brokeKills) return `新纪录：单局猎杀 ${records.bestKills} 只。`;
    return `历史最好：第 ${records.bestDay} 天 · 猎杀 ${records.bestKills}。`;
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
    const causeText = DEATH_COPY[cause ?? "killed"];
    // 体温越界本身不致死，但 -60%/-75% 的减速经常才是真凶。
    // 不点出来的话，玩家只会记住"被狼咬死了"，学不到该去烤火或降温。
    const condition = this.simulation.deathCondition;
    const conditionText = condition === "heatstroke"
      ? "倒下时你正中暑，移速只剩四成 —— 白天该喝水或用洗脸水压住体温。"
      : condition === "hypothermia"
        ? "倒下时你正失温，几乎迈不开腿 —— 夜里该守着篝火，或者早点添柴。"
        : "";
    this.resultCopy.textContent = [
      `坚持到第 ${this.simulation.day} 天，猎杀 ${this.simulation.player.kills} 只狼。`,
      causeText,
      conditionText,
      `沙海上仍有 ${wolfCount} 只狼在活动。`,
      this.submitAndDescribe(false),
    ].filter(Boolean).join(" ");
    this.gameOver.classList.remove("hidden");
  }

  private showVictory(): void {
    const player = this.simulation.player;
    this.victoryCopy.textContent = [
      `第 ${this.simulation.day} 天，你击倒了头狼，累计猎杀 ${player.kills} 只。狼群散了，营地的火终于可以安心地烧到天亮。`,
      this.submitAndDescribe(true),
    ].filter(Boolean).join(" ");
    this.victory.classList.remove("hidden");
  }
}
