import type { GameSimulation } from "../game/simulation/GameSimulation";
import { clamp } from "../game/simulation/geometry";
import type { GameEvent } from "../game/simulation/types";

const required = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};

export class HudController {
  private readonly simulation: GameSimulation;
  private readonly hud = required<HTMLElement>("hud");
  private readonly intro = required<HTMLElement>("intro");
  private readonly gameOver = required<HTMLElement>("game-over");
  private readonly healthBar = required<HTMLElement>("health-bar");
  private readonly warmthBar = required<HTMLElement>("warmth-bar");
  private readonly hungerBar = required<HTMLElement>("hunger-bar");
  private readonly healthValue = required<HTMLElement>("health-value");
  private readonly warmthValue = required<HTMLElement>("warmth-value");
  private readonly hungerValue = required<HTMLElement>("hunger-value");
  private readonly berryCount = required<HTMLElement>("berry-count");
  private readonly eatButton = required<HTMLButtonElement>("eat-button");
  private readonly objective = required<HTMLElement>("objective");
  private readonly dayLabel = required<HTMLElement>("day-label");
  private readonly phaseLabel = required<HTMLElement>("phase-label");
  private readonly timeLabel = required<HTMLElement>("time-label");
  private readonly clock = required<HTMLElement>("clock");
  private readonly prompt = required<HTMLElement>("prompt");
  private readonly actionButton = required<HTMLButtonElement>("action-button");
  private readonly toast = required<HTMLElement>("toast");
  private readonly radar = required<HTMLCanvasElement>("radar");
  private readonly resultCopy = required<HTMLElement>("result-copy");
  private toastTimer = 0;
  private lastHudUpdate = 0;

  constructor(simulation: GameSimulation) {
    this.simulation = simulation;
  }

  showGame(): void {
    this.intro.classList.add("hidden");
    this.hud.classList.remove("hidden");
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
    this.setMeter(this.warmthBar, this.warmthValue, player.warmth);
    this.setMeter(this.hungerBar, this.hungerValue, player.hunger);
    this.berryCount.textContent = String(player.berries);
    this.eatButton.disabled = player.berries <= 0 || player.hunger >= 99;
    this.objective.textContent = this.simulation.getObjective();
    this.dayLabel.textContent = `第 ${this.simulation.day} 天 · 已猎杀 ${player.kills}`;
    this.phaseLabel.textContent = this.simulation.phase === "day" ? "白昼" : "黑夜";
    this.clock.classList.toggle("night", this.simulation.phase === "night");
    const seconds = Math.max(0, Math.ceil(this.simulation.phaseTime));
    this.timeLabel.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

    const hint = this.simulation.getInteractionHint();
    const touchLayout = matchMedia("(pointer: coarse)").matches || window.innerWidth <= 760;
    const actionLabels = {
      pickup: "拿起",
      drop: "放置",
      feed: "添柴",
      berry: "采集",
      none: "行动",
    } as const;
    this.actionButton.textContent = actionLabels[hint.action];
    if (hint.action === "none") {
      this.prompt.classList.add("hidden");
    } else {
      const key = touchLayout ? `行动：${actionLabels[hint.action]}` : "E";
      this.prompt.innerHTML = `<kbd>${key}</kbd>${hint.text}`;
      this.prompt.classList.remove("hidden");
    }
    this.drawRadar();
  }

  handle(event: GameEvent): void {
    if (event.type === "message") this.showToast(event.text, 3.1);
    if (event.type === "phase") {
      this.showToast(event.phase === "night" ? `第 ${event.day} 夜 · 狼群正在进入` : `第 ${event.day} 天 · 抓紧补给`, 3.4);
    }
    if (event.type === "game-over") this.showGameOver();
  }

  showToast(text: string, seconds = 2.3): void {
    this.toast.textContent = text;
    this.toast.classList.remove("hidden");
    this.toastTimer = seconds;
  }

  private setMeter(bar: HTMLElement, valueLabel: HTMLElement, rawValue: number): void {
    const value = clamp(rawValue, 0, 100);
    bar.style.width = `${value}%`;
    valueLabel.textContent = String(Math.round(value));
  }

  private showGameOver(): void {
    const wolfCount = this.simulation.wolves.filter((wolf) => wolf.mode !== "dead").length;
    this.resultCopy.textContent = `坚持到第 ${this.simulation.day} 天，猎杀 ${this.simulation.player.kills} 只狼。雪原上仍有 ${wolfCount} 只狼在活动。`;
    this.gameOver.classList.remove("hidden");
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

    for (const wolf of this.simulation.wolves) {
      if (wolf.mode === "dead") continue;
      const x = (wolf.x - player.x) * worldScale;
      const y = (wolf.z - player.z) * worldScale;
      if (Math.hypot(x, y) > center - 7) continue;
      context.fillStyle = wolf.mode === "chase" ? "#ff5347" : "rgba(225, 115, 99, .62)";
      context.fillRect(x - 1.5, y - 1.5, 3, 3);
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
