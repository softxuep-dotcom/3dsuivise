import { loadScript, withAdGuard, type GamePlatform, type PlatformHooks, type ProgressAction } from "./GamePlatform";

/**
 * Poki 适配器。文档：https://sdk.poki.com/html5
 *
 * SDK 挂在 `window.PokiSDK` 上，全部方法都是可选调用 —— 我们只声明用得到的那几个，
 * 而且每一个都当作**可能不存在**来调：Poki 的 SDK 是从他们 CDN 现拉的，
 * 版本会变，少一个方法不该让游戏崩。
 */
interface PokiSDK {
  init?: () => Promise<unknown>;
  gameLoadingStart?: () => void;
  gameLoadingFinished?: () => void;
  gameplayStart?: () => void;
  gameplayStop?: () => void;
  commercialBreak?: (beforeAd?: () => void) => Promise<unknown>;
  rewardedBreak?: (beforeAd?: () => void) => Promise<boolean>;
  gameInteractive?: () => void;
  measure?: (category: string, what: string, action: string) => void;
  setDebug?: (value: boolean) => void;
}

const SDK_URL = "https://game-cdn.poki.com/scripts/v2/poki-sdk.js";

export class PokiPlatform implements GamePlatform {
  readonly name = "poki";
  readonly supportsRewarded = true;

  private sdk: PokiSDK | null = null;
  /**
   * 一局是不是正在进行。Poki 明确要求 gameplayStart/Stop **成对**出现，
   * 而我们的调用点很多（进场、开背包、切后台、死亡、看广告），
   * 不去重的话很容易连着报两次 start —— 平台那边的时长统计就废了。
   */
  private playing = false;

  constructor(private readonly hooks: PlatformHooks, private readonly debug = false) {}

  async init(): Promise<void> {
    try {
      await loadScript(SDK_URL);
      const sdk = (window as unknown as { PokiSDK?: PokiSDK }).PokiSDK ?? null;
      if (!sdk) throw new Error("PokiSDK global missing after load");
      if (this.debug) sdk.setDebug?.(true);
      // init() 失败也照样进游戏 —— Poki 自己的示例代码就是这么写的：
      // "Initialized, something went wrong, load your game anyway"。
      await sdk.init?.().catch((error: unknown) => {
        console.warn("[poki] init rejected; continuing without it", error);
      });
      this.sdk = sdk;
      this.sdk.gameLoadingStart?.();
    } catch (error) {
      // 拦截插件、离线、CDN 挂了都走这里。退化成"没有平台"，游戏照常。
      console.warn("[poki] SDK unavailable; running without platform integration", error);
      this.sdk = null;
    }
  }

  loadingFinished(): void {
    this.sdk?.gameLoadingFinished?.();
  }

  gameInteractive(): void {
    this.sdk?.gameInteractive?.();
  }

  /**
   * 进度节点。
   *
   * **参数里不能有 `/` 和 `^`** —— 这是 SDK 自己的限制，它撞上时只在控制台
   * 打一行红字然后把整次上报丢掉，不抛异常。所以这里先换成 `-`，
   * 宁可让后台看见一个改过名的节点，也别让它无声消失。
   */
  measure(category: string, what: string, action: ProgressAction): void {
    const safe = (value: string): string => value.replace(/[/^]/g, "-");
    this.sdk?.measure?.(safe(category), safe(what), action);
  }

  gameplayStart(): void {
    if (this.playing) return;
    this.playing = true;
    this.sdk?.gameplayStart?.();
  }

  gameplayStop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.sdk?.gameplayStop?.();
  }

  /**
   * 插屏。**广告前必须先 gameplayStop** —— 广告播的时候这一局在平台看来
   * 就是暂停的；不这么报，统计里会出现"一局玩了十分钟其中八分钟在看广告"。
   * 播完不自动恢复 gameplayStart，由调用方在真正回到游戏时再报。
   */
  async commercialBreak(): Promise<void> {
    const sdk = this.sdk;
    if (!sdk?.commercialBreak) return;
    this.gameplayStop();
    await withAdGuard(this.hooks, async () => {
      await sdk.commercialBreak?.(() => { /* 静音已由 withAdGuard 统一处理 */ });
    }, undefined);
  }

  /** 激励视频。SDK 不在或播放失败一律返回 false —— 没播完就不给奖励。 */
  async rewardedBreak(): Promise<boolean> {
    const sdk = this.sdk;
    if (!sdk?.rewardedBreak) return false;
    this.gameplayStop();
    return withAdGuard(this.hooks, async () => {
      const success = await sdk.rewardedBreak?.(() => { /* 同上 */ });
      return success === true;
    }, false);
  }
}
