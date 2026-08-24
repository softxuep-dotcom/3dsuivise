import { describe, it, expect } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import { FirstBarrelHint } from "../src/ui/FirstBarrelHint";
import type { Vec2 } from "../src/game/simulation/types";

/**
 * 出生点那桶油的提示灯。
 *
 * 这一段没法在浏览器里验 —— 预览面板不合成帧，requestAnimationFrame 不跑，
 * 而这盏灯的全部逻辑都活在每帧的 update 里。所以判据只能写成测试。
 *
 * 锁住的是**触发条件**，不是亮度或时长：什么时候该点、什么时候绝对不能点。
 * 后者（4 秒、8 米）是可调的手感数字，改它们不该让测试红。
 */
describe("出生点油桶提示灯", () => {
  const STEP = 1 / 20;

  /** 造一局，并把提示灯挂上。返回的 lit 永远是"此刻灯在照谁"。 */
  const build = (preStartSeconds = 3): {
    sim: GameSimulation;
    hint: FirstBarrelHint;
    lit: () => Vec2 | null;
    barrel: { x: number; z: number; placement: string };
    /** 朝远离桶的方向走 seconds 秒。 */
    walkAway: (seconds: number) => void;
    /** 原地站着推进 seconds 秒（灯的计时照走）。 */
    idle: (seconds: number) => void;
  } => {
    const sim = new GameSimulation(createWorld());
    let lit: Vec2 | null = null;
    const hint = new FirstBarrelHint({
      get simulation() { return sim; },
      spotlight: (target) => { lit = target; },
    });
    /*
     * **真机上的次序**，所有用例都从这里开始：reset() 在 bootstrap 那一刻就跑完，
     * 而 simulation.start() 要等玩家第一次真的动一下（main.ts 的 enterGame）。
     * 中间玩家还没动的那些帧，frame() 照样每帧在调 hint.update()。
     *
     * 这一段不是摆设：第一版的灯就是死在这里 —— 它把"还没开始"和"已经结束"
     * 一起当成"这局没戏了"，开场第一帧就熄了火，真机上一次都没亮过。
     * 而老的 harness 先 start() 再 reset()，恰好把唯一出事的那一段跳了过去。
     */
    hint.reset();
    for (let t = 0; t < preStartSeconds / STEP; t += 1) hint.update(STEP);
    sim.start();
    // reset() 认的是"离玩家最近的那桶地面油" —— 也就是教学桶（2.2 米）。
    const barrel = sim.barrels.reduce((best, b) => (
      Math.hypot(b.x - sim.player.x, b.z - sim.player.z)
        < Math.hypot(best.x - sim.player.x, best.z - sim.player.z) ? b : best
    ));
    const away = (): Vec2 => {
      const dx = sim.player.x - barrel.x;
      const dz = sim.player.z - barrel.z;
      const m = Math.hypot(dx, dz) || 1;
      return { x: dx / m, z: dz / m };
    };
    return {
      sim,
      hint,
      lit: () => lit,
      barrel,
      walkAway: (seconds) => {
        for (let t = 0; t < seconds / STEP; t += 1) {
          sim.update(STEP, away());
          hint.update(STEP);
        }
      },
      idle: (seconds) => {
        for (let t = 0; t < seconds / STEP; t += 1) {
          sim.update(STEP, { x: 0, z: 0 });
          hint.update(STEP);
        }
      },
    };
  };

  it("站在出生点没走远时不点灯", () => {
    const g = build();
    g.idle(6);
    expect(g.lit()).toBeNull();
  });

  it("走开之后点灯，而且照的就是那桶油", () => {
    const g = build();
    g.walkAway(4);
    const lit = g.lit();
    expect(lit).not.toBeNull();
    // 照的是桶本身，不是玩家、不是卡车。
    expect(Math.hypot(lit!.x - g.barrel.x, lit!.z - g.barrel.z)).toBeLessThan(0.01);
    // 触发时人确实已经走开了（阈值 8 米，这里只验数量级，别把常量抄进来）。
    expect(Math.hypot(g.sim.player.x - g.barrel.x, g.sim.player.z - g.barrel.z)).toBeGreaterThan(6);
  });

  it("过一会自己灭", () => {
    const g = build();
    g.walkAway(4);
    expect(g.lit()).not.toBeNull();
    g.idle(8);
    expect(g.lit()).toBeNull();
  });

  it("灭了之后不再点第二次 —— 它是提醒，不是催促", () => {
    const g = build();
    g.walkAway(4);
    g.idle(8);
    expect(g.lit()).toBeNull();
    g.walkAway(4);
    expect(g.lit()).toBeNull();
  });

  it("已经扛起桶的人不会被点灯", () => {
    const g = build();
    // 开局第一下行动键就是"扛桶"（教学桶在 2.2 米，FUEL_PICKUP_REACH 是 2.6）。
    g.sim.requestInteraction();
    expect(g.sim.player.carrying).toBe("fuel");
    g.walkAway(4);
    expect(g.lit()).toBeNull();
  });

  it("开局盯着屏幕没动的那些帧，不该把这一局的灯提前熄掉", () => {
    // 加载完到玩家第一次输入之间可以隔很久（读目标行、看地形、切出去接个电话）。
    // 那段时间 simulation.running 一直是 false，但它的含义是"还没开始"，不是"结束了"。
    const g = build(20);
    g.walkAway(4);
    expect(g.lit()).not.toBeNull();
  });

  it("重开之后能重新点一次", () => {
    const g = build();
    g.walkAway(4);
    g.idle(8);
    g.hint.reset();
    expect(g.lit()).toBeNull();
    g.walkAway(4);
    expect(g.lit()).not.toBeNull();
  });
});
