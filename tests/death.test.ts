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
    expect(
      sim.drainEvents().map((e) => e.type),
      "血 = 0 却没发 game-over：多半是又有哪条回复排在了死亡判定前面",
    ).toContain("game-over");
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

  /**
   * 真实路径：不碰任何内部状态，让狗把人咬死。
   *
   * 交接文档量过的死亡时刻是 86~141 秒（七种画像全灭于第一夜），
   * 上限放到 400 秒 —— 这条测的是"死亡这件事会不会发生"，不是具体几秒，
   * 免得每次调数值就误报。
   */
  it("第一夜会被狗咬死，且死因是 killed", () => {
    const sim = new GameSimulation(createWorld());
    sim.start(); sim.enableWolves(); sim.enableCritters();
    let died = false;
    let seconds = 0;
    for (let i = 0; i < 400 * 20 && !died; i += 1) {
      sim.update(STEP, { x: Math.cos(seconds * 0.3), z: Math.sin(seconds * 0.3) });
      seconds += STEP;
      for (const event of sim.drainEvents()) if (event.type === "game-over") died = true;
    }
    expect(died, `跑满 ${seconds.toFixed(0)} 秒还没死，血 ${sim.player.health.toFixed(1)}`).toBe(true);
    expect(sim.deathCause).toBe("killed");
    expect(sim.running).toBe(false);
  }, 60000);
});
