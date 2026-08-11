import "./styles.css";
import { SynthAudio } from "./audio/SynthAudio";
import { createWorld } from "./game/content/createWorld";
import { InputController } from "./game/input/InputController";
import { GameSimulation } from "./game/simulation/GameSimulation";
import { GameRenderer } from "./render/GameRenderer";
import { HudController } from "./ui/HudController";
import { requestLandscapeLock } from "./ui/orientation";

const renderRoot = document.getElementById("render-root");
if (!renderRoot) throw new Error("Missing render root");

let renderer: GameRenderer;
const world = createWorld();
if (import.meta.env.DEV) {
  const previewCampValue = new URLSearchParams(window.location.search).get("camp");
  if (previewCampValue !== null) {
    const previewCamp = Number(previewCampValue);
    if (Number.isInteger(previewCamp) && previewCamp >= 0 && previewCamp < world.camps.length) {
      world.startCampId = previewCamp;
    }
  }
}
const simulation = new GameSimulation(world);
if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("night") === "1") {
  simulation.phase = "night";
  simulation.phaseTime = 105;
}
const audio = new SynthAudio();
const hud = new HudController(simulation);
// 重开是整页刷新，所以开场页每次都会重新读一次记录。
hud.refreshRecordsLine();

if (import.meta.env.DEV) {
  // 开发期调试句柄：用来在浏览器控制台里快进模拟、检查五轴状态。
  (window as unknown as { game: unknown }).game = { simulation, world, hud };
}

const runGameplayAction = (action: () => void): void => {
  if (!hud.isGameplayBlocked()) action();
};

try {
  renderer = new GameRenderer(renderRoot, world, simulation);
} catch (error) {
  console.error(error);
  document.getElementById("unsupported")?.classList.remove("hidden");
  throw error;
}

const input = new InputController({
  onAction: () => runGameplayAction(() => simulation.requestInteraction()),
  onAttack: () => runGameplayAction(() => simulation.requestAttack()),
  onEat: () => runGameplayAction(() => simulation.consumeJuice()),
  onDrink: () => runGameplayAction(() => simulation.consumeWater()),
  onThermal: () => runGameplayAction(() => simulation.requestThermalAction()),
  onWash: () => runGameplayAction(() => simulation.consumeWashWater()),
  onInventory: () => hud.toggleInventory(),
});
input.bindCanvas(renderer.canvas, (x, y) => renderer.screenToWorld(x, y));

let started = false;
let previousTime = performance.now();
let hiddenAt = 0;

document.getElementById("start-button")?.addEventListener("click", async () => {
  await audio.unlock();
  // 锁方向必须在用户手势里发起，所以挂在开始按钮上；锁不上也照样能玩。
  void requestLandscapeLock();
  started = true;
  simulation.start();
  hud.showGame();
});

document.getElementById("restart-button")?.addEventListener("click", () => window.location.reload());
document.getElementById("victory-restart-button")?.addEventListener("click", () => window.location.reload());
document.getElementById("sound-button")?.addEventListener("click", async () => {
  await audio.unlock();
  const enabled = audio.toggle();
  const button = document.getElementById("sound-button");
  if (button) button.textContent = enabled ? "声音 开" : "声音 关";
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenAt = performance.now();
  } else {
    previousTime = performance.now();
    if (started && hiddenAt > 0) hud.showToast("游戏已继续", 1.5);
  }
});

const frame = (now: number): void => {
  const delta = Math.min((now - previousTime) / 1000, 0.05);
  previousTime = now;
  if (!document.hidden) {
    if (started && !hud.isGameplayBlocked()) simulation.update(delta, input.getMovement(simulation.player));
    const events = simulation.drainEvents();
    for (const event of events) {
      audio.handle(event);
      hud.handle(event);
      if (event.type === "player-hit") renderer.impact(0.22);
      if (event.type === "wolf-hit") renderer.impact(0.09);
      if (event.type === "barrier-hit") {
        renderer.impact(0.035);
        renderer.barrierHit(event.itemId);
      }
      if (event.type === "game-over") input.cancelMoveTarget();
    }
    hud.update(delta);
    renderer.render(delta);
  }
  requestAnimationFrame(frame);
};

requestAnimationFrame(frame);
