import "./styles.css";
import { applyStaticText, detectLocale, setLocale, t } from "./i18n";
import { SynthAudio } from "./audio/SynthAudio";
import { createWorld, pickStartCamp } from "./game/content/createWorld";
import { InputController } from "./game/input/InputController";
import { GameSimulation } from "./game/simulation/GameSimulation";
import { GameRenderer } from "./render/GameRenderer";
import { FirstBarrelHint } from "./ui/FirstBarrelHint";
import { FuelPerkOverlay } from "./ui/FuelPerkOverlay";
import { HudController } from "./ui/HudController";
import { NightIntro } from "./ui/NightIntro";
import { shouldBreakBeforeRestart } from "./ui/RetentionPolicy";
import { bindShell } from "./ui/shell";
import { TutorialStage } from "./ui/TutorialStage";
import { bumpRunIndex, loadDifficulty, loadRunIndex } from "./ui/Settings";
import { createPlatform } from "./platform";
import { RunProgress } from "./platform/RunProgress";

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
  // 语言表按需下载，必须等它到位再建任何 UI —— HudController 的构造函数里就会取文案。
  await setLocale(detectLocale());
  applyStaticText();

  setProgress(0.5, t("boot.generating"));
  await nextPaint();

  /*
   * 首局用蓝图指定的营地，重开之后轮换到别的营地（连带换掉卡车落点）。
   * 见 createWorld.pickStartCamp —— 为什么首局不能动，那里写着。
   */
  let world = createWorld(undefined, pickStartCamp(loadRunIndex()));
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
  let simulation = new GameSimulation(world, difficulty);
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
  /*
   * 关键节点上报（Poki 后台的 Progress Events）。见 platform/RunProgress.ts ——
   * 那张表原先只有 SDK 自己报的 game/loading 一行，我们一个节点都没报过。
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

  /*
   * 关键节点上报（Poki 后台的 Progress Events）。见 platform/RunProgress.ts ——
   * 那张表原先只有 SDK 自己报的 game/loading 一行，我们一个节点都没报过。
   *
   * **构造放在这里，但一个字节都不往外发。**
   *
   * 构造要早：帧循环里每个事件都要过一次 runProgress.handle()，而帧循环的
   * requestAnimationFrame 排在 loadingFinished 之前。放到后面去赋值的话，
   * 只要有人往中间插一个 await，第一帧就会撞上 undefined，而且是每帧抛一次。
   *
   * 上报要晚：第一次 measure 挂在 enterGame()（玩家迈第一步）里，
   * **加载期我们一行都不跑** —— 那一段的去留 SDK 自己已经在计
   * （后台 game/loading 那一行的 Left 列）。理由见 enterGame 里那段。
   *
   * 所以这里剩下的只有一次对象分配：两个空 Set，没有 IO、没有 postMessage。
   */
  const runProgress = new RunProgress({
    // getter：软重启会换掉 simulation，这里读的必须是当前那一个。
    get simulation() { return simulation; },
    measure: (category, what, action) => platform.measure(category, what, action),
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
  /** 动物模型是否已到货。软重启建新 simulation 时要照着重新打开，见 softRestart。 */
  let wolvesReady = false;
  let crittersReady = false;
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
    /*
     * 进度节点从**玩家真的开始玩**才计，不在加载完那一刻计。
     *
     * 两个理由，第二个才是主要的：
     *
     * 1. 加载期不该跑我们的任何东西 —— 那一段的去留 SDK 自己已经在计
     *    （后台 game/loading 那一行的 Left 列），我们再插一脚只有坏处。
     *
     * 2. **口径**：加载完就报 fuel/1 start，等于把"打开页面看了一眼就走"的人
     *    算成"开始装第一桶然后放弃了"。那批人已经被 game/loading 记过一次，
     *    在这里再记一次就是双重计数，而且会让装车漏斗凭空显得更差。
     *    fuel/1 start 的语义应该是"这一局开始了"，而这一局从他迈第一步才开始。
     *
     * enterGame 有 started 闸，一局只会进来一次；软重启把 started 退回 false，
     * 所以新的一局自动再报一次 —— softRestart 里不用也不该再调 beginRun()。
     */
    runProgress.beginRun();
  };

  const input = new InputController({
    onGameplayIntent: enterGame,
    onAction: () => runGameplayAction(() => simulation.requestInteraction()),
    onAttack: () => runGameplayAction(() => simulation.requestAttack()),
    onThermal: () => runGameplayAction(() => simulation.requestThermalAction()),
    onInventory: () => hud.toggleInventory(),
    onPause: () => hud.togglePause(),
  });
  input.bindCanvas(renderer.canvas, (x, y) => renderer.screenToGround(x, y));
  // 卡车的屏幕边缘指示器要把世界坐标投到画布上，投影只有渲染层知道怎么做。
  hud.setProjector((x, z) => renderer.worldToScreen(x, z));

  /*
   * 开场**没有**教学了。
   *
   * 曾经有过一段四步门禁式教学（停表 + 幕布 + 字幕 + 逐步放行）。平台数据把它否掉了：
   * 11 场里 4 场活不过 6 秒 —— 那些人一个超时都没碰到，是被"开局先看一段演出"劝走的。
   *
   * 它教的东西并没有丢，只是换了载体：
   *   出生点 6.3~7.8 米就有猎物、6.5 米有枯木（GameSimulation 的 TUTORIAL_PREY_* /
   *   TUTORIAL_WOOD_*）—— "第一次命中 43.2 秒 → 0.6 秒"这个数字全部来自这里，
   *   和字幕无关：玩家学会挥刀能打死东西，是因为脚边真有东西
   *   四颗键上的键名角标（键鼠档）
   *   "现在按这颗有用"的搏动（HudController.syncHintPulse）—— 零摩擦、时机精准、
   *   用过一次就不再出现
   *
   * 于是第一帧就能玩，而这在这个平台上是硬道理。
   */
  // 第一夜教学要用这块 DOM（压暗、字幕、跳过）。
  const stage = new TutorialStage();

  /*
   * 第一夜教学。入夜那一刻自己接管，不需要在这里安排时机 —— 它监听 phase 事件。
   *
   * 同一道时钟闸：前两拍冻住世界（狼在第 0.45 秒就出巢，一边讲课一边挨咬
   * 只会变成一次不明不白的死亡），第三拍放开，因为那一拍要看的正是体温条往回涨。
   * 详见 ui/NightIntro.ts 的头注释。
   */
  const nightIntro = new NightIntro({
    // getter 而不是值：软重启会换掉 simulation，这里读的必须是当前那一个。
    get simulation() { return simulation; },
    stage,
    spotlight: (target) => renderer.spotlightOn(target),
    focusCamera: (target) => renderer.focusOn(target),
    setHold: (active) => simulation.setTutorialHold(active),
    setActionLabel: (hint) => hud.setActionOverride(hint),
    isTimerFrozen: () => hud.isGameplayBlocked() && !hud.isInventoryOpen(),
  });

  /* 玩家走离出生油桶仍未拿取时，短暂用场景聚光提醒；不停表、不夺镜头。 */
  const firstBarrelHint = new FirstBarrelHint({
    get simulation() { return simulation; },
    spotlight: (target) => renderer.spotlightOn(target),
  });
  firstBarrelHint.reset();

  /*
   * 搬油三选一的弹层。见 ui/FuelPerkOverlay.ts —— 它不持有奖励状态，
   * 每帧问模拟层"此刻有没有待选的三张"，有就开、被选掉就关。
   */
  const fuelPerkOverlay = new FuelPerkOverlay({
    get simulation() { return simulation; },
    cancelMoveTarget: () => input.cancelMoveTarget(),
  });

  if (import.meta.env.DEV) {
    /*
     * 把教学和渲染层也挂上调试句柄。
     *
     * 有它才能在控制台里手动步进整条链（update → drainEvents → 各 handle → 各 update），
     * 也才能验左击那条链：派一个 pointerdown，然后自己喂 input.getMovement 推帧，
     * 看人有没有走过去、到位有没有自动做那一次动作。
     * 而这正是验证第一夜教学的唯一办法：那段教学要等第一个白天走完才触发，
     * 而 rAF 在页面不可见时**一帧都不跑**，光靠改 phaseTime 是推不动的。
     */
    Object.assign((window as unknown as { game: Record<string, unknown> }).game, {
      renderer, nightIntro, input,
    });
  }
  // 点击移动走模拟层的流场，不走直线 —— 直线在这张有山脊的图上只有四成能走到。
  input.setRouter((target) => simulation.directionToClickTarget(target));
  // 左击点中东西时走到够得着再自动做一次；点空地仍然是纯移动。见 simulation/query/pickAt。
  input.setPicker((point, forward) => simulation.pickAt(point, forward));

  /*
   * 给平台报"在玩 / 没在玩"的唯一报点。
   *
   * HUD 每帧自查 isPlatformIdle()。它和 isGameplayBlocked() 的职责不同：
   * 背包会冻结模拟层，但玩家仍在挑选物品、合成或建造，不应给平台报停。
   */
  /*
   * 每次死亡都停在死亡页。
   * Poki 版同时提供“看广告原地复活”，并始终保留“再来一局”。
   *
   * 两条不能省的规矩：
   *   - `rewardedBreak()` 返回 false（没看完 / 加载失败 / 平台没有广告）**一次都不能给**；
   *   - 广告复活不设次数上限；第一、第二、第三……次死亡都继续给玩家选择。
   *
   * 平台不支持激励视频时（本地、GitHub Pages）按钮根本不出现，玩家看到的还是原来的结算页。
   */
  const offerRevive = (): void => {
    if (!platform.supportsRewarded) return;
    hud.showReviveOffer(() => {
      void (async () => {
        const watched = await platform.rewardedBreak();
        if (!watched) {
          // 没看完就什么都不发生：次数不扣，按钮放回去让他再试。
          offerRevive();
          return;
        }
        if (!simulation.revive()) return;
        hud.resumeAfterRevive();
        platform.gameplayStart();
      })();
    });
  };

  hud.onPlatformIdleChange((idle) => {
    if (idle) platform.gameplayStop();
    else if (started && simulation.running && !document.hidden) platform.gameplayStart();
  });

  /*
   * "再来一局"：软重启，不刷页。
   *
   * 平台录像显示长会话是**重开叠出来的**（有人 10 分钟开了 5、6 局），也就是说
   * 重开这条路每两分钟就要走一次。原先它走的是 window.location.reload()：
   * 重新解析主包、重下重解 646 KB 的 GLB、重建地形网格、重编译着色器，
   * 还有开场那几次 nextPaint() 的 150 ms 兜底 —— 全部重来一遍。
   *
   * 现在只重建**每局的东西**：world 和 simulation。渲染器、地形、人物模型、
   * 已编译的着色器、平台 SDK、音频上下文全部留着不动。
   * 谁需要收拾什么，各自写在 renderer.resetRun / hud.resetRun / nightIntro.reset 里。
   *
   * `started` 要退回 false：Poki 要求 gameplayStart 必须直接发生在玩家输入的调用栈里，
   * 所以新的一局同样要等他第一次真的动一下，跟刚打开页面时是同一条规矩。
   */
  /** 当前页面会话内的重开次数；第一次重开免插屏，第二次起仍交给 SDK 控频。 */
  let restartsThisSession = 0;
  const softRestart = async (button: HTMLElement | null): Promise<void> => {
    if (button instanceof HTMLButtonElement) button.disabled = true;
    const run = bumpRunIndex();
    restartsThisSession += 1;
    // 必须排在 beginRun() 之前：它收口的是**上一局**结算页开出来的那个节点。
    runProgress.noteRestart();
    if (shouldBreakBeforeRestart(restartsThisSession)) await platform.commercialBreak();

    world = createWorld(undefined, pickStartCamp(run));
    simulation = new GameSimulation(world, difficulty);
    // 动物模型是开场之后才下的。已经到货的要在新的一局里重新打开，
    // 否则重开之后整夜一只狗都不会来。
    if (wolvesReady) simulation.enableWolves();
    if (crittersReady) simulation.enableCritters();

    renderer.resetRun(world, simulation);
    hud.resetRun(simulation);
    nightIntro.reset();
    firstBarrelHint.reset();
    fuelPerkOverlay.close();
    input.cancelMoveTarget();
    started = false;
    previousTime = performance.now();

    if (import.meta.env.DEV) {
      Object.assign((window as unknown as { game: Record<string, unknown> }).game, { simulation, world });
    }
    if (button instanceof HTMLButtonElement) button.disabled = false;
  };


  bindShell({ hud, audio, platform, difficulty, softRestart });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = performance.now();
      // 切到后台就不算在玩了。不报的话平台统计里会出现"挂了一夜的一局"。
      platform.gameplayStop();
    } else {
      previousTime = performance.now();
      if (started && hiddenAt > 0) hud.showToast(t("hud.resumed"), 1.5);
      // 回到前台时与平台监听使用同一个谓词；即使背包开着也应恢复会话上报。
      if (started && simulation.running && !hud.isPlatformIdle()) platform.gameplayStart();
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
        nightIntro.handle(event);
        runProgress.handle(event);
        if (event.type === "player-hit") renderer.impact(0.22);
        if (event.type === "wolf-hit") renderer.impact(0.09);
        if (event.type === "fuel-loaded") renderer.fuelLoaded(event.loaded);
        if (event.type === "barrier-hit") {
          renderer.impact(0.035);
          renderer.barrierHit(event.itemId);
        }
        // 死亡和通关都强制收掉三选一，别让它盖在结算页上。
        if (event.type === "game-over" || event.type === "victory") fuelPerkOverlay.close();
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
      /*
       * 三选一：先问模拟层要不要开弹层，再把结果灌给 HUD 的冻结判据。
       * 排在 hud.update 之前 —— 同一帧内 isGameplayBlocked() 就该已经包含它，
       * 否则弹层开着的那一帧世界还会再走一步。
       */
      fuelPerkOverlay.update();
      hud.setFuelPerkOpen(fuelPerkOverlay.isOpen());
      hud.update(delta);
      /*
       * 「打开过背包没有」。
       *
       * 看状态翻转而不是挂在开关的调用点上 —— 背包有**两个入口**
       * （键盘 B/Tab 走 onInventory，HUD 那颗键在 HudController 里自己挂了监听），
       * 挂其中一个会漏掉另一个。notePackOpened 是幂等的，开着的每一帧调都行。
       */
      if (hud.isInventoryOpen()) runProgress.notePackOpened();
      // 与第一夜教学共用聚光灯；NightIntro 随后执行，入夜时由教学取得最终控制权。
      firstBarrelHint.update(delta);
      // 教学走在 HUD 之后：它要读背包的开合状态，也要按最新的一帧投影去挖亮洞。
      nightIntro.update(delta);
      renderer.render(delta);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  setProgress(1, t("boot.ready"));
  platform.loadingFinished();
  /*
   * gameInteractive 和 loadingFinished 不是一回事：后者说"资源到齐了"，
   * 前者说"玩家现在能动了"。我们中间还隔着 showGame()，所以分开报。
   */
  platform.gameInteractive();
  // 场景可以先展示，但 gameplayStart 与模拟层都必须等玩家第一次实际游戏输入。
  // HUD 已经提示“移动或拿起枯木，开始第一天”，无需重新加一层开始按钮。
  hud.showGame();
  // 先把可玩的第一帧交给浏览器，再在后台下载动物；它们不再占开场进度条。
  // 哪个模型先到就只启用哪类种群，未下载成功的动物不会生成。
  requestAnimationFrame(() => {
    renderer.loadDeferredAnimalAssets((kind) => {
      if (kind === "wolf") { wolvesReady = true; simulation.enableWolves(); }
      else { crittersReady = true; simulation.enableCritters(); }
    });
  });
}

void bootstrap().catch((error) => console.error("Bootstrap failed", error));
