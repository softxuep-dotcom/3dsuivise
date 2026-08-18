import "./styles.css";
import { applyStaticText, detectLocale, setLocale, t } from "./i18n";
import { SynthAudio } from "./audio/SynthAudio";
import { createWorld } from "./game/content/createWorld";
import { InputController } from "./game/input/InputController";
import { GameSimulation } from "./game/simulation/GameSimulation";
import { GameRenderer } from "./render/GameRenderer";
import { HudController } from "./ui/HudController";
import { NightIntro } from "./ui/NightIntro";
import { Tutorial } from "./ui/Tutorial";
import { TutorialStage } from "./ui/TutorialStage";
import { loadDifficulty, saveDifficulty } from "./ui/Settings";
import { normalizeDifficulty } from "./game/simulation/difficulty";
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
  // 难度只在这里读一次 —— 换档要重开页面，见 difficulty.ts 顶部那段。
  const difficulty = loadDifficulty();
  const simulation = new GameSimulation(world, difficulty);
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

  const hud = new HudController(simulation, difficulty);
  // 开场页要立刻显示上一局的高度，不能等到这一局结束才刷。
  hud.refreshRecordsLine();

  if (import.meta.env.DEV) {
    // 开发期调试句柄：用来在浏览器控制台里快进模拟、检查五轴状态。
    // 教学与渲染层稍后建好再补进来，见下方 attachDebugHandles。
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

  let started = false;
  let previousTime = performance.now();
  let hiddenAt = 0;

  /**
   * Poki 把第一次 gameplayStart 当作“玩家真的开始玩了”的转化点，必须直接发生在
   * 玩家输入的调用栈里，不能在加载完成或下一帧自动触发。InputController 只会在
   * 移动、点击地面、摇杆、攻击和场景行动这些真正的游戏输入上调用这里；开背包和
   * 暂停不算开始游戏。
   */
  const enterGame = (): void => {
    if (started || hud.isGameplayBlocked()) return;
    started = true;
    simulation.start();
    platform.gameplayStart();
  };

  const input = new InputController({
    onGameplayIntent: enterGame,
    onAction: () => runGameplayAction(() => simulation.requestInteraction()),
    onAttack: () => runGameplayAction(() => simulation.requestAttack()),
    onThermal: () => runGameplayAction(() => simulation.requestThermalAction()),
    onInventory: () => hud.toggleInventory(),
    onPause: () => hud.togglePause(),
  });
  input.bindCanvas(renderer.canvas, (x, y) => renderer.screenToWorld(x, y));
  // 卡车的屏幕边缘指示器要把世界坐标投到画布上，投影只有渲染层知道怎么做。
  hud.setProjector((x, z) => renderer.worldToScreen(x, z));

  /*
   * 开场教学。四个动词、一屏之内，详见 ui/Tutorial.ts 的头注释。
   *
   * 时钟闸在这里一开一关：教学期间 setTutorialHold(true)，五轴不掉、相位不走、
   * 狗不动。**必须挡**，因为教学第一步教的就是移动，而移动本身会点亮时钟 ——
   * 不挡的话，教学做得越完整，玩家在第一夜被咬死得越快。
   *
   * 放开的那一刻不主动开表，仍然等玩家的下一次移动（见 setTutorialHold 的注释）。
   */
  // 两段教学共用一块 DOM（压暗、亮洞、字幕、跳过），所以舞台只建一次。
  const stage = new TutorialStage();
  const tutorial = new Tutorial({
    simulation,
    stage,
    project: (x, z) => renderer.worldToScreen(x, z),
    isInventoryOpen: () => hud.isInventoryOpen(),
    // 广告和暂停要冻结教学计时；背包开着不算 —— 那正是最后一步要的状态。
    isTimerFrozen: () => hud.isGameplayBlocked() && !hud.isInventoryOpen(),
    onFinish: () => simulation.setTutorialHold(false),
  });
  if (Tutorial.shouldRun()) simulation.setTutorialHold(true);

  /*
   * 第一夜教学。入夜那一刻自己接管，不需要在这里安排时机 —— 它监听 phase 事件。
   *
   * 同一道时钟闸：前两拍冻住世界（狼在第 0.45 秒就出巢，一边讲课一边挨咬
   * 只会变成一次不明不白的死亡），第三拍放开，因为那一拍要看的正是体温条往回涨。
   * 详见 ui/NightIntro.ts 的头注释。
   */
  const nightIntro = new NightIntro({
    simulation,
    stage,
    project: (x, z) => renderer.worldToScreen(x, z),
    focusCamera: (target) => renderer.focusOn(target),
    setHold: (active) => simulation.setTutorialHold(active),
    setActionLabel: (hint) => hud.setActionOverride(hint),
    isStageBusy: () => tutorial.active,
    isTimerFrozen: () => hud.isGameplayBlocked() && !hud.isInventoryOpen(),
  });

  if (import.meta.env.DEV) {
    /*
     * 把教学和渲染层也挂上调试句柄。
     *
     * 有它才能在控制台里手动步进整条链（update → drainEvents → 各 handle → 各 update），
     * 而这正是验证第一夜教学的唯一办法：那段教学要等第一个白天走完才触发，
     * 而 rAF 在页面不可见时**一帧都不跑**，光靠改 phaseTime 是推不动的。
     */
    Object.assign((window as unknown as { game: Record<string, unknown> }).game, {
      renderer, tutorial, nightIntro,
    });
  }
  // 点击移动走模拟层的流场，不走直线 —— 直线在这张有山脊的图上只有四成能走到。
  input.setRouter((target) => simulation.directionToClickTarget(target));

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
  // 齿轮即暂停键：底排腾出来只放四个操作键，而暂停控件仍然看得见、点得到。
  document.getElementById("settings-button")?.addEventListener("click", () => hud.togglePause());
  document.getElementById("pause-resume")?.addEventListener("click", () => hud.setPaused(false));

  /*
   * 难度：点一下就存下来（下次自然重开即生效），同时亮出"重开一局"。
   * 不做热切换 —— 狼的数值是生成时算的，跑到一半换档只会让新旧狼混在同一夜里。
   */
  const difficultyRestart = document.getElementById("difficulty-restart");
  for (const option of document.querySelectorAll<HTMLButtonElement>("#difficulty-options [data-difficulty]")) {
    option.addEventListener("click", () => {
      const picked = normalizeDifficulty(option.dataset.difficulty);
      saveDifficulty(picked);
      hud.setDifficultySelection(picked);
      difficultyRestart?.classList.toggle("hidden", picked === difficulty);
    });
  }
  difficultyRestart?.addEventListener("click", () => { void restartWithBreak(difficultyRestart); });
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
        tutorial.handle(event);
        nightIntro.handle(event);
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
      audio.update(
        simulation.player,
        simulation.camps,
        world.camps,
        started && simulation.running && !hud.isGameplayBlocked(),
      );
      hud.update(delta);
      // 教学走在 HUD 之后：它要读背包的开合状态，也要按最新的一帧投影去挖亮洞。
      tutorial.update(delta);
      nightIntro.update(delta);
      renderer.render(delta);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  setProgress(1, t("boot.ready"));
  platform.loadingFinished();
  // 场景可以先展示，但 gameplayStart 与模拟层都必须等玩家第一次实际游戏输入。
  // HUD 已经提示“移动或拿起枯木，开始第一天”，无需重新加一层开始按钮。
  hud.showGame();
  if (Tutorial.shouldRun()) tutorial.start();
  // 先把可玩的第一帧交给浏览器，再在后台下载动物；它们不再占开场进度条。
  // 哪个模型先到就只启用哪类种群，未下载成功的动物不会生成。
  requestAnimationFrame(() => {
    renderer.loadDeferredAnimalAssets((kind) => {
      if (kind === "wolf") simulation.enableWolves();
      else simulation.enableCritters();
    });
  });
}

void bootstrap().catch((error) => console.error("Bootstrap failed", error));
