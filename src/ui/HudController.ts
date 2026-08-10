import type { GameSimulation } from "../game/simulation/GameSimulation";
import { clamp } from "../game/simulation/geometry";
import type {
  GameEvent,
  InteractionHint,
  InventoryItemKind,
  SurvivalCondition,
  WolfKind,
} from "../game/simulation/types";

const required = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};

const ITEM_PRESENTATION: Record<InventoryItemKind, { glyph: string; name: string }> = {
  "cactus-juice": { glyph: "汁", name: "仙人掌汁" },
  "raw-meat": { glyph: "肉", name: "生肉" },
  "cooked-meat": { glyph: "熟", name: "烤肉" },
  hide: { glyph: "皮", name: "兽皮" },
  "iron-ore": { glyph: "铁", name: "铁矿" },
  water: { glyph: "水", name: "水" },
};

const ACTION_LABELS: Record<InteractionHint["action"], string> = {
  pickup: "拿起",
  drop: "放置",
  feed: "添柴",
  cactus: "取汁",
  mine: "采矿",
  dig: "挖沙",
  none: "行动",
};

const CONDITION_COPY: Record<Exclude<SurvivalCondition, "normal">, string> = {
  heatstroke: "中暑 · 移速 −60% 攻速 −50%",
  hypothermia: "失温 · 移速 −75% 攻速 −65%",
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
  private readonly hungerValue = required<HTMLElement>("hunger-value");
  private readonly waterValue = required<HTMLElement>("water-value");
  private readonly staminaValue = required<HTMLElement>("stamina-value");
  private readonly conditionBadge = required<HTMLElement>("condition-badge");
  private readonly drainNote = required<HTMLElement>("drain-note");
  private readonly huntProgress = required<HTMLElement>("hunt-progress");
  private readonly attackValue = required<HTMLElement>("attack-value");
  private readonly defenseValue = required<HTMLElement>("defense-value");
  private readonly berryCount = required<HTMLElement>("berry-count");
  private readonly waterCount = required<HTMLElement>("water-count");
  private readonly bagUsage = required<HTMLElement>("bag-usage");
  private readonly eatButton = required<HTMLButtonElement>("eat-button");
  private readonly drinkButton = required<HTMLButtonElement>("drink-button");
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
  private readonly enemyChip = required<HTMLElement>("enemy-chip");
  private readonly enemyName = required<HTMLElement>("enemy-name");
  private readonly enemyStats = required<HTMLElement>("enemy-stats");
  private readonly enemyHealthBar = required<HTMLElement>("enemy-health-bar");
  private readonly enemyHealthValue = required<HTMLElement>("enemy-health-value");
  private readonly prompt = required<HTMLElement>("prompt");
  private readonly restIndicator = required<HTMLElement>("rest-indicator");
  private readonly gatherIndicator = required<HTMLElement>("gather-indicator");
  private readonly actionButton = required<HTMLButtonElement>("action-button");
  private readonly toast = required<HTMLElement>("toast");
  private readonly radar = required<HTMLCanvasElement>("radar");
  private readonly resultCopy = required<HTMLElement>("result-copy");
  private readonly victoryCopy = required<HTMLElement>("victory-copy");
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
      this.simulation.craftLeatherCoat();
      this.updateInventory();
    });
    this.craftSpearButton.addEventListener("click", () => {
      this.simulation.craftIronSpear();
      this.updateInventory();
    });
    this.drinkButton.addEventListener("click", () => {
      this.simulation.consumeWater();
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

    this.attackValue.textContent = String(player.attack);
    this.defenseValue.textContent = String(player.defense);
    const berries = this.simulation.getInventoryCount("cactus-juice");
    this.berryCount.textContent = String(berries);
    this.eatButton.disabled = berries <= 0 || (player.hunger >= 99 && player.health >= player.maxHealth);
    const waters = this.simulation.getInventoryCount("water");
    this.waterCount.textContent = String(waters);
    this.drinkButton.disabled = waters <= 0 || player.water >= 99;
    this.syncThermalButton(player.warmth);
    this.bagUsage.textContent = `${player.inventory.filter(Boolean).length}/8`;
    this.objective.textContent = this.simulation.getObjective();
    this.dayLabel.textContent = `第 ${this.simulation.day} 天 · ${this.simulation.getCurrentLocationLabel()} · 狼 ${this.simulation.wolves.filter((wolf) => wolf.mode !== "dead").length}`;
    this.phaseLabel.textContent = this.simulation.phase === "day" ? "白昼" : "黑夜";
    this.clock.classList.toggle("night", this.simulation.phase === "night");
    const seconds = Math.max(0, Math.ceil(this.simulation.phaseTime));
    this.timeLabel.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    this.restIndicator.classList.toggle("hidden", !player.resting);
    this.gatherIndicator.classList.toggle("hidden", player.gatherTimer <= 0);
    if (player.gatherTimer > 0) this.gatherIndicator.textContent = `取水中… ${player.gatherTimer.toFixed(1)}s`;

    const threat = this.simulation.getNearestThreat();
    this.enemyChip.classList.toggle("hidden", !threat);
    if (threat) {
      const wild = threat.role === "wild" ? " · 野生" : "";
      this.enemyName.textContent = WOLF_LABELS[threat.kind] + wild;
      this.enemyStats.textContent = `攻${threat.attack} · 防${threat.defense}`;
      this.enemyHealthBar.style.width = `${clamp(threat.health / threat.maxHealth, 0, 1) * 100}%`;
      this.enemyHealthValue.textContent = `${Math.max(0, Math.ceil(threat.health))}/${threat.maxHealth}`;
    }

    const hint = this.simulation.getInteractionHint();
    const touchLayout = matchMedia("(pointer: coarse)").matches || window.innerWidth <= 760;
    this.actionButton.textContent = ACTION_LABELS[hint.action];
    if (hint.action === "none") {
      this.prompt.classList.add("hidden");
    } else {
      const key = touchLayout ? `行动：${ACTION_LABELS[hint.action]}` : "E";
      this.prompt.innerHTML = `<kbd>${key}</kbd>${hint.text}`;
      this.prompt.classList.remove("hidden");
    }
    if (this.inventoryOpen) this.updateInventory();
    this.drawRadar();
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
   * 体力恒定流失最容易被误读成"被看不见的东西攻击"，所以这一行必须常驻，
   * 而且要随状态改写：休息时明确显示在回复，被狼咬时明确显示是受击。
   */
  private updateDrainNote(): void {
    const player = this.simulation.player;
    if (player.hurtFlash > 0) {
      this.drainNote.className = "drain-note";
      this.drainNote.textContent = "正在被攻击 · 看小地图红点";
      return;
    }
    if (player.resting) {
      this.drainNote.className = "drain-note healing";
      this.drainNote.textContent = "休息中 · 体力与劳力回升";
      return;
    }
    this.drainNote.className = "drain-note";
    // 站定却不回复时必须说清是哪一条挡住了，否则玩家会以为是 bug。
    const blocker = this.simulation.getRestBlocker();
    this.drainNote.textContent = blocker
      ? `体力持续消耗 · ${blocker}`
      : "体力持续消耗 · 进食或站定 5 秒休息";
  }

  private updateHuntProgress(): void {
    const alpha = this.simulation.getAlpha();
    const progress = this.simulation.getAlphaProgress();
    this.huntProgress.parentElement?.classList.toggle("alpha", Boolean(alpha));
    if (alpha) {
      this.huntProgress.textContent = `头狼 ${Math.max(0, Math.ceil(alpha.health))}/${alpha.maxHealth}`;
      return;
    }
    if (progress.spawned) {
      this.huntProgress.textContent = `猎杀 ${progress.kills} · 头狼已现身`;
      return;
    }
    this.huntProgress.textContent = `猎杀 ${progress.kills}/${progress.required} 引出头狼`;
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
    this.handsStatus.textContent = player.carrying === "wood" ? "枯木" : player.carrying === "stone" ? "大石" : "空闲";
    this.coatStatus.textContent = player.hasLeatherCoat ? "基础皮衣 · 防御+4" : "粗布衣";
    this.weaponStatus.textContent = player.weapon === "iron-spear" ? "粗铁矛 · 攻击+18" : "木棒";
    this.statHealth.textContent = `${Math.round(player.health)}/${player.maxHealth}`;
    this.statStamina.textContent = `${Math.round(player.stamina)}/${player.maxStamina}`;
    this.statAttack.textContent = String(player.attack);
    this.statDefense.textContent = String(player.defense);
    const hides = this.simulation.getInventoryCount("hide");
    const ore = this.simulation.getInventoryCount("iron-ore");
    this.craftButton.textContent = player.hasLeatherCoat ? "基础皮衣已装备" : `基础皮衣 · 兽皮 ${hides}/4 · 防御+4`;
    this.craftButton.disabled = player.hasLeatherCoat || hides < 4;
    this.craftSpearButton.textContent = player.weapon === "iron-spear" ? "粗铁矛已装备" : `粗铁矛 · 铁矿 ${ore}/3 + 兽皮 ${hides}/1 · 需燃烧篝火`;
    this.craftSpearButton.disabled = player.weapon === "iron-spear" || ore < 3 || hides < 1;
  }

  private setMeter(bar: HTMLElement, valueLabel: HTMLElement, rawValue: number, max = 100): void {
    const value = clamp(rawValue, 0, max);
    bar.style.width = `${(value / max) * 100}%`;
    valueLabel.textContent = String(Math.round(value));
  }

  private showGameOver(): void {
    const wolfCount = this.simulation.wolves.filter((wolf) => wolf.mode !== "dead").length;
    const cause = this.simulation.deathCause;
    const causeText = cause === "dehydrated"
      ? "水分见底，你倒在了滚烫的沙子上 —— 仙人掌就在几十步外，你没能走到。"
      : cause === "starved"
        ? "饥饿耗尽，你再没有力气站起来。"
        : "狼群撕碎了你的最后一道防线。";
    this.resultCopy.textContent = `坚持到第 ${this.simulation.day} 天，猎杀 ${this.simulation.player.kills} 只狼。${causeText} 沙海上仍有 ${wolfCount} 只狼在活动。`;
    this.gameOver.classList.remove("hidden");
  }

  private showVictory(): void {
    const player = this.simulation.player;
    this.victoryCopy.textContent = `第 ${this.simulation.day} 天，你击倒了头狼，累计猎杀 ${player.kills} 只。狼群散了，营地的火终于可以安心地烧到天亮。`;
    this.victory.classList.remove("hidden");
  }

  private drawRadar(): void {
    const context = this.radar.getContext("2d");
    if (!context) return;
    const size = this.radar.width;
    const center = size / 2;
    const worldScale = (size - 18) / this.simulation.world.size;
    context.clearRect(0, 0, size, size);
    context.save();
    context.translate(center, center);
    context.strokeStyle = "rgba(190, 224, 234, .16)";
    context.lineWidth = 1;
    for (let ring = 1; ring <= 3; ring += 1) {
      context.beginPath();
      context.arc(0, 0, ring * 22, 0, Math.PI * 2);
      context.stroke();
    }

    const player = this.simulation.player;
    for (const camp of this.simulation.world.camps) {
      const x = (camp.x - player.x) * worldScale;
      const y = (camp.z - player.z) * worldScale;
      const lit = this.simulation.camps[camp.id].fuel > 0;
      context.fillStyle = lit ? "#ff9d43" : "rgba(177, 213, 223, .62)";
      context.beginPath();
      context.arc(x, y, lit ? 3.2 : 2, 0, Math.PI * 2);
      context.fill();
    }

    for (const item of this.simulation.items) {
      if (!item.active || !item.placed) continue;
      const x = (item.x - player.x) * worldScale;
      const y = (item.z - player.z) * worldScale;
      context.fillStyle = item.kind === "stone" ? "#a7b2b5" : "#9c724c";
      context.fillRect(x - 1, y - 1, 2, 2);
    }

    // 猎物用暗黄小点，和狼的红色系明确区分：地图上一眼能分出"能吃的"和"要命的"。
    for (const critter of this.simulation.critters) {
      if (critter.mode === "dead") continue;
      const x = (critter.x - player.x) * worldScale;
      const y = (critter.z - player.z) * worldScale;
      if (Math.hypot(x, y) > center - 7) continue;
      context.fillStyle = critter.kind === "camel" ? "rgba(232, 200, 130, .9)" : "rgba(196, 176, 128, .6)";
      const size = critter.kind === "camel" ? 4 : 2.5;
      context.fillRect(x - size / 2, y - size / 2, size, size);
    }

    for (const wolf of this.simulation.wolves) {
      if (wolf.mode === "dead") continue;
      const x = (wolf.x - player.x) * worldScale;
      const y = (wolf.z - player.z) * worldScale;
      if (Math.hypot(x, y) > center - 7) continue;
      // 头狼用亮红方块最醒目；白天的野狼用青灰，和夜袭狼一眼可分。
      context.fillStyle = wolf.kind === "alpha" ? "#ff2b1f"
        : wolf.role === "wild" ? "rgba(150, 205, 175, .72)"
          : wolf.mode === "chase" ? "#ff5347"
            : wolf.mode === "retreating" ? "rgba(150, 190, 198, .55)"
              : "rgba(225, 115, 99, .62)";
      const wolfSize = wolf.kind === "alpha" ? 7 : wolf.kind === "large" ? 4.5 : 3;
      context.fillRect(x - wolfSize / 2, y - wolfSize / 2, wolfSize, wolfSize);
    }

    context.rotate(Math.atan2(player.facing.z, player.facing.x) + Math.PI / 2);
    context.fillStyle = "#eafaff";
    context.beginPath();
    context.moveTo(0, -7);
    context.lineTo(5, 6);
    context.lineTo(0, 3.5);
    context.lineTo(-5, 6);
    context.closePath();
    context.fill();
    context.restore();
  }
}
