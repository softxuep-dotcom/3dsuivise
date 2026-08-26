/**
 * 游戏平台适配层。
 *
 * Poki、CrazyGames、GameDistribution、Y8 这些 H5 平台要求的接入面惊人地一致：
 * 一个异步的 `init`、一对"加载完了没"的信号、一对"这一局开始/结束"的信号、
 * 一个插屏广告、一个激励视频。差别只在函数名和返回值形态。
 *
 * 所以这里定一份**我们自己的**契约，游戏只对着它写；每个平台一个薄适配器。
 * 换平台是新增一个文件加一行 switch，不是满仓库找 `PokiSDK.` 。
 *
 * ## 三条硬规矩，写进类型里管不住，只能写在这儿
 *
 * 1. **任何一个调用都不许抛，也不许永远不返回。** 平台 SDK 从第三方 CDN 加载，
 *    玩家可能开着广告拦截、可能在墙后、可能网络就是烂。SDK 挂了要退化成"没有平台"，
 *    而不是把游戏卡死在加载条上 —— 这是这一层存在的首要理由。
 * 2. **广告期间必须静音、必须屏蔽输入。** 平台条款里明写着，也是常识：
 *    玩家在看广告，游戏不该在背后继续挨咬。走 {@link PlatformHooks}。
 * 3. **激励视频没播完就不给奖励。** `rewardedBreak()` 返回 false 时一分都不能给，
 *    这是平台审核必查项。
 */

export interface PlatformHooks {
  /**
   * 广告开始 / 结束。适配器保证成对触发，**包括 SDK 抛异常的路径** ——
   * 漏掉一次 `onAdEnd` 就等于游戏永久静音且不接受输入。
   */
  onAdStart?: () => void;
  onAdEnd?: () => void;
}

export interface GamePlatform {
  /** 诊断用的名字，会打进控制台。 */
  readonly name: string;
  /** 这个平台有没有激励视频。没有的话 UI 上就不该出现"看广告换 X"的按钮。 */
  readonly supportsRewarded: boolean;

  /** 加载 SDK 并握手。失败也必须 resolve —— 见上面第 1 条。 */
  init(): Promise<void>;

  /** 加载条走完、可以开玩了。平台拿它算加载转化率。 */
  loadingFinished(): void;

  /**
   * 一局**可玩**的开始与结束。
   *
   * 注意"可玩"不等于"页面打开"：暂停、开背包（我们的背包会暂停游戏）、
   * 切到后台、死亡结算页，都算 stop。平台用这对信号决定什么时候插广告 ——
   * 报得越准，广告越不会插在玩家正被狗围着的时候。
   */
  gameplayStart(): void;
  gameplayStop(): void;

  /**
   * 插屏广告。放在**玩家已经表达了"我要继续"的自然断点**上（比如点了再来一局），
   * 而不是死亡的那一刻。要不要真的放由平台决定，我们只管报时机。
   */
  commercialBreak(): Promise<void>;

  /**
   * 激励视频。resolve(true) 才发奖励。
   * 调用前必须让玩家**知道自己要看广告**（按钮上写清楚），这也是审核必查项。
   */
  rewardedBreak(): Promise<boolean>;

  /**
   * 游戏**真正可玩**了。和 loadingFinished 不是一回事：
   * 我们加载完还要等玩家第一次输入才 start()，这中间他已经能动了。
   */
  gameInteractive(): void;

  /**
   * 进度节点上报。喂的是 Poki 后台的 **Progress Events** 那张表
   * （列：Started / Completed / Failed / Left）。
   *
   * 表里显示成 `category / what`，`action` 只能是 start / complete / fail，
   * 而且**一次尝试只能收口一次** —— complete 和 fail 不能都报。没收口的那些
   * 就落进 Left 列，语义正好是"他走了"。
   *
   * 报什么、什么时候报，全部写在 platform/RunProgress.ts。
   */
  measure(category: string, what: string, action: ProgressAction): void;
}

/** 见 {@link GamePlatform.measure}。Poki 只认这三个。 */
export type ProgressAction = "start" | "complete" | "fail";

/**
 * 没有平台时用的空实现：本地开发、GitHub Pages、itch.io 都走这个。
 *
 * `rewardedBreak` 恒返回 false 而不是 true —— 没有广告可看就等于没看完，
 * 于是"没播完不发奖"这条规则在没有平台时自动成立，不需要调用方额外判断。
 */
export class NullPlatform implements GamePlatform {
  readonly name = "none";
  readonly supportsRewarded = false;

  async init(): Promise<void> { /* 无事可做 */ }
  loadingFinished(): void { /* 无事可做 */ }
  gameplayStart(): void { /* 无事可做 */ }
  gameplayStop(): void { /* 无事可做 */ }
  async commercialBreak(): Promise<void> { /* 直接放行 */ }
  async rewardedBreak(): Promise<boolean> { return false; }
  gameInteractive(): void { /* 无事可做 */ }
  measure(): void { /* 无事可做 */ }
}

/**
 * 把第三方 SDK 脚本塞进页面。
 *
 * **带超时**是重点：`<script>` 在被广告拦截插件掐掉时，onerror 有时根本不触发，
 * 只是静静地永远不 load。没有超时的话开场进度条会停在那里等一个不会来的回调。
 */
export function loadScript(src: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("script");
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = window.setTimeout(() => finish(new Error(`${src} timed out`)), timeoutMs);
    element.src = src;
    element.async = true;
    element.addEventListener("load", () => finish());
    element.addEventListener("error", () => finish(new Error(`${src} failed to load`)));
    document.head.appendChild(element);
  });
}

/**
 * 给广告调用套上"静音 + 屏蔽输入 + 出错也要收尾"的壳。
 *
 * 每个适配器都要这么做，所以放在这里而不是各写一遍：漏掉 finally 的后果是
 * 游戏永久静音，而那种 bug 只在广告加载失败时才出现，本地根本测不到。
 */
export async function withAdGuard<T>(hooks: PlatformHooks, run: () => Promise<T>, fallback: T): Promise<T> {
  hooks.onAdStart?.();
  try {
    return await run();
  } catch (error) {
    console.warn("[platform] ad call failed", error);
    return fallback;
  } finally {
    hooks.onAdEnd?.();
  }
}
