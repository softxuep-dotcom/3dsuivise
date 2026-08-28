import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";

const STEP = 1 / 20;

/**
 * 死亡判定的常驻验收。
 *
 * 写这个文件之前，**整套测试里没有一条断言过玩家会死** —— `simHarness` 只有
 * `keepPlayerAlive`（作用相反）。而死亡是这个游戏最核心的判定：它决定结算页、
 * 决定激励视频复活的入口、决定平台统计里那条时长曲线。
 *
 * 起因是一次探针撞出来的：手动把血置成精确的 0，游戏不死。根因是 updateNeeds
 * 里那条"吃饱喝足抵掉流失"的净回复跑在 update 末尾的死亡判定之前，把血抬到
 * +0.018，`health <= 0` 于是不成立。实战够不着（狼一口 18~20，血只会越过 0
 * 掉进负数），但顺序本身是错的，已经加闸修掉，这里把它锁住。
 */
describe("死亡判定", () => {
  /** 起一局并把时钟闸打开（clockStarted 要玩家真的迈过一步）。 */
  function started(): GameSimulation {
    const sim = new GameSimulation(createWorld());
    sim.start();
    for (let i = 0; i < 10; i += 1) { sim.update(STEP, { x: 1, z: 0 }); sim.drainEvents(); }
    return sim;
  }

  it("血正好归零也要死 —— 回复不许把人从死亡线上拽回来", () => {
    const sim = started();
    sim.player.health = 0;
    sim.update(STEP, { x: 0, z: 0 });
    const events = sim.drainEvents();
    expect(
      events.map((e) => e.type),
      "血 = 0 却没发 game-over：多半是又有哪条回复排在了死亡判定前面",
    ).toContain("game-over");
    expect(events.find((event) => event.type === "game-over")).toMatchObject({
      cause: "exhausted",
      condition: "normal",
      killer: null,
    });
    expect(sim.running).toBe(false);
    expect(sim.player.health).toBe(0);
  });

  it("休息中血归零同样要死", () => {
    const sim = started();
    // 休息有六道闸（中暑/失温/饿/渴/夜里体温低/刚挨打），这里只留"站定 3 秒"那一道，
    // 其余先满足掉 —— 这条用例要测的是回复与死亡判定的先后，不是休息条件本身。
    sim.player.warmth = 50;
    sim.player.hunger = 80;
    sim.player.water = 80;
    // 还要"有东西可回"：canRest 里的 wantsRecovery 看的是血或劳力没满。
    sim.player.health = 50;
    for (let i = 0; i < 100; i += 1) {
      sim.update(STEP, { x: 0, z: 0 });
      sim.drainEvents();
      sim.player.warmth = 50;
    }
    expect(sim.getRestBlocker(), "没进入休息状态，这条用例就没测到东西").toBeNull();
    expect(sim.player.resting).toBe(true);
    sim.player.health = 0;
    sim.update(STEP, { x: 0, z: 0 });
    expect(sim.drainEvents().map((e) => e.type)).toContain("game-over");
    expect(sim.running).toBe(false);
  });

  it.each([
    ["water", "dehydrated"],
    ["hunger", "starved"],
  ] as const)("%s 归零立即死，死因报 %s", (axis, cause) => {
    const sim = started();
    sim.player[axis] = 0;
    sim.update(STEP, { x: 0, z: 0 });
    expect(sim.drainEvents().map((e) => e.type)).toContain("game-over");
    expect(sim.deathCause).toBe(cause);
  });

  it("旧战斗锁还亮着时，自然流失补掉最后一点体力仍报 exhausted", () => {
    const sim = started();
    // combatTimer 只是“多久不能休息”，不是伤害来源。旧实现拿它猜死因，会误报 killed。
    (sim as unknown as { combatTimer: number }).combatTimer = 6;
    sim.player.health = 0;
    sim.player.condition = "heatstroke";
    sim.player.warmth = 100;
    sim.update(STEP, { x: 0, z: 0 });
    const event = sim.drainEvents().find((candidate) => candidate.type === "game-over");
    expect(event).toMatchObject({ cause: "exhausted", condition: "heatstroke", killer: null });
    expect(sim.deathCause).toBe("exhausted");
  });

  /**
   * 真实路径：不碰任何内部状态，让狗把人咬死。
   *
   * 交接文档量过的死亡时刻是 86~141 秒（七种画像全灭于第一夜），
   * 上限放到 400 秒 —— 这条测的是"死亡这件事会不会发生"，不是具体几秒，
   * 免得每次调数值就误报。
   *
   * **两条需求轴每帧顶满**，因为初始饱食压到 40 之后饿死线落在 95.2 秒 ——
   * 正好插进上面那个 86~141 秒的窗口中间，会把这条测试从"狗咬死"变成"饿死"。
   * 这里要验的是**死因归因**（killed + killer 种类），不是"哪种威胁先到"，
   * 所以把饥渴这条路堵掉，只留下狗。血量一个字不碰 —— 那才是被测对象。
   * "不吃东西会饿死"由下面那条单独守。
   */
  it("第一夜会被狗咬死，且死因是 killed", () => {
    const sim = new GameSimulation(createWorld());
    sim.start(); sim.enableWolves(); sim.enableCritters();
    let died = false;
    let seconds = 0;
    for (let i = 0; i < 400 * 20 && !died; i += 1) {
      sim.player.hunger = 100;
      sim.player.water = 100;
      sim.update(STEP, { x: Math.cos(seconds * 0.3), z: Math.sin(seconds * 0.3) });
      seconds += STEP;
      for (const event of sim.drainEvents()) if (event.type === "game-over") died = true;
    }
    expect(died, `跑满 ${seconds.toFixed(0)} 秒还没死，血 ${sim.player.health.toFixed(1)}`).toBe(true);
    expect(sim.deathCause).toBe("killed");
    expect(["small", "large", "elite"]).toContain(sim.deathKiller);
    expect(sim.running).toBe(false);
  }, 60000);

  /**
   * 从不开背包的玩家会在第一夜饿死 —— **这是初始饱食 40 存在的全部理由。**
   *
   * 上一版初始饱食 90，饿死线在 214 秒，而 1.1.33 实测平均每局只有约 143 秒：
   * 这一课排在了观众散场之后，`r1/pack` 因此常年停在 55%。压到 40 之后
   * 预警在 52.4 秒（第一天刚结束、目标行让位的接缝上）、饿死在 95.2 秒，
   * 都稳稳落在一局之内。
   *
   * 关掉狼和猎物，让饥饿成为唯一的死因；不然就是在重测上面那条。
   */
  it("从不吃东西的玩家在 100 秒内饿死", () => {
    // started() 会先迈十步把时钟闸打开 —— 不动的话 running 是 false，
    // update() 直接 return，五条轴一格都不掉，这条测试会永远跑不完。
    // 那十步也计入下面的耗时，所以判定窗口比 95.2 秒略宽一点。
    const sim = started();
    let seconds = 10 * STEP;
    let cause: string | null = null;
    for (let i = 0; i < 200 * 20 && !cause; i += 1) {
      sim.update(STEP, { x: 0, z: 0 });
      seconds += STEP;
      for (const event of sim.drainEvents()) {
        if (event.type === "game-over") cause = sim.deathCause;
      }
    }
    expect(cause, `跑满 ${seconds.toFixed(0)} 秒还没死`).toBe("starved");
    // 40 / 0.42 = 95.2 秒。留一点余量给帧步长，但必须远小于平均每局 143 秒。
    expect(seconds).toBeGreaterThan(90);
    expect(seconds).toBeLessThan(100);
  }, 60000);
});
