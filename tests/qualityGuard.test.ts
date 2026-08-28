import { describe, expect, it } from "vitest";
import { QualityGuard } from "../src/render/QualityGuard";
import type { QualityTier } from "../src/render/QualityGuard";

/**
 * 帧率降档的判定。
 *
 * **这套判据在真机之外没有别的验证途径**：手上没有弱机，而 rAF 在页面不可见时
 * 一帧都不跑，所以浏览器里也没法真跑一段慢帧。注入时钟之后，
 * "多慢才算慢、预热期内不判、样本不够不判、暂停不采样"这些就能逐条钉住 ——
 * 这也正是给 QualityGuard 留 `now` 这个口子的全部理由。
 *
 * 时间单位都是毫秒。25ms ≈ 40fps 是那条线，见 SLOW_FRAME_MS。
 */

/** 按固定帧间隔喂 seconds 秒。返回喂完之后的时刻。 */
function feed(
  guard: QualityGuard,
  clock: { t: number },
  intervalMs: number,
  seconds: number,
): void {
  const steps = Math.round((seconds * 1000) / intervalMs);
  for (let i = 0; i < steps; i += 1) {
    // frameStart 就是这一帧开始的时刻；渲染耗时在这里不重要，判据只看间隔。
    const frameStart = clock.t;
    clock.t += intervalMs;
    guard.sample(frameStart);
  }
}

function build() {
  const clock = { t: 1000 };
  const tiers: QualityTier[] = [];
  const guard = new QualityGuard({
    isPlaying: () => true,
    onTier: (tier) => { tiers.push(tier); },
    now: () => clock.t,
  });
  return { guard, clock, tiers, get tier() { return guard.current; } };
}

describe("帧率降档", () => {
  it("60fps 的机器不降档", () => {
    const h = build();
    feed(h.guard, h.clock, 16.7, 20);
    expect(h.tiers).toEqual([]);
    expect(h.tier).toBe(1);
  });

  it("120fps 的机器不降档 —— 判据是绝对帧率，不是刷新率的倍数", () => {
    const h = build();
    feed(h.guard, h.clock, 8.33, 20);
    expect(h.tiers).toEqual([]);
  });

  it("120Hz 屏上只跑到 60fps 也不降 —— 那依然是流畅的", () => {
    /*
     * 这条锁的是一个很容易写错的判据。如果拿"间隔 / 刷新间隔"当阈值，
     * 16.7 ÷ 8.33 = 2.0，任何倍数阈值都会把一台跑得好好的机器判成跟不上。
     */
    const h = build();
    feed(h.guard, h.clock, 16.7, 20);
    expect(h.tiers).toEqual([]);
  });

  it("稳定 20fps 会降档", () => {
    const h = build();
    feed(h.guard, h.clock, 50, 20);
    expect(h.tier).toBe(3);   // 20fps 慢得离谱，一次跳两档
  });

  it("卡在 40fps 这条线的两侧：38fps 降，42fps 不降", () => {
    const slow = build();
    feed(slow.guard, slow.clock, 1000 / 38, 20);
    expect(slow.tier).toBeGreaterThan(1);

    const ok = build();
    feed(ok.guard, ok.clock, 1000 / 42, 20);
    expect(ok.tiers).toEqual([]);
  });

  it("预热期（前 3 秒）内再慢也不判 —— 那一段是着色器编译和 GLB 解析", () => {
    const h = build();
    feed(h.guard, h.clock, 50, 2.5);
    expect(h.tiers).toEqual([]);
  });

  it("样本不够不判 —— 宁可不动，也不能拿几帧下结论", () => {
    const h = build();
    /*
     * 一秒只出两帧（间隔 500ms）：慢得离谱，但 500 > OUTLIER_MS，
     * 每一帧都被当异常丢掉，攒不满样本。这种情况多半是切后台，不是机器慢。
     */
    feed(h.guard, h.clock, 500, 30);
    expect(h.tiers).toEqual([]);
  });

  it("异常帧被丢掉，不会把中位数拖歪", () => {
    const h = build();
    // 先喂满一窗口的流畅帧，中间插一次 2 秒的长停顿（切后台 / GC）。
    feed(h.guard, h.clock, 16.7, 3.5);
    const frameStart = h.clock.t;
    h.clock.t += 2000;
    h.guard.sample(frameStart);
    feed(h.guard, h.clock, 16.7, 6);
    expect(h.tiers).toEqual([]);
  });

  it("没在玩的时候不采样，恢复后也不会因为那段空档误判", () => {
    const clock = { t: 1000 };
    let playing = false;
    let downgrades = 0;
    const guard = new QualityGuard({
      isPlaying: () => playing,
      onTier: () => { downgrades += 1; },
      now: () => clock.t,
    });
    // 停在开场页 30 秒：一帧都不该算进去。
    for (let i = 0; i < 200; i += 1) { const f = clock.t; clock.t += 150; guard.sample(f); }
    expect(downgrades).toBe(0);

    // 开始玩，而且跑得很流畅 —— 不该因为刚才那 30 秒被判成慢。
    playing = true;
    feed(guard, clock, 16.7, 20);
    expect(downgrades).toBe(0);
  });

  it("降过一次就永久收工，再慢也不会降第二次", () => {
    const h = build();
    feed(h.guard, h.clock, 50, 20);
    expect(h.tier).toBe(3);
    const seen = h.tiers.length;
    feed(h.guard, h.clock, 200, 40);
    expect(h.tiers.length).toBe(seen);   // 已经在最低档，不再有任何回调
  });

  /**
   * 最重的那一帧不在开局：第一夜从第 40 秒起一口气放三十几只狼。
   * 所以窗口必须是**反复**的 —— 判一次就收工的话，正好避开了要测的东西。
   */
  it("开局流畅、后来变慢，照样能降 —— 窗口是反复的", () => {
    const h = build();
    feed(h.guard, h.clock, 16.7, 30);   // 前 30 秒很流畅
    expect(h.tiers).toEqual([]);
    feed(h.guard, h.clock, 45, 20);     // 入夜之后掉到 22fps
    expect(h.tier).toBeGreaterThan(1);
  });

  it("jumpTo 直接跳档（调试开关），到底之后不再动", () => {
    const h = build();
    h.guard.jumpTo(3);
    expect(h.tiers).toEqual([3]);
    h.guard.jumpTo(3);
    expect(h.tiers).toEqual([3]);
  });

  it("只降不升：跳到三档之后，jumpTo(2) 不会把它抬回去", () => {
    const h = build();
    h.guard.jumpTo(3);
    h.guard.jumpTo(2);
    expect(h.tier).toBe(3);
    expect(h.tiers).toEqual([3]);
  });

  /**
   * 一次一档：只是"有点慢"的机器不该被一脚踹到最低档。
   * 30fps 在阈值（40fps）和"慢得离谱"（20fps）之间，正好落在这一格。
   */
  it("只是有点慢（30fps）时一次只降一档", () => {
    const h = build();
    feed(h.guard, h.clock, 1000 / 30, 8);
    expect(h.tiers[0]).toBe(2);
  });

  it("慢得离谱（15fps）时一次跳两档，不用等第二轮", () => {
    const h = build();
    feed(h.guard, h.clock, 1000 / 15, 6);
    expect(h.tiers).toEqual([3]);
  });

  /**
   * 第一轮窗口比后面短（2 秒 vs 4 秒）。
   *
   * 一档就是改造前的默认表现，顶着它跑没有额外风险；短窗口图的是让真正跟不上的
   * 机器早一秒进二档 —— 而开局那几十秒恰好最要紧。理由写在 QualityGuard 顶上。
   */
  it("首轮判定来得比后面早 —— 预热 3 秒 + 窗口 2 秒就出结果", () => {
    const h = build();
    feed(h.guard, h.clock, 50, 5.2);
    expect(h.tiers.length).toBeGreaterThan(0);
  });
});
