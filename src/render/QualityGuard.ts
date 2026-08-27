/**
 * 帧率监测：跟不上就往下降一档，共三档，只降不升。
 *
 * ## 和 main 分支上那套「一次性画质上调」是一对
 *
 * 那一套（e87bcd5）解决的是"好手机被一刀切压住"：移动档把 pixelRatio 钉死在 1.0，
 * 而旗舰机的 devicePixelRatio 普遍 2.5~3.5，等于按原生 1/9 的像素数渲染再拉满屏。
 * 它量一段，达标就升上去，单向、只升一次。
 *
 * 这一套走的是反方向：**从一档起步，跟不上就往下走**。两边共用同一套测量思路
 * （预热、采样窗口、中位数、丢异常帧），但判据不一样，见 SLOW_FRAME_MS 那段。
 *
 * ## 三档长什么样
 *
 * 画质本身写在 GameRenderer.applyTier 里，这个文件只管"该在哪一档"。摘要：
 *
 *   一档（默认）  pixelRatio 移动 1.3 / 桌面 1.6   有雾  有扬沙  剔除 45 米
 *   二档          pixelRatio 1.0                  无雾  无扬沙  剔除 45 米
 *   三档          pixelRatio 0.8                  无雾  无扬沙  剔除 35 米
 *
 * ## 为什么第一次判定的窗口比后面短
 *
 * 移动端一档是 1.3，比改造前的 1.0 重了 69% 的像素。好手机吃得下（main 那套
 * 实测它们在 1.0 上被压得太狠），但弱机在降下来之前要一直顶着这个负担 ——
 * 而那段正好是开局最敏感的几十秒（731 局里 36% 死在第一个白天的 40 秒内）。
 *
 * 所以第一轮只用 {@link FIRST_WINDOW_MS}：够判"这台机器明显扛不住 1.3"就行，
 * 不必攒到统计上很漂亮。后面的轮次才用完整窗口。
 *
 * ## 为什么慢得离谱时一次降两档
 *
 * 一轮一档的话，一台 15fps 的机器要 5 + 4 = 9 秒才走到三档。而它在这 9 秒里
 * 一直是难玩的。中位数超出阈值一倍（≈20fps 以下）就直接跳到三档 ——
 * 这种机器不存在"二档正好合适"的可能。
 *
 * ## 为什么窗口是反复的，不像上调那样判一次就收工
 *
 * 因为这个游戏最重的一帧不在开局。第一夜从第 40 秒开始，一口气放三十几只狼，
 * 那才是真正会掉帧的时刻。开局判完就收工的话，正好**避开**了要测的东西。
 * 所以一轮没判出问题就重新攒一轮，直到降到三档（最低档）才永久收工。
 */

/** 一档最好，三档最省。只会从小往大走。 */
export type QualityTier = 1 | 2 | 3;

export const BEST_TIER: QualityTier = 1;
export const WORST_TIER: QualityTier = 3;

export interface QualityGuardOptions {
  /**
   * 这一局在不在跑。
   *
   * 玩家还停在开场页时场上没有狼、没有猎物，那时候量出来的富余是假的；
   * 反过来，加载刚结束那几帧慢得离谱，照着它降档会冤枉一台好机器。
   */
  isPlaying(): boolean;
  /** 降到某一档时调一次。只会带着更大的档位号来，不会回头。 */
  onTier(tier: QualityTier): void;
  /**
   * 现在几点。省略就用 performance.now()。
   *
   * 留这个口子是为了**能测**：这套判据在真机之外没有别的验证途径 ——
   * 手上没有弱机，rAF 在页面不可见时又一帧都不跑。注入时钟之后，
   * "多慢才算慢、预热期内不判、样本不够不判、几时跳两档"就都能在测试里逐条钉住。
   */
  now?: () => number;
}

/** 玩家真正开始玩之后先跳过这么久：着色器编译和 GLB 解析都挤在这一段。 */
const WARMUP_MS = 3000;
/** 第一轮的窗口。短，理由见文件头「为什么第一次判定的窗口比后面短」。 */
const FIRST_WINDOW_MS = 2000;
/** 后续每一轮的窗口。 */
const WINDOW_MS = 4000;
/**
 * 一轮里至少要有这么多个有效样本才判。
 *
 * **这是一条低位地板，不是统计意义上的样本量要求。**它只防一种情况：
 * 这一轮几乎全是异常帧（切后台、长 GC），手上没有能代表这台机器的数据。
 *
 * 一开始写成 90，那是错的，而且错得正好反着：4 秒窗口里，90 个样本要求
 * 帧间隔不超过 44ms —— 也就是说**跑不到 22fps 的机器永远攒不满，于是永远降不了档**，
 * 而它们恰恰是最需要降的。样本门槛不能随"机器有多慢"反向收紧。
 *
 * 20 个：2 秒的首轮窗口里跑到 10fps 就够。再慢的话帧间隔会超过 OUTLIER_MS
 * 被整个丢掉，那时候多半是标签页被挂到后台了，不是这台机器慢。
 */
const MIN_SAMPLES = 20;
/**
 * 出帧间隔中位数超过这个值就算跟不上。25ms ≈ 40fps。
 *
 * ## 为什么是绝对值，不是"刷新间隔的多少倍"
 *
 * 上调那套用的是相对刷新率的比例，因为它问的是"有没有富余"——
 * 而富余只有相对这台机器的上限才有意义。
 *
 * 降级问的是另一件事：**这游戏现在还能不能玩**。那是绝对的。
 * 用相对判据会在 120Hz 机器上闹笑话：跑 60fps（间隔 16.7ms，完全流畅）
 * 除以 8.33ms 的刷新间隔等于 2.0，任何"倍数"阈值都会把它判成跟不上。
 *
 * 40fps 这条线的位置：这个游戏在移动端出过 MEDIAN FPS 19 的事故（1.0.16 那次），
 * 而平台侧关心的是 30fps。卡在 40 是为了**在掉到难受之前**就降，
 * 而不是等玩家已经觉得卡了才动。
 */
const SLOW_FRAME_MS = 25;
/**
 * 中位数超过这个值就一次降两档。50ms ≈ 20fps。
 *
 * 这种机器不存在"中间那档正好合适"的可能，一档一档往下挪只是让它多难玩几秒。
 */
const VERY_SLOW_FRAME_MS = SLOW_FRAME_MS * 2;
/**
 * 一帧超过这么久就整个丢掉，不算进样本。
 *
 * 切后台、着色器编译、GC 长停顿都会混进来。它们既不代表这台机器的稳态开销，
 * 又足以把中位数拖歪 —— 一次 2 秒的停顿能让一整轮窗口误判。
 */
const OUTLIER_MS = 250;

export class QualityGuard {
  private readonly intervals: number[] = [];
  private startedAt = 0;
  private lastFrameAt = 0;
  private judged = false;
  private tier: QualityTier = BEST_TIER;
  /** 降到最低档之后永久收工，sample() 直接 return。 */
  private settled = false;

  private readonly now: () => number;

  constructor(private readonly options: QualityGuardOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  /** 现在在第几档。只会从 1 往 3 走。 */
  get current(): QualityTier {
    return this.tier;
  }

  /**
   * 每帧调一次，**排在这一帧所有渲染工作之后**。
   *
   * @param frameStart 这一帧开始时的 performance.now()。间隔按它算，
   *                   而不是按调用时刻 —— 否则量进去的是"上一帧渲染完到这一帧渲染完"，
   *                   中间夹着浏览器的合成和 vsync 等待，读数会偏大。
   */
  sample(frameStart: number): void {
    if (this.settled) return;
    if (!this.options.isPlaying()) {
      // 暂停、开场页、结算页：不计时也不采样，并且把上一帧的时刻清掉，
      // 免得恢复之后第一帧算出一个几秒的间隔。
      this.lastFrameAt = 0;
      return;
    }
    const now = this.now();
    if (this.startedAt === 0) this.startedAt = now;
    const interval = this.lastFrameAt > 0 ? frameStart - this.lastFrameAt : 0;
    this.lastFrameAt = frameStart;

    const elapsed = now - this.startedAt;
    if (elapsed < WARMUP_MS) return;
    if (interval > 0 && interval < OUTLIER_MS) this.intervals.push(interval);
    const window = this.judged ? WINDOW_MS : FIRST_WINDOW_MS;
    if (elapsed < WARMUP_MS + window) return;

    // 到点了，判一轮。
    this.judged = true;
    const middle = this.intervals.length >= MIN_SAMPLES ? median(this.intervals) : 0;
    const steps = middle > VERY_SLOW_FRAME_MS ? 2 : middle > SLOW_FRAME_MS ? 1 : 0;
    if (steps > 0) this.stepDown(steps);

    /*
     * 无论降没降，都重新攒一轮 —— 除非已经在最低档（stepDown 会置 settled）。
     *
     * 最重的那一帧不在开局（第一夜从第 40 秒起，一口气三十几只狼），
     * 判一次就收工正好避开了要测的东西。
     *
     * 重置的是**窗口**不是预热：预热只为躲开加载末尾那几帧，那一段早过去了。
     * 所以把 startedAt 拨到"预热已经走完"的位置，下一轮直接开始采样。
     */
    this.intervals.length = 0;
    this.startedAt = now - WARMUP_MS;
  }

  /** 往下走 steps 档。到最低档就永久收工。调试开关也走这里。 */
  stepDown(steps = 1): void {
    if (this.settled) return;
    const next = Math.min(this.tier + steps, WORST_TIER) as QualityTier;
    if (next === this.tier) return;
    this.tier = next;
    if (next === WORST_TIER) this.settled = true;
    this.options.onTier(next);
  }

  /** 直接跳到某一档。只用于调试开关（`?quality=2` / `?quality=3`）。 */
  jumpTo(tier: QualityTier): void {
    this.stepDown(tier - this.tier);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}
