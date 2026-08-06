import "./styles.css";
import { SynthAudio } from "./audio/SynthAudio";
import { createWorld } from "./game/content/createWorld";
import { InputController } from "./game/input/InputController";
import { GameSimulation } from "./game/simulation/GameSimulation";
import { GameRenderer } from "./render/GameRenderer";
import { HudController } from "./ui/HudController";

const renderRoot = document.getElementById("render-root");
if (!renderRoot) throw new Error("Missing render root");

let renderer: GameRenderer;
const world = createWorld();
const simulation = new GameSimulation(world);
const audio = new SynthAudio();
const hud = new HudController(simulation);

try {
  renderer = new GameRenderer(renderRoot, world, simulation);
} catch (error) {
  console.error(error);
  document.getElementById("unsupported")?.classList.remove("hidden");
  throw error;
}

const input = new InputController({
  onAction: () => simulation.requestInteraction(),
  onAttack: () => simulation.requestAttack(),
  onEat: () => simulation.consumeBerry(),
});
input.bindCanvas(renderer.canvas, (x, y) => renderer.screenToWorld(x, y));

let started = false;
let previousTime = performance.now();
let hiddenAt = 0;

document.getElementById("start-button")?.addEventListener("click", async () => {
  await audio.unlock();
  started = true;
  simulation.start();
  hud.showGame();
});

document.getElementById("restart-button")?.addEventListener("click", () => window.location.reload());
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
    if (started) simulation.update(delta, input.getMovement(simulation.player));
    const events = simulation.drainEvents();
    for (const event of events) {
      audio.handle(event);
      hud.handle(event);
      if (event.type === "player-hit") renderer.impact(0.22);
      if (event.type === "wolf-hit") renderer.impact(0.09);
      if (event.type === "barrier-hit") renderer.impact(0.035);
      if (event.type === "game-over") input.cancelMoveTarget();
    }
    hud.update(delta);
    renderer.render(delta);
  }
  requestAnimationFrame(frame);
};

requestAnimationFrame(frame);
