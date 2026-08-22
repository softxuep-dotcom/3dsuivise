import type { EquipTier, GameSimulation } from "../game/simulation/GameSimulation";
import { COOKED_HEALTH } from "../game/simulation/GameSimulation";
import { t, tx } from "../i18n";
import { clamp } from "../game/simulation/geometry";
import { describeRecords, formatDuration, loadRecords, submitRun } from "./Records";
import type { Difficulty } from "../game/simulation/difficulty";
import { DEFAULT_DIFFICULTY, DIFFICULTIES } from "../game/simulation/difficulty";
import { FUEL_REQUIRED, STRUCTURE_SPECS } from "../game/simulation/types";
import { itemIcon } from "./ItemIcons";
import type {
  DeathCause,
  GameEvent,
  InteractionHint,
  InventoryItemKind,
  StructureKind,
} from "../game/simulation/types";

const DEATH_CAUSE_KEYS: Record<DeathCause, string> = {
  dehydrated: "death.cause.dehydrated",
  starved: "death.cause.starved",
  killed: "death.cause.killed",
  exhausted: "death.cause.exhausted",
};

const DEATH_ADVICE_KEYS: Record<DeathCause, string> = {
  dehydrated: "death.advice.dehydrated",
  starved: "death.advice.starved",
  killed: "death.advice.killed",
  exhausted: "death.advice.exhausted",
};

const required = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};

/** 行动键熄灭前的余量拍数。HUD 每 0.08 秒走一拍，三拍 ≈ 0.24 秒。见 syncActionArmed。 */
const ARMED_GRACE_TICKS = 3;

/*
 * toast 的三档轻重。数字大的能顶掉数字小的，见 showToast。
 *
 * 分档挂在**事件类型**上而不是文案里：模拟层四十多处 events.push 都不带轻重，
 * 给它们逐个加一个字段是另一笔账，而"这句话有多急"本来就是表现层的判断。
 */
const TOAST_CASUAL = 0;   // 拾取、猎杀：说的是"刚才那下成了"，错过不影响任何决策
const TOAST_NORMAL = 1;   // 模拟层的 message：指令和警告的主力
const TOAST_CRITICAL = 2; // 昼夜切换、卡车发车：错过等于错过一整个相位
/** 两条之间的空白。没有它，换一条只看得出"字变长了"，看不出是新的一句。 */
const TOAST_GAP = 0.14;
/** 被顶掉的那条排回队首时至少还能再说这么久，免得闪一下就没。 */
const TOAST_MIN_SECONDS = 0.9;
/** 排队超过这么久的普通提示直接作废 —— 场上早就不是那回事了。 */
const TOAST_STALE_SECONDS = 6;

const ACTION_ICON: Record<InteractionHint["action"], string> = {
  pickup: "pickup",
  drop: "drop",
  ignite: "ignite",
  feed: "feed",
  cactus: "juice",
  mine: "mine",
  // 砍树暂时借用通用图标 —— 图集里没有斧头，而拿"采矿"（镐）去指一棵树更容易读错。
  // 图集补上斧头之后把这里换掉即可，别的都不用动。
  chop: "action",
  well: "water",
  load: "load",
  board: "drive",
  none: "action",
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

const itemName = (kind: InventoryItemKind): string => t(`item.${kind}.name`);

export class HudController {
  /** 软重启会换掉这个引用，见 resetRun()。构造函数绑的那几个监听读的都是 this.simulation，跟着换。 */
  private simulation: GameSimulation;
  private readonly hud = required<HTMLElement>("hud");
  private readonly intro = required<HTMLElement>("intro");
  private readonly gameOver = required<HTMLElement>("game-over");
  private readonly victory = required<HTMLElement>("victory");
  private readonly inventoryOverlay = required<HTMLElement>("inventory-overlay");
  private readonly truckPointer = required<HTMLElement>("truck-pointer");
  private readonly truckArrow = required<HTMLElement>("truck-arrow");
  /** 由 main.ts 注入：世界坐标 → 画布 CSS 像素。没有渲染层时保持 null，指示器整个不显示。 */
  private projectToScreen: ((x: number, z: number) => { x: number; y: number; behind: boolean }) | null = null;
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
  /** 五条轴里会被吃喝改动的那四条，用来把 +N / −N 飘在正确的那一条上。 */
  private readonly nourishMeters: Array<["health" | "water" | "hunger" | "warmth", HTMLElement]> = [
    ["health", required<HTMLElement>("meter-health")],
    ["water", required<HTMLElement>("meter-water")],
    ["hunger", required<HTMLElement>("meter-hunger")],
    ["warmth", required<HTMLElement>("warmth-meter")],
  ];
  private readonly attackButton = required<HTMLButtonElement>("attack-button");
  private readonly actionButton = required<HTMLButtonElement>("action-button");
  /*
   * "这颗键现在按有用" 的搏动提示，替掉了原来那段门禁式的开场教学。
   *
   * 为什么不是教学：教学是一道关 —— 它停表、盖幕布、按固定脚本走，而平台数据里
   * 11 场有 4 场活不过 6 秒，那些人一个超时都没碰到就走了。搏动没有这些代价：
   * 第一帧就能玩，提示只在"现在按有用"的那一刻出现，用过一次就再也不出现。
   *
   * 两颗键的处境本来就不一样：
   *   行动键  走近可交互物时**已经**会换图标（拿起/添柴/点燃…）并冒出提示文字，
   *           缺的只是让人往那儿瞟一眼
   *   攻击键  从头到尾一个样 —— 眼前有没有东西它都不变。这才是真正的缺口
   *
   * 只记在这一局里，不写 localStorage：它本来就在玩家第一次打中 / 第一次拾取后
   * 立刻停掉（通常几秒内），为它加一个存储键换来的是一个"没显示"却极难查的失败模式。
   */
  private attackHintUsed = false;
  private actionHintUsed = false;
  /** 行动键"亮着"还能维持几拍。见 syncActionArmed。 */
  private armedGrace = 0;
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
  private readonly thermalIcon = required<HTMLElement>("thermal-icon");
  private readonly thermalState = required<HTMLElement>("thermal-state");

  /**
   * 体温调节按钮：一个键管两个方向，所以它必须自己说清楚现在按下去会发生什么，
   * 以及还要等多久 —— 否则玩家分不清"按了没反应"和"在冷却中"。
   */
  private syncThermalButton(warmth: number): void {
    const hot = warmth > 62;
    const cold = warmth < 35;
    const cooldown = hot ? this.simulation.coolCooldown : this.simulation.warmCooldown;
    this.thermalIcon.dataset.icon = hot || (!cold && warmth >= 50) ? "cool" : "warm";
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
  private readonly objectiveChip = required<HTMLElement>("objective-chip");
  private readonly phaseLabel = required<HTMLElement>("phase-label");
  /** 顶沿相位条。见 index.html 里那段：它和时钟同源，但编码不同。 */
  private readonly phaseBar = required<HTMLElement>("phase-bar");
  private readonly phaseFill = required<HTMLElement>("phase-fill");
  private readonly timeLabel = required<HTMLElement>("time-label");
  private readonly clock = required<HTMLElement>("clock");
  private readonly prompt = required<HTMLElement>("prompt");
  private readonly restIndicator = required<HTMLElement>("rest-indicator");
  private readonly actionIcon = required<HTMLElement>("action-icon");
  private readonly actionLabel = required<HTMLElement>("action-label");
  private readonly recordsLine = required<HTMLElement>("records-line");
  private readonly toast = required<HTMLElement>("toast");
  private readonly deathCause = required<HTMLElement>("death-cause");
  private readonly deathDetail = required<HTMLElement>("death-detail");
  private readonly deathAdvice = required<HTMLElement>("death-advice");
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
  /**
   * 临时顶掉"行动"键上的图标与文字。第一夜教学在"点火"那一拍用它。
   *
   * 为什么需要：那一拍要玩家做的事是**点燃篝火**，而按键上写的是通用的"行动" ——
   * 只有走进火塘 10 米内、且脚边没有别的东西时，getInteractionHint 才会自己
   * 变成"点燃"。也就是说，教学正在指着一颗还没写上答案的键。
   *
   * 顶掉的只是**显示**，按下去做什么完全没变（仍然是 requestInteraction）：
   * 人还没走到火边时按它照旧不发生任何事，而那一拍的字幕说的正是"走到火塘边"。
   */
  private actionOverride: InteractionHint | null = null;
  private toastTimer = 0;
  /** 正在显示的那条有多急；-1 = 没有在显示。 */
  private toastPriority = -1;
  /** 上一条说完之后的空白余量（秒）。 */
  private toastGap = 0;
  /** 只用来算"排了多久"的单调秒表，随 update 走，暂停时自然停住。 */
  private toastClock = 0;
  private readonly toastQueue: { text: string; seconds: number; priority: number; queuedAt: number }[] = [];
  private lastHudUpdate = 0;
  private inventoryOpen = false;
  private adPlaying = false;
  private paused = false;
  private readonly pauseOverlay = required<HTMLElement>("pause-overlay");
  private readonly reviveButton = required<HTMLButtonElement>("revive-button");
  private lastPlatformIdle = false;
  private platformIdleListener: ((idle: boolean) => void) | null = null;

  /** 本局实际在跑的难度 —— 软重开选档时会与 simulation 一起更新。 */
  private difficulty: Difficulty;
  private readonly victoryProgressionCopy = required<HTMLElement>("victory-progression-copy");
  private readonly victoryChoices = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-victory-difficulty]"),
  ];
  /** 设置面板里当前高亮的那一档，可能已经和 difficulty 不同（选了但还没重开）。 */
  private difficultySelection: Difficulty;

  constructor(simulation: GameSimulation, difficulty: Difficulty = DEFAULT_DIFFICULTY) {
    this.simulation = simulation;
    this.difficulty = difficulty;
    this.difficultySelection = difficulty;
    this.setDifficultySelection(difficulty);
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

  /**
   * 软重启：换掉模拟层，收掉上一局留在屏幕上的东西。
   *
   * 不新建 HudController —— 构造函数往背包格、背包按钮、关闭键、建造键、烤肉键上
   * 绑了固定监听，每重开一次就会再叠一层。换引用是安全的：那些闭包读的都是
   * `this.simulation`。
   */
  resetRun(simulation: GameSimulation, difficulty: Difficulty = this.difficulty): void {
    this.simulation = simulation;
    this.difficulty = difficulty;
    this.setDifficultySelection(difficulty);
    this.lastGameOver = null;
    this.hideReviveOffer();
    this.gameOver.classList.add("hidden");
    this.victory.classList.add("hidden");
    this.closeInventory();
    this.setPaused(false);
    this.toast.classList.add("hidden");
    this.toastTimer = 0;
    this.toastGap = 0;
    this.toastPriority = -1;
    this.toastQueue.length = 0;
    this.objectiveChip.classList.remove("muted");
    this.huntProgress.classList.remove("fuel-loaded");
    // 两个搏动提示本来就是"每局第一次"的口径（见字段上的注释，它们不写 localStorage）,
    // 所以新的一局要放回来。
    this.attackHintUsed = false;
    this.actionHintUsed = false;
    this.armedGrace = 0;
    this.refreshRecordsLine();
  }

  showGame(): void {
    this.intro.classList.add("hidden");
    this.hud.classList.remove("hidden");
  }

  /** 订阅"平台眼里在不在玩"的翻转。平台适配层拿它报 gameplayStart / gameplayStop。 */
  onPlatformIdleChange(listener: (idle: boolean) => void): void {
    this.platformIdleListener = listener;
  }

  /**
   * **模拟层冻不冻结。** 开背包也算 —— 背包是真的把世界停住（见 main.ts 里
   * `simulation.update` 那个 if），实测开着的两秒半里相位、狼、五轴一个数都不变。
   */
  isGameplayBlocked(): boolean {
    return this.inventoryOpen || this.adPlaying || this.paused;
  }

  /**
   * **平台眼里算不算"没在玩"。** 和 isGameplayBlocked 差一个 inventoryOpen。
   *
   * 两者曾经是同一个谓词，于是**每开一次背包就给 Poki 报一次 gameplayStop + Start**——
   * 平台那边把一局切成两段。而背包是吃饭、烤肉、合成、建造的唯一入口，一局要开很多次：
   * playtest 里一个真玩了 3:33 的德国玩家被记成 3 段，一段平均 71 秒。
   *
   * 分开的理由是这两件事问的**不是同一个问题**：
   *   isGameplayBlocked  —— 世界该不该继续走？开背包时不该（那是公平性选择，
   *                          免得"打斗中来不及开背包"）。
   *   isPlatformIdle     —— 玩家人还在不在？开背包时**在** —— 他正在挑吃什么、造什么，
   *                          手没离开屏幕。而广告和显式暂停（齿轮 / ESC）是真的离开了。
   *
   * 留个尾巴：Poki 过审时可能会问"游戏暂停了为什么不报停"。答案是这游戏另有一个独立的
   * 暂停控件（齿轮键，见 index.html），背包不是暂停菜单。
   */
  isPlatformIdle(): boolean {
    return this.adPlaying || this.paused;
  }

  /**
   * 背包这一刻是不是开着。
   *
   * 教学第四步的完成判定要的就是这一条，而 isGameplayBlocked() 不够用 ——
   * 它把广告和暂停也算进去，教学会被一次广告误判成"玩家学会开背包了"。
   */
  isInventoryOpen(): boolean {
    return this.inventoryOpen;
  }

  /**
   * 暂停 / 继续。Poki 的 Requirements 第 15 条要求键盘游戏提供 ESC 或空格
   * 的暂停恢复，而我们的空格已经是攻击键，所以只能是 ESC；手机上没有 ESC，
   * 另配了一个 HUD 按钮。
   *
   * 死了或通关之后不让暂停 —— 那时候屏幕上已经有结算页，再叠一层暂停是纯噪音。
   */
  togglePause(): void {
    // 背包开着的时候 ESC 是"关背包"，不是"再叠一层暂停" —— ESC 关掉最上面那层
    // 是所有游戏的通用预期，而且背包本来就已经把游戏停住了。
    if (this.inventoryOpen) {
      this.closeInventory();
      return;
    }
    this.setPaused(!this.paused);
  }

  setPaused(paused: boolean): void {
    if (paused && (!this.simulation.running || this.inventoryOpen)) return;
    this.paused = paused;
    this.pauseOverlay.classList.toggle("hidden", !paused);
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * 广告播放期间冻结游戏。
   *
   * 和"开背包暂停"走同一个闸：模拟层这段时间完全不推进，
   * 所以玩家不会在看广告的时候被狗咬死 —— 那是投诉率最高的一类体验。
   */
  setAdPlaying(playing: boolean): void {
    this.adPlaying = playing;
  }

  /** 教学期间临时改写"行动"键的显示；传 null 还原。见 actionOverride。 */
  setActionOverride(hint: InteractionHint | null): void {
    this.actionOverride = hint;
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

  /** 渲染层就绪后把投影函数交进来。 */
  setProjector(project: (x: number, z: number) => { x: number; y: number; behind: boolean }): void {
    this.projectToScreen = project;
  }

  /**
   * 卡车的屏幕边缘指示器。
   *
   * 卡车是全局唯一的通关物，跑开之后就再没有任何东西指回来 —— 目标行会报方位，
   * 但那是文字，第一次玩的人不会去读。曾经试过在车上插一道 26 米的光柱，
   * 又丑又挡视野；标记就不该待在世界里。
   *
   * 规则：车在画面内 → 不显示（看得见就不用指）；在画面外 → 贴着视口边缘，
   * 箭头指向车，底下报距离。相机背后要把投影坐标翻转，否则箭头会指反。
   */
  /**
   * 把边缘指示器从 HUD 面板上挪开。
   *
   * 指示器是沿视口内缘的矩形滑的，而那圈矩形正好从右下四颗键、右上状态条、
   * 左上目标条和摇杆身上压过去 —— 卡车在右后方时，那枚 44px 的圆牌就直接盖在
   * "行动"键上。盖住一颗**要按的键**比指错方向更糟。
   *
   * 做法是沿位移最小的那条边把它推出面板。位置由此不再严格落在那圈矩形上，
   * 但方向是箭头在说的，圆牌只要还在同一侧就不会误导。
   *
   * **候选方向要先过一遍"推出去还在不在屏幕里"**，这是这段唯一的坑：
   * 右下角那一格，"往右推"永远是位移最小的选项（只要 50px），但推完就出了右边界，
   * 夹回来又原地不动 —— 于是死循环般地停在按钮上。实测三个角全中。
   * 所以先筛掉越界的方向，再在剩下的里取最近的。
   *
   * 面板矩形每帧现读 getBoundingClientRect：布局会随语言、横竖屏、安全区变，
   * 写死坐标撑不过一次改版。
   */
  private keepClearOfPanels(x: number, y: number, margin: number): { x: number; y: number } {
    // 圆牌 44px + 下面那枚距离标签，半个盒子约 33px；再留一点呼吸。
    const radius = 36;
    const minX = margin;
    const maxX = window.innerWidth - margin;
    const minY = margin;
    const maxY = window.innerHeight - margin;
    const blockers: DOMRect[] = [];
    for (const selector of [".bottom-right", ".status-strip", ".left-stack", "#joystick"]) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) blockers.push(rect);
    }
    let px = clamp(x, minX, maxX);
    let py = clamp(y, minY, maxY);
    // 推开一块可能撞上另一块（右下角那两组按钮是挨着的），所以跑几轮。
    for (let pass = 0; pass < 4; pass += 1) {
      let moved = false;
      for (const rect of blockers) {
        if (px + radius <= rect.left || px - radius >= rect.right) continue;
        if (py + radius <= rect.top || py - radius >= rect.bottom) continue;
        const candidates = [
          { cost: py + radius - rect.top, x: px, y: rect.top - radius },
          { cost: rect.bottom - (py - radius), x: px, y: rect.bottom + radius },
          { cost: px + radius - rect.left, x: rect.left - radius, y: py },
          { cost: rect.right - (px - radius), x: rect.right + radius, y: py },
        ].filter((option) => option.x >= minX && option.x <= maxX && option.y >= minY && option.y <= maxY)
          .sort((a, b) => a.cost - b.cost);
        // 四个方向全越界（面板比可用区还宽）就认了，别把它推到屏幕外面去。
        if (candidates.length === 0) continue;
        px = candidates[0].x;
        py = candidates[0].y;
        moved = true;
      }
      if (!moved) break;
    }
    return { x: px, y: py };
  }

  private syncTruckPointer(): void {
    const project = this.projectToScreen;
    if (!project || !this.simulation.running || this.isGameplayBlocked() || this.simulation.isDeparting()) {
      this.truckPointer.classList.add("hidden");
      return;
    }
    const truck = this.simulation.truck;
    const player = this.simulation.player;
    const margin = 34;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const projected = project(truck.x, truck.z);
    const onScreen = !projected.behind
      && projected.x > margin && projected.x < width - margin
      && projected.y > margin && projected.y < height - margin;
    if (onScreen) {
      this.truckPointer.classList.add("hidden");
      return;
    }
    // 相机背后时投影是镜像的，绕屏幕中心翻过来才是真实方向。
    const centreX = width / 2;
    const centreY = height / 2;
    let dx = projected.x - centreX;
    let dy = projected.y - centreY;
    if (projected.behind) { dx = -dx; dy = -dy; }
    // 把方向射线压到视口内缘的矩形上。
    const scale = Math.min((centreX - margin) / Math.abs(dx || 1e-6), (centreY - margin) / Math.abs(dy || 1e-6));
    const edge = this.keepClearOfPanels(centreX + dx * scale, centreY + dy * scale, margin);
    this.truckPointer.style.left = `${Math.round(edge.x)}px`;
    this.truckPointer.style.top = `${Math.round(edge.y)}px`;
    // 转的是**箭头那个盒子**，不是里面的三角（见 .truck-arrow 的注释）：
    // 盒子转，三角就沿着圆牌外缘画圆，而中间的卡车图标始终保持正的。
    // 三角自身朝上（border-bottom 撑出来的），所以角度要额外 +90°。
    this.truckArrow.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90}deg)`;
    const label = this.truckPointer.querySelector("b");
    if (label) label.textContent = `${Math.round(Math.hypot(truck.x - player.x, truck.z - player.z))}m`;
    this.truckPointer.classList.remove("hidden");
  }

  /**
   * 吃喝之后，在**被改动的那几条轴上**各飘一个 +N / −N。
   *
   * 为什么飘在条上而不是发一条吐司（"水 +22 · 体温 −9"）：五条状态轴对新玩家
   * 是五条无名的彩条，而"喝了一口水"正是唯一能说清哪条是水、哪条是体温的时机。
   * 数字必须落在那两条上；落进屏幕中央的吐司里，它就只是一句读完就忘的话。
   *
   * 喝水同时 +水 −体温，两个数会同时飘起来 —— 那一眼就是这个游戏的核心取舍：
   * 补水要付体温的账。这件事讲一百遍不如让他自己看见一次。
   */
  /**
   * 让"现在按有用"的那颗键搏动一下。
   *
   * 教学期间（actionOverride 非空，第一夜教学正指着某颗键）一律不搏动 ——
   * 那时已经有一盏聚光灯和一行字在说同一件事，再加一层只会打架。
   */
  private syncHintPulse(hint: InteractionHint): void {
    const teaching = this.actionOverride !== null;
    const attack = !teaching && !this.attackHintUsed && this.simulation.running
      && this.simulation.hasAttackTargetInRange();
    const action = !teaching && !this.actionHintUsed && this.simulation.running
      && hint.action !== "none";
    this.attackButton.classList.toggle("hint-pulse", attack);
    this.actionButton.classList.toggle("hint-pulse", action);
  }

  /**
   * 行动键的两档亮度：脚边有东西可按，还是什么都够不着。
   *
   * 和上面那个搏动是两回事。搏动是**教学**，第一次拾取或添柴之后就永久停掉
   * （actionHintUsed）；而"这颗键现在有没有用"是个一直存在的问题 —— 触屏档
   * 它上面只有一个 38px 图标和一行 8px 的动词，够不着东西时写着"行动"、图标是
   * 通用的那张，和真能按的时候长得一模一样。亮度差不需要读字就分得出来。
   *
   * 熄灭留三拍余量。判定半径只有 2.5~3.2 米，人停在边界上轻微晃动就会让 hint
   * 在 none 和非 none 之间来回跳，那样这颗键会闪。余量只推迟"熄灭"，不推迟
   * "点亮" —— 走进范围要当拍就有反馈。
   */
  private syncActionArmed(hint: InteractionHint): void {
    if (hint.action !== "none") this.armedGrace = ARMED_GRACE_TICKS;
    else if (this.armedGrace > 0) this.armedGrace -= 1;
    this.actionButton.classList.toggle("armed", this.armedGrace > 0);
  }

  private flashNourish(delta: { health: number; water: number; hunger: number; warmth: number }): void {
    for (const [key, meter] of this.nourishMeters) {
      const amount = delta[key];
      if (!amount) continue;
      const chip = document.createElement("u");
      chip.className = amount > 0 ? "meter-delta gain" : "meter-delta loss";
      chip.textContent = `${amount > 0 ? "+" : "−"}${Math.abs(amount)}`;
      // 动画一结束就自己摘掉。连点几下会叠出好几个，各自计时、互不干扰。
      chip.addEventListener("animationend", () => chip.remove(), { once: true });
      meter.appendChild(chip);
    }
  }

  update(deltaSeconds: number): void {
    // 每帧自查"平台眼里在不在玩"，变了才通知。
    //
    // 自查而不在各个开关处逐个报：广告和暂停各有好几条改法，漏掉任何一条，
    // 平台那边的"这一局玩了多久"就错了。自查一次全都覆盖，代价是最多晚一帧。
    const idle = this.isPlatformIdle();
    if (idle !== this.lastPlatformIdle) {
      this.lastPlatformIdle = idle;
      this.platformIdleListener?.(idle);
    }
    this.toastClock += deltaSeconds;
    if (this.toastTimer > 0) {
      this.toastTimer -= deltaSeconds;
      if (this.toastTimer <= 0) {
        this.toast.classList.add("hidden");
        this.toastPriority = -1;
        // 队列见底才把目标条亮回来：中间那道空白里再亮一次会闪。
        if (this.toastQueue.length > 0) this.toastGap = TOAST_GAP;
        else this.objectiveChip.classList.remove("muted");
      }
    } else if (this.toastGap > 0) {
      this.toastGap -= deltaSeconds;
      if (this.toastGap <= 0) this.playNextToast();
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
    const night = this.simulation.phase === "night";
    this.phaseLabel.textContent = t(night ? "phase.night" : "phase.day");
    this.clock.classList.toggle("night", night);
    /*
     * 相位条：本相位还剩多少。phaseTime 是倒计时，所以直接就是剩余量。
     *
     * 跟着这一拍走（每 0.08 秒），不进每帧那一段 —— 一条要走两三分钟才退完的线，
     * 每帧重算一次纯属浪费，而 0.08 秒的台阶在 375px 宽上是 0.02px，看不出来。
     */
    this.phaseBar.classList.toggle("night", night);
    const phaseLength = this.simulation.getPhaseDuration();
    const remaining = phaseLength > 0 ? clamp(this.simulation.phaseTime / phaseLength, 0, 1) : 0;
    this.phaseFill.style.transform = `scaleX(${remaining.toFixed(4)})`;
    const seconds = Math.max(0, Math.ceil(this.simulation.phaseTime));
    this.timeLabel.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    // 取水改成一按即得之后，中央栏只剩休息这一个胶囊 —— 原来那条"两个胶囊
    // 不能同时出现"的互斥保证（竖屏上它们之间只有 10px 余量）也就没有对象了。
    this.restIndicator.classList.toggle("hidden", !player.resting);

    const hint = this.actionOverride ?? this.simulation.getInteractionHint();
    const touchLayout = matchMedia("(pointer: coarse)").matches || window.innerWidth <= 760;
    this.syncHintPulse(hint);
    this.syncActionArmed(hint);
    this.actionIcon.dataset.icon = ACTION_ICON[hint.action];
    this.actionLabel.textContent = t(`action.${hint.action}`);
    if (hint.action === "none") {
      /*
       * 键鼠玩家开局什么操作说明都没有。
       *
       * 加载卡改成纯进度页之后，原来那行 "WASD 移动 · E 互动 · 空格攻击…"
       * （controls-copy）被一起删掉了，而现在开场没有按钮、加载完直接进场，
       * 于是键鼠玩家唯一能学到的键就是 E —— 还得先走到可交互物旁边才会冒出来。
       * 移动、攻击、背包全靠猜。
       *
       * 所以在**还没动过**的时候，把提示位借来说一次怎么走。玩家一移动
       * （clockStarted 由第一次实际输入触发）它就永远消失，不占常驻版面。
       * 触屏不显示：那边有摇杆和四颗大按钮，本来就不用教。
       */
      if (!touchLayout && !this.simulation.clockStarted && this.simulation.running) {
        this.prompt.innerHTML = tx({ key: "hud.pcControls" });
        this.prompt.classList.remove("hidden");
      } else {
        this.prompt.classList.add("hidden");
      }
    } else if (touchLayout) {
      // 提示就贴在"行动"键上方，键名由那颗按钮自己说 —— 这里再写一遍纯属重复。
      this.prompt.textContent = tx(hint.text);
      this.prompt.classList.remove("hidden");
    } else {
      this.prompt.innerHTML = `<kbd>E</kbd>${tx(hint.text)}`;
      this.prompt.classList.remove("hidden");
    }
    if (this.inventoryOpen) this.updateInventory();
    this.syncTruckPointer();
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
    // 判据是"打中过"而不是"按过"：挥空不说明他知道这颗键干什么用。
    if (event.type === "critter-hit" || event.type === "wolf-hit") this.attackHintUsed = true;
    // 拾取和添柴都算学会了行动键 —— 它们是这颗键最早能做到的两件事。
    if (event.type === "pickup" || event.type === "feed-fire") this.actionHintUsed = true;
    if (event.type === "nourish") this.flashNourish(event);
    if (event.type === "message") this.showToast(t(event.key, event.params), 3.1);
    if (event.type === "phase") {
      this.showToast(t(event.phase === "night" ? "toast.nightfall" : "toast.daybreak", { day: event.day }), 3.4, TOAST_CRITICAL);
    }
    if (event.type === "pickup" && (event.kind === "raw-meat" || event.kind === "hide" || event.kind === "water")) {
      const label = t(`loot.${event.kind}`);
      this.showToast(label, 1.4, TOAST_CASUAL);
    }
    if (event.type === "critter-killed") {
      const label = this.simulation.getCritterLabel(event.kind);
      this.showToast(t(event.kind === "oryx" ? "toast.huntBig" : "toast.hunt", { name: label }), 1.8, TOAST_CASUAL);
    }
    if (event.type === "fuel-loaded") {
      // 模拟层紧接着还会发详细 message，这里不再重复一条同义 toast ——
      // 队列虽然不会再让它们互相覆盖了，但两条说同一件事只是让人多等一拍。
      // 这里专门让常驻进度跳一格，详细说明继续交给 message。
      this.updateHuntProgress();
      this.huntProgress.classList.remove("fuel-loaded");
      void this.huntProgress.offsetWidth;
      this.huntProgress.classList.add("fuel-loaded");
    }
    if (event.type === "truck-depart") {
      this.closeInventory();
      this.showToast(t("toast.truckDepart"), 5, TOAST_CRITICAL);
    }
    if (event.type === "victory") {
      this.closeInventory();
      this.showVictory();
    }
    if (event.type === "game-over") {
      this.closeInventory();
      this.showGameOver(event);
    }
  }

  /**
   * 中央 toast。**显示期间把左上角的目标条压暗。**
   *
   * 原先两处会同时下指令：目标条说"去捡一根枯木回营地添柴"，toast 说
   * "侦察野狗正在逼近 · 面向它攻击" —— 同一瞬间到达、而且 toast 正好盖在它上面。
   * 玩家没有"两个都做"的选项，只会愣一下。
   *
   * 压暗而不是隐藏：目标条要保持在原位不跳，玩家的眼睛才知道回哪儿找它。
   *
   * ---
   *
   * **它是一个队列，不是一个槽。**
   *
   * 原先这里直接 `textContent = text`，于是同一帧到达的几条互相覆盖 —— main.ts
   * 每帧把模拟层攒下的事件整批倒出来，一帧里出现两三条是常态。实测代价：第一天
   * 唯一带确切数字的燃料预警（还差 2 根枯木）被同帧的"石头能封口"顶掉，
   * 而「第 1 夜 · 野狗群正在涌入」从来没在屏幕上停留过 —— 它总是排在别的后面。
   *
   * 规则四条：
   *   1. 同一句话不排两遍（同帧里"拾取"和模拟层的详细 message 常常同义）；
   *   2. 顺手级只争当下 —— 现在有东西在说就丢掉，绝不排队。一条 1.4 秒的"兽皮"
   *      让真正的警告晚 1.4 秒，这买卖不划算；
   *   3. 更急的立刻顶掉正在说的那条，被顶掉的排回队首（顺手级除外）——
   *      "天亮了"不该在"捡到兽皮"后面等；
   *   4. 后面还压着东西时每条只说七成时长，队列跟得上场上的节奏；排过头（6 秒）
   *      的普通提示直接作废，那时它说的已经不是当下了。
   */
  showToast(text: string, seconds = 2.3, priority: number = TOAST_NORMAL): void {
    if (this.toastTimer > 0 && this.toast.textContent === text) {
      // 同一句话又来一遍：续上时长，不排第二条。
      this.toastTimer = Math.max(this.toastTimer, seconds);
      return;
    }
    if (this.toastQueue.some((entry) => entry.text === text)) return;

    const busy = this.toastTimer > 0 || this.toastGap > 0;
    if (!busy) {
      this.playToast(text, seconds, priority);
      return;
    }
    if (priority <= TOAST_CASUAL) return;
    if (priority > this.toastPriority && this.toastTimer > 0) {
      if (this.toastPriority >= TOAST_NORMAL) {
        this.toastQueue.unshift({
          text: this.toast.textContent ?? "",
          seconds: Math.max(this.toastTimer, TOAST_MIN_SECONDS),
          priority: this.toastPriority,
          queuedAt: this.toastClock,
        });
      }
      this.playToast(text, seconds, priority);
      return;
    }
    this.toastQueue.push({ text, seconds, priority, queuedAt: this.toastClock });
  }

  /** 空白走完之后接上下一条；队列见底就把目标条亮回来。 */
  private playNextToast(): void {
    while (this.toastQueue.length > 0) {
      const entry = this.toastQueue.shift();
      if (!entry) break;
      if (entry.priority < TOAST_CRITICAL && this.toastClock - entry.queuedAt > TOAST_STALE_SECONDS) continue;
      const crowded = this.toastQueue.length > 0 ? 0.72 : 1;
      this.playToast(entry.text, Math.max(entry.seconds * crowded, TOAST_MIN_SECONDS), entry.priority);
      return;
    }
    this.objectiveChip.classList.remove("muted");
  }

  private playToast(text: string, seconds: number, priority: number): void {
    this.toast.textContent = text;
    this.toast.classList.remove("hidden");
    this.objectiveChip.classList.add("muted");
    this.toastTimer = seconds;
    this.toastGap = 0;
    this.toastPriority = priority;
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
      slot.innerHTML = `${itemIcon(stack.kind)}<span class="item-name">${itemName(stack.kind)}</span><b class="item-count">${stack.count}</b>`;
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
      ? t("craft.cook", { raws, health: COOKED_HEALTH })
      : t("craft.cook.none");
    this.craftCookButton.disabled = raws < 1;
  }

  /**
   * 升级区有四种状态。**先看闸，再看候选数量**：
   *
   *   未解锁 —— isEquipmentUnlocked() 为假 → **一行说明**，整棵树收起来
   *   2 个   —— 阶 0，两条线的一阶同时可造 → **分叉卡**
   *   1 个   —— 已分叉未满级 → **升级卡**（当前 vs 下阶并排）
   *   0 个   —— 已满级 → **属性总览**
   *
   * 闸必须单独判，不能靠候选数量：长度 0 已经被"已满级"占了。
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
    const unlocked = this.simulation.isEquipmentUnlocked();
    const signature = [
      unlocked ? "open" : "locked",
      equipped.id,
      ...options.map((tier) => tier.id),
      ...options.flatMap((tier) => tier.cost.map(([kind, count]) => `${kind}${Math.min(this.simulation.getInventoryCount(kind), count)}`)),
      this.simulation.findNearestLitFire(10) === null ? "nofire" : "fire",
      this.pendingSwitch && this.pendingSwitch.slot === slot ? this.pendingSwitch.id : "-",
    ].join("|");
    if (this.upgradeSignatures.get(slot) === signature) return;
    this.upgradeSignatures.set(slot, signature);

    // 还没拿到兽皮或铁矿：整棵树收起来，只说清它什么时候会长出来。
    // 说明只挂武器槽（index.html 里它排在护甲槽前面），护甲槽留空 ——
    // 同一句话在一屏里印两遍是噪音。
    if (!unlocked) {
      host.innerHTML = slot === "weapon" ? `<p class="upgrade-head locked">${t("upgrade.locked")}</p>` : "";
      return;
    }

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
        const equipped = this.simulation.getEquipped(slot);
        // 一阶换线退全款（见 GameSimulation.craftEquip），这时候还吓唬玩家"材料不退"
        // 就是在劝退一个本来无损的试错。
        const warningKey = equipped.tier === 1 ? "switch.free" : "switch.warning";
        return `<div class="confirm-bar">
          <span>${t(warningKey, { current: this.tierName(equipped), next: this.tierName(target) })}</span>
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
      difficulty: this.difficulty,
    });
    this.refreshRecordsLine();
    // 破了纪录就只报破的那一项 —— 平局时再念一遍旧纪录只会冲淡成就感。
    if (brokeEscape) {
      return t("records.escapeNew", { time: formatDuration(records.bestEscapeSeconds), day: records.bestEscapeDay });
    }
    if (brokeFuel) return t("records.fuelNew", { fuel: records.bestFuel, required: FUEL_REQUIRED });
    if (records.bestEscapeSeconds > 0) {
      return t("records.bestEscapeLong", {
        time: formatDuration(records.bestEscapeSeconds),
        day: records.bestEscapeDay,
      });
    }
    return t("records.bestFuelLong", { fuel: records.bestFuel, required: FUEL_REQUIRED });
  }

  /**
   * 把设置面板里的高亮切到某一档。
   *
   * 只改高亮，不改本局难度 —— 本局跑的是 this.difficulty，构造之后不再变。
   * 两者不同就说明玩家选了新档但还没重开，main.ts 那边据此亮出"重开一局"。
   */
  setDifficultySelection(difficulty: Difficulty): void {
    this.difficultySelection = difficulty;
    for (const option of document.querySelectorAll<HTMLElement>("#difficulty-options [data-difficulty]")) {
      option.setAttribute("aria-checked", String(option.dataset.difficulty === difficulty));
    }
  }

  getDifficultySelection(): Difficulty {
    return this.difficultySelection;
  }

  /** 开场页那一行；没玩过时整行隐藏，不占版面。 */
  refreshRecordsLine(): void {
    const text = describeRecords(loadRecords(this.difficulty));
    this.recordsLine.textContent = text ?? "";
    this.recordsLine.classList.toggle("hidden", text === null);
  }

  /**
   * 结算页上的"看广告续命"。
   *
   * 按钮文案里**必须写明这是广告**（Poki 审核必查项），所以标签上带一个片头符号，
   * 并把剩余次数摊开写 —— 玩家要在点之前就知道自己换的是什么、还剩几次。
   * 平台不支持激励视频、或次数用完，整个按钮不显示。
   */
  showReviveOffer(remaining: number, onRevive: () => void): void {
    this.reviveButton.classList.remove("hidden");
    this.reviveButton.disabled = false;
    this.reviveButton.textContent = t("revive.offer", { count: remaining });
    this.reviveButton.onclick = () => {
      this.reviveButton.disabled = true;
      onRevive();
    };
  }

  hideReviveOffer(): void {
    this.reviveButton.classList.add("hidden");
    this.reviveButton.onclick = null;
  }

  /** 复活成功：收掉结算页，回到游戏。 */
  resumeAfterRevive(): void {
    this.hideReviveOffer();
    this.gameOver.classList.add("hidden");
  }

  /**
   * 最后一次死亡事件。切语言时要靠它把结算页重新渲染一遍。
   *
   * 死因三段（#death-cause / #death-detail / #death-advice）是**命令式**填的，
   * 身上没有 data-i18n，所以 applyStaticText() 重刷静态文案时碰不到它们 ——
   * 不留这份快照的话，切语言后那三行会停在旧语言。
   *
   * 今天从结算页打不开暂停页（togglePause 在 game-over 期间无效），所以玩家
   * 实际触发不到；这是给以后留的闸 —— 同一个坑本轮已经踩到第二次
   * （第一次是声音开关的文字，见 main.ts 的 syncSoundLabel）。
   */
  private lastGameOver: Extract<GameEvent, { type: "game-over" }> | null = null;

  /** 切语言后重刷结算页。没死过就什么也不做。 */
  refreshGameOverText(): void {
    if (this.lastGameOver) this.showGameOver(this.lastGameOver);
  }

  private showGameOver(event: Extract<GameEvent, { type: "game-over" }>): void {
    this.lastGameOver = event;
    const wolfCount = this.simulation.wolves.filter((wolf) => wolf.mode !== "dead").length;
    this.deathCause.textContent = t(DEATH_CAUSE_KEYS[event.cause], {
      name: event.killer ? t(`dog.${event.killer}`) : t("death.killer.pack"),
    });
    this.deathDetail.textContent = t(`death.${event.cause}`);
    // 体温越界本身不致死，但 -60%/-75% 的减速经常才是真凶。
    // 下一局建议优先解释这个促成因素；体温正常时再针对直接死因给一条做法。
    this.deathAdvice.textContent = event.condition === "heatstroke"
      ? t("death.note.heatstroke")
      : event.condition === "hypothermia"
        ? t("death.note.hypothermia")
        : t(DEATH_ADVICE_KEYS[event.cause]);
    this.resultCopy.textContent = [
      t("over.summary", { day: this.simulation.day, count: this.simulation.player.kills }),
      t("over.remaining", { count: wolfCount }),
      this.submitAndDescribe(false),
    ].filter(Boolean).join(" ");
    this.gameOver.classList.remove("hidden");
  }

  private showVictory(): void {
    const player = this.simulation.player;
    this.victoryCopy.textContent = [
      t("win.summary", { day: this.simulation.day, count: player.kills }),
      this.submitAndDescribe(true),
    ].filter(Boolean).join(" ");
    this.showVictoryProgression();
    this.victory.classList.remove("hidden");
  }

  /**
   * 通关页直接给下一局入口，不再把玩家赶去设置里找开关。
   * 当前档显示“再玩一遍”，另外两档显示“挑战…”。推荐色落在下一档；
   * 已打穿困难时则落回当前档，重点变成刷新纪录。
   */
  private showVictoryProgression(): void {
    this.victoryProgressionCopy.textContent = t(`win.progress.${this.difficulty}`);
    const index = DIFFICULTIES.indexOf(this.difficulty);
    const recommended = DIFFICULTIES[index + 1] ?? this.difficulty;
    for (const button of this.victoryChoices) {
      const target = button.dataset.victoryDifficulty as Difficulty;
      const replay = target === this.difficulty;
      button.textContent = replay
        ? t("win.replay")
        : t("win.challenge", { difficulty: t(`difficulty.${target}`) });
      button.title = t(`difficulty.${target}.blurb`);
      button.classList.toggle("recommended", target === recommended);
      button.classList.toggle("replay", replay);
      if (replay) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  }
}
