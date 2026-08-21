/**
 * 真机性能读数。**只在 URL 带 ?perf=1 时下载并创建。**
 *
 * ## 为什么需要它
 *
 * 这个仓库的渲染改动一直是**盲改**：开发环境的浏览器面板不合成帧
 * （document.hidden 恒为 true，requestAnimationFrame 一帧都不跑），所以
 * 「阴影隔帧」「角色改贴地圆斑」「散物合批」「阴影按锚点缓存」这几轮下来，
 * 没有一次能在提交前验证它到底有没有用 —— 只能等 Poki 的 MEDIAN FPS，
 * 而那个一天只能取两次。
 *
 * 这几个数一出来，瓶颈类型当场就分得出来：
 *
 *   draw calls 几百           → 批处理问题，去做 instancing
 *   draw calls 几十但仍然卡   → 填充率 / shader，去动分辨率和材质复杂度
 *   两者都不高               → CPU 侧，去看 AnimationMixer 和骨骼更新
 *
 * ## 几个刻意的取舍
 *
 * **每秒只刷一次 DOM。** 逐帧更新会让这个面板自己变成开销，量到的就不是原来
 * 那个游戏了。一秒一次足够读趋势，数字也不会跳得没法看。
 *
 * **fps 用这一秒内的真实帧数，不是 1/delta 的瞬时值。** 瞬时值在掉帧时抖得
 * 读不出稳定水平，而我们要判断的正好是"稳定在多少"。另外单独记一个历史最低，
 * 平均帧数掩盖得了的卡顿靠它露出来。
 *
 * **pointer-events: none。** 它盖在 HUD 上，绝不能吃掉一次触摸 —— 这个游戏
 * 刚为了「右下角吃点击」折腾过一轮。
 */
export interface RenderStats {
  calls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
}

const STYLE = [
  "position:fixed",
  "left:8px",
  "top:8px",
  "z-index:60",
  "padding:6px 9px",
  "border-radius:7px",
  "background:rgba(6,10,13,.82)",
  "color:#8ef2c8",
  "font:600 11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
  "white-space:pre",
  // 绝不吃触摸：这个面板盖在 HUD 上方。
  "pointer-events:none",
  "text-shadow:0 1px 2px rgba(0,0,0,.6)",
].join(";");

export class PerfOverlay {
  private readonly element = document.createElement("div");
  private frames = 0;
  private elapsed = 0;
  /** 上一整秒的稳定读数。 */
  private fps = 0;
  private worst = Infinity;

  constructor(private readonly readStats: () => RenderStats) {
    this.element.style.cssText = STYLE;
    document.body.appendChild(this.element);
    // 立刻写一次：fps 那行要等满一秒才有意义，但 draw / tri / prog 在第一帧
    // 画完之后就是准的。开局先给数，别挂一个占位符在那儿。
    this.write();
  }

  /** 每帧调用，但只有跨过一秒才真的写 DOM。 */
  update(delta: number): void {
    this.frames += 1;
    this.elapsed += delta;
    if (this.elapsed < 1) return;
    this.fps = Math.round(this.frames / this.elapsed);
    if (this.fps < this.worst) this.worst = this.fps;
    this.frames = 0;
    this.elapsed = 0;
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
      "fps  " + fps + "   min " + worst,
      "draw " + String(s.calls).padStart(3) + "   tri " + (s.triangles / 1000).toFixed(1) + "k",
      "prog " + String(s.programs).padStart(3) + "   geo " + s.geometries + "  tex " + s.textures,
    ].join("\n");
  }
}
