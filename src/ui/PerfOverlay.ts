/**
 * 真机性能读数。**只在 URL 带 ?perf=1 时下载并创建。**
 *
 * ## 为什么需要它
 *
 * 这个仓库的渲染改动一直是**盲改**：开发环境的浏览器面板不合成帧
 * （document.hidden 恒为 true，requestAnimationFrame 一帧都不跑），所以
 * 「阴影隔帧」「角色改贴地圆斑」「散物合批」「阴影按锚点缓存」这几轮下来，
 * 没有一次能在提交前验证 —— 只能等 Poki 的 MEDIAN FPS，一天两次。
 *
 * ## 第一次真机读数带来的教训（2026-08-21）
 *
 * 主创的手机跑出 **fps 118**，而同期 Poki 的 MEDIAN FPS 是 **26**。差 4~5 倍。
 * 这台机器根本不卡，所以**它验证不了任何针对弱机的优化** —— 在它上面看
 * fps 有没有涨是没有意义的。
 *
 * 真正有用的是那三个**设备无关**的工作量指标：draw calls、triangles、programs。
 * 它们不随机器快慢变化，减下去对弱机的收益成比例地更大。所以这个面板的用法是：
 * **读 draw / tri / prog，别读 fps。**
 *
 * fps 那一行留着，但只用来抓"这台机器上都卡"的严重问题。
 *
 * ## 几个刻意的取舍
 *
 * **每秒只刷一次 DOM。** 逐帧更新会让面板自己变成开销，量到的就不是原来那个游戏。
 *
 * **min 跳过前 WARMUP_SECONDS 秒。** 第一版把它写成"从加载起的历史最低"，
 * 结果读出来是 54 —— 那是着色器编译和 GLB 解析那一下，不是运行中的卡顿，
 * 等于这个数什么都没说。跳过热身之后它才代表稳定期的最差表现。
 *
 * **另记一个 slow 计数：上一秒里有几帧超过 33ms（掉到 30fps 以下）。**
 * 平均值和最低值都看不出"卡顿有多频繁"，而周期性的卡顿（比如阴影重锚那一帧）
 * 正是要靠频率才认得出来。
 *
 * **pointer-events: none，摆在左下角。** 它绝不能吃触摸（这个游戏刚为
 * 「右下角吃点击」折腾过一轮），也不该压住左上角的目标行 —— 第一版就压住了。
 */
export interface RenderStats {
  calls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
}

/** 前几秒不计入 min：着色器编译和模型解析都挤在这一段。 */
const WARMUP_SECONDS = 4;
/** 超过这个毫秒数算一帧"卡"（30fps 线）。 */
const SLOW_FRAME_MS = 33;

const STYLE = [
  "position:fixed",
  "left:8px",
  // 左下角：左上是目标行，右上是状态栏，右下是按钮簇。只有这里是空的。
  // 抬 26px 让开版本号那一行。
  "bottom:26px",
  "z-index:60",
  "padding:6px 9px",
  "border-radius:7px",
  "background:rgba(6,10,13,.82)",
  "color:#8ef2c8",
  "font:600 11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
  "white-space:pre",
  "pointer-events:none",
  "text-shadow:0 1px 2px rgba(0,0,0,.6)",
].join(";");

export class PerfOverlay {
  private readonly element = document.createElement("div");
  private frames = 0;
  private elapsed = 0;
  private slowFrames = 0;
  private lastSlow = 0;
  /** 页面活了多久，用来跳过热身。 */
  private lifetime = 0;
  /** 上一整秒的稳定读数。 */
  private fps = 0;
  private worst = Infinity;

  constructor(private readonly readStats: () => RenderStats) {
    this.element.style.cssText = STYLE;
    document.body.appendChild(this.element);
    // 立刻写一次：fps 要等满一秒，但 draw / tri / prog 在第一帧画完之后就是准的。
    this.write();
  }

  /** 每帧调用，但只有跨过一秒才真的写 DOM。 */
  update(delta: number): void {
    this.frames += 1;
    this.elapsed += delta;
    this.lifetime += delta;
    if (delta * 1000 > SLOW_FRAME_MS) this.slowFrames += 1;
    if (this.elapsed < 1) return;
    this.fps = Math.round(this.frames / this.elapsed);
    // 热身期不计 min：那几秒里的低值来自编译和解析，不是运行时的卡顿。
    if (this.lifetime > WARMUP_SECONDS && this.fps < this.worst) this.worst = this.fps;
    this.lastSlow = this.slowFrames;
    this.frames = 0;
    this.elapsed = 0;
    this.slowFrames = 0;
    this.write();
  }

  /** 软重开时清掉历史最低，否则上一局的卡顿会一直挂在新一局头上。 */
  resetWorst(): void {
    this.worst = Infinity;
  }

  private write(): void {
    const s = this.readStats();
    const fps = this.fps ? String(this.fps).padStart(3) : "  -";
    const worst = this.worst === Infinity ? "-" : String(this.worst);
    this.element.textContent = [
      "fps  " + fps + "   min " + worst + "   slow " + this.lastSlow,
      "draw " + String(s.calls).padStart(3) + "   tri " + (s.triangles / 1000).toFixed(1) + "k",
      "prog " + String(s.programs).padStart(3) + "   geo " + s.geometries + "  tex " + s.textures,
    ].join("\n");
  }
}
