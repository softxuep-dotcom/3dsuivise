import "./styles.css";
import { applyStaticText, detectLocale, setLocale, t } from "./i18n";
import { SynthAudio } from "./audio/SynthAudio";
import { createWorld } from "./game/content/createWorld";
import { InputController } from "./game/input/InputController";
import { GameSimulation } from "./game/simulation/GameSimulation";
import { GameRenderer } from "./render/GameRenderer";
import { HudController } from "./ui/HudController";
import { createPlatform } from "./platform";

/**
 * index.html 内联脚本留下的引导桥，见那段注释。
 * 它在主包到达之前就点亮了进度条，并在第一次用户手势里建好 AudioContext。
 */
interface BootBridge {
  audioContext: AudioContext | null;
  moduleAttached: boolean;
  ratio: number;
  set: (ratio: number, label: string | null) => void;
}

const boot = (window as unknown as { __boot?: BootBridge }).__boot;
const setProgress = (ratio: number, label: string | null = null): void => boot?.set(ratio, label);

/**
 * 让出两帧，进度条才真的会重绘。
 * 少了这一步，整段初始化跑在同一个宏任务里，条子从 0 直接跳到 100 —— 等于没有。
 *
 * 带超时兜底：页面切到后台时 rAF **完全不触发**，只等它会把开场流程永久卡死 ——
 * 玩家开着页面顺手切个应用回来，就再也进不去了。
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
if (boot) boot.moduleAttached = true;

async function bootstrap(): Promise<void> {
  // 语言要在任何 UI 构建之前定下来：HudController 的构造函数里就会取文案。
  // 开场页是 index.html 里写死的英文，这一步按检测结果把它重填成玩家的语言。
  setLocale(detectLocale());
  applyStaticText();

  setProgress(0.5, t("boot.generating"));
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
  /*
   * 音频只能在用户手势里解锁（iOS 上手势外建出来的 AudioContext 一律 suspended，
   * 事后 resume 也救不回来）。开场按钮撤掉之后没有那次点击了，改挂在第一次任何手势上 ——
   * 进场后第一件必须做的事就是移动，那一下就是手势。
   *
   * index.html 的内联桥在同一次手势里（注册得更早的捕获监听）把 AudioContext 建好，
   * 这里 adopt 过来再 resume；那次手势若发生在本对象构造之前，构造函数就已经拿到了。
   */
  const unlockAudio = (): void => {
    document.removeEventListener("pointerdown", unlockAudio, true);
    document.removeEventListener("keydown", unlockAudio, true);
    audio.adopt(boot?.audioContext ?? null);
    void audio.unlock().catch(() => { /* 没声音也照样能玩 */ });
  };
  document.addEventListener("pointerdown", unlockAudio, true);
  document.addEventListener("keydown", unlockAudio, true);

  const hud = new HudController(simulation);
  // 开场页要立刻显示上一局的高度，不能等到这一局结束才刷。
  hud.refreshRecordsLine();

  if (import.meta.env.DEV) {
    // 开发期调试句柄：用来在浏览器控制台里快进模拟、检查五轴状态。
    (window as unknown as { game: unknown }).game = { simulation, world, hud };
  }

  /*
   * 平台 SDK 在这里握手，排在**重资源之前**：Poki 要求 gameLoadingFinished()
   * 报的是"玩家可以开玩了"，那就得先有个 SDK 可报。
   *
   * createPlatform() 永远 resolve —— 拿不到 SDK 就退回 NullPlatform。
   * 广告钩子把静音和输入冻结绑在一起：广告一开始，声音压掉、模拟层停住，
   * 玩家不会在看广告的时候被狗咬死。
   */
  const platform = await createPlatform({
    onAdStart: () => {
      audio.setAdMuted(true);
      hud.setAdPlaying(true);
    },
    onAdEnd: () => {
      audio.setAdMuted(false);
      hud.setAdPlaying(false);
    },
  });
  if (import.meta.env.DEV) console.info(`[platform] ${platform.name}`);

  setProgress(0.58, t("boot.terrain"));
  await nextPaint();

  let renderer: GameRenderer;
  try {
    // 人物资源占进度条最后的 25% —— 四个 GLB 加起来 646 KB，比其余所有东西都大。
    renderer = new GameRenderer(renderRoot!, world, simulation, (loaded, total) => {
      setProgress(0.75 + (loaded / total) * 0.25, t("boot.survivorProgress", { loaded, total }));
    });
  } catch (error) {
    console.error(error);
    document.getElementById("unsupported")?.classList.remove("hidden");
    throw error;
  }

  setProgress(0.7, t("boot.lighting"));
  await nextPaint();
  // 着色器是第一次 render 时才编译的，手机上这一下能卡好几百毫秒。
  // 先在进度条后面把它跑掉，进场那一刻就不会再顿一次。
  renderer.render(0);

  setProgress(0.75, t("boot.survivor"));
  await nextPaint();
  await renderer.whenPlayerAssetReady();

  const runGameplayAction = (action: () => void): void => {
    if (!hud.isGameplayBlocked()) action();
  };

  const input = new InputController({
    onAction: () => runGameplayAction(() => simulation.requestInteraction()),
    onAttack: () => runGameplayAction(() => simulation.requestAttack()),
    onThermal: () => runGameplayAction(() => simulation.requestThermalAction()),
    onInventory: () => hud.toggleInventory(),
    onPause: () => hud.togglePause(),
  });
  input.bindCanvas(renderer.canvas, (x, y) => renderer.screenToWorld(x, y));

  let started = false;
  let previousTime = performance.now();
  let hiddenAt = 0;

  /*
   * "可玩 / 不可玩"的唯一报点。
   *
   * HUD 每帧自查 isGameplayBlocked()（开背包会暂停模拟层、广告期间会冻结），
   * 翻转时回调到这里。所有暂停路径因此只有这一处要维护 ——
   * 以后再加什么会暂停游戏的 UI，平台信号自动跟着对。
   */
  /*
   * 死后续命：看一次激励视频原地复活，一局三次。
   *
   * 两条不能省的规矩：
   *   - `rewardedBreak()` 返回 false（没看完 / 加载失败 / 平台没有广告）**一次都不能给**；
   *   - 次数在这里扣而不是在 HUD 里扣 —— 广告没播成不该消耗次数。
   *
   * 平台不支持激励视频时（本地、GitHub Pages）按钮根本不出现，玩家看到的还是原来的结算页。
   */
  let revivesLeft = 3;
  const offerRevive = (): void => {
    if (!platform.supportsRewarded || revivesLeft <= 0) return;
    hud.showReviveOffer(revivesLeft, () => {
      void (async () => {
        const watched = await platform.rewardedBreak();
        if (!watched) {
          // 没看完就什么都不发生：次数不扣，按钮放回去让他再试。
          offerRevive();
          return;
        }
        if (!simulation.revive()) return;
        revivesLeft -= 1;
        hud.resumeAfterRevive();
        platform.gameplayStart();
      })();
    });
  };

  hud.onGameplayBlockedChange((blocked) => {
    if (blocked) platform.gameplayStop();
    else if (started && simulation.running && !document.hidden) platform.gameplayStart();
  });

  // 音频不在这里解锁：进场已经不由用户手势触发，此刻 resume 必然被浏览器拒掉。
  // 交给上面的 unlockAudio。
  const enterGame = (): void => {
    if (started) return;
    started = true;
    simulation.start();
    hud.showGame();
    platform.gameplayStart();
  };

  /*
   * 重开前插一次插屏广告。
   *
   * 时机是**点了"再来一局"之后**而不是死亡的那一刻 —— 这是平台反复强调的：
   * 广告要放在玩家已经表达"我要继续"的自然断点上。放不放由平台自己决定。
   *
   * 按钮点完立刻置灰，否则连点两下会叠两次广告请求。
   */
  const restartWithBreak = async (button: HTMLElement | null): Promise<void> => {
    if (button instanceof HTMLButtonElement) button.disabled = true;
    await platform.commercialBreak();
    window.location.reload();
  };
  for (const id of ["restart-button", "victory-restart-button"]) {
    const button = document.getElementById(id);
    button?.addEventListener("click", () => { void restartWithBreak(button); });
  }
  document.getElementById("pause-button")?.addEventListener("click", () => hud.togglePause());
  document.getElementById("pause-resume")?.addEventListener("click", () => hud.setPaused(false));
  document.getElementById("sound-button")?.addEventListener("click", async () => {
    await audio.unlock().catch(() => { /* 同上 */ });
    const enabled = audio.toggle();
    const button = document.getElementById("sound-button");
    const state = document.getElementById("sound-state");
    if (state) state.textContent = t(enabled ? "sound.on" : "sound.off");
    button?.setAttribute("aria-pressed", String(enabled));
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = performance.now();
      // 切到后台就不算在玩了。不报的话平台统计里会出现"挂了一夜的一局"。
      platform.gameplayStop();
    } else {
      previousTime = performance.now();
      if (started && hiddenAt > 0) hud.showToast(t("hud.resumed"), 1.5);
      if (started && simulation.running && !hud.isGameplayBlocked()) platform.gameplayStart();
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
        // 结算页不算在玩。这一对信号报得越准，平台越不会把广告插在
        // 玩家正被狗围着的时候。
        if (event.type === "game-over" || event.type === "victory") platform.gameplayStop();
        if (event.type === "game-over") offerRevive();
      }
      hud.update(delta);
      renderer.render(delta);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  setProgress(1, t("boot.ready"));
  platform.loadingFinished();
  // 加载完直接进场，不再等一次点击。
  // 生存时钟不会因此空转 —— 它等玩家第一次移动才起跑（GameSimulation.clockStarted）。
  enterGame();
}

void bootstrap().catch((error) => console.error("Bootstrap failed", error));
