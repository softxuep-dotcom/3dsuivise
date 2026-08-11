import "./styles.css";
import { SynthAudio } from "./audio/SynthAudio";
import { createWorld } from "./game/content/createWorld";
import { InputController } from "./game/input/InputController";
import { GameSimulation } from "./game/simulation/GameSimulation";
import { GameRenderer } from "./render/GameRenderer";
import { HudController } from "./ui/HudController";

/**
 * index.html 内联脚本留下的引导桥，见那段注释。
 * 它在主包到达之前就接住了"踏入沙海"的点击，并在用户手势里建好了 AudioContext。
 */
interface BootBridge {
  requested: boolean;
  audioContext: AudioContext | null;
  moduleAttached: boolean;
  ratio: number;
  onRequest: (() => void) | null;
  set: (ratio: number, label: string | null) => void;
}

const boot = (window as unknown as { __boot?: BootBridge }).__boot;
const setProgress = (ratio: number, label: string | null = null): void => boot?.set(ratio, label);

/**
 * 让出两帧，进度条才真的会重绘。
 * 少了这一步，整段初始化跑在同一个宏任务里，条子从 0 直接跳到 100 —— 等于没有。
 *
 * 带超时兜底：页面切到后台时 rAF **完全不触发**，只等它会把开场流程永久卡死 ——
 * 玩家点完"踏入沙海"顺手切个应用回来，就再也进不去了。
 */
const nextPaint = (): Promise<void> => new Promise((resolve) => {
  let settled = false;
  const done = (): void => {
    if (settled) return;
    settled = true;
    resolve();
  };
  const timer = window.setTimeout(done, 150);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.clearTimeout(timer);
    done();
  }));
});

const renderRoot = document.getElementById("render-root");
if (!renderRoot) throw new Error("Missing render root");

// 主包到了，停掉内联脚本那条渐近假进度，后面全是真实进度。
let startRequested = boot?.requested ?? false;
if (boot) {
  boot.moduleAttached = true;
  boot.onRequest = () => { startRequested = true; };
}

async function bootstrap(): Promise<void> {
  setProgress(0.5, "生成沙海…");
  await nextPaint();

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
  const audio = new SynthAudio(boot?.audioContext ?? null);
  const hud = new HudController(simulation);
  // 重开是整页刷新，所以开场页每次都会重新读一次记录。
  hud.refreshRecordsLine();

  if (import.meta.env.DEV) {
    // 开发期调试句柄：用来在浏览器控制台里快进模拟、检查五轴状态。
    (window as unknown as { game: unknown }).game = { simulation, world, hud };
  }

  setProgress(0.58, "堆起地形…");
  await nextPaint();

  let renderer: GameRenderer;
  try {
    // 人物资源占进度条最后的 25% —— 四个 GLB 加起来 646 KB，比其余所有东西都大。
    renderer = new GameRenderer(renderRoot!, world, simulation, (loaded, total) => {
      setProgress(0.75 + (loaded / total) * 0.25, `载入人物 ${loaded}/${total}…`);
    });
  } catch (error) {
    console.error(error);
    document.getElementById("unsupported")?.classList.remove("hidden");
    throw error;
  }

  setProgress(0.7, "点亮光照…");
  await nextPaint();
  // 着色器是第一次 render 时才编译的，手机上这一下能卡好几百毫秒。
  // 先在进度条后面把它跑掉，进场那一刻就不会再顿一次。
  renderer.render(0);

  setProgress(0.75, "载入人物…");
  await nextPaint();
  await renderer.whenPlayerAssetReady();

  const runGameplayAction = (action: () => void): void => {
    if (!hud.isGameplayBlocked()) action();
  };

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

  const enterGame = (): void => {
    if (started) return;
    started = true;
    void audio.unlock().catch(() => { /* 没声音也照样能玩 */ });
    simulation.start();
    hud.showGame();
  };

  document.getElementById("restart-button")?.addEventListener("click", () => window.location.reload());
  document.getElementById("victory-restart-button")?.addEventListener("click", () => window.location.reload());
  document.getElementById("sound-button")?.addEventListener("click", async () => {
    await audio.unlock().catch(() => { /* 同上 */ });
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

  setProgress(1, "准备好了");
  // 加载期间点过"踏入沙海"就直接进场，不让玩家为同一件事点第二次；
  // 还没点过就把按钮接上，这时点下去是秒进。
  if (startRequested) enterGame();
  else if (boot) boot.onRequest = enterGame;
  else document.getElementById("start-button")?.addEventListener("click", enterGame);
}

void bootstrap().catch((error) => console.error("开场初始化失败", error));
