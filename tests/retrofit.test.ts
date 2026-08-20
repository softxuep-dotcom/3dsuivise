import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import {
  FUEL_REQUIRED, RETROFIT_DRAW, RETROFIT_IDS, RETROFIT_LOG_SECONDS,
  RETROFIT_MEDKIT_HEAL, RETROFIT_SLOW_SCALE, RETROFIT_TRUCK_RADIUS,
} from "../src/game/simulation/types";

const STEP = 1 / 20;

/**
 * 卡车改装。
 *
 * 这个文件的存在意义是**证明六件改装都真的接上了线** —— 一个只改状态不改行为的
 * 升级系统，和没有这个系统是一回事，而且更糟：玩家花了一次选择的注意力换来空气。
 */
function started(): GameSimulation {
  const sim = new GameSimulation(createWorld());
  sim.start();
  for (let i = 0; i < 10; i += 1) { sim.update(STEP, { x: 1, z: 0 }); sim.drainEvents(); }
  return sim;
}

describe("卡车改装", () => {
  it("抽三选一：只抽没拥有的，池子见底就少给", () => {
    const sim = started() as any;
    const seen = new Set<string>();
    for (let round = 0; round < RETROFIT_IDS.length; round += 1) {
      const options: string[] = sim.drawRetrofits();
      expect(options.length).toBe(Math.min(RETROFIT_DRAW, RETROFIT_IDS.length - seen.size));
      expect(new Set(options).size, "同一次抽到重复项").toBe(options.length);
      for (const id of options) expect(seen.has(id), `${id} 已经拥有还被抽出来`).toBe(false);
      if (!options.length) break;
      sim.chooseRetrofit(options[0]);
      seen.add(options[0]);
    }
    expect(sim.drawRetrofits()).toEqual([]);
  });

  it("chooseRetrofit 拒绝重复与非法 id", () => {
    const sim = started();
    expect(sim.chooseRetrofit("fuel-can")).toBe(true);
    expect(sim.chooseRetrofit("fuel-can"), "重复领取").toBe(false);
    expect(sim.chooseRetrofit("nope" as never), "非法 id").toBe(false);
  });

  it("备用油罐：单根柴 95s → 130s", () => {
    for (const [label, own, expected] of [["无改装", false, 95], ["备用油罐", true, RETROFIT_LOG_SECONDS]] as const) {
      const sim = started() as any;
      if (own) sim.chooseRetrofit("fuel-can");
      const camp = sim.camps[sim.world.startCampId];
      camp.fuel = 0;
      sim.addInventory("wood", 1);
      // 走到篝火旁添柴
      const hearth = sim.world.camps[sim.world.startCampId];
      sim.player.x = hearth.x; sim.player.z = hearth.z;
      sim.requestInteraction();
      sim.update(STEP, { x: 0, z: 0 });
      expect(Math.round(camp.fuel), `${label} 的单根柴时长不对`).toBe(expected);
    }
  });

  it("加固车厢：卡车附近狼减速，远处不减", () => {
    const sim = started() as any;
    const truck = sim.truck;
    expect(sim.getWolfSpeedScaleAt(truck.x, truck.z), "没装时不该减速").toBe(1);
    sim.chooseRetrofit("reinforced-bed");
    expect(sim.getWolfSpeedScaleAt(truck.x, truck.z)).toBe(RETROFIT_SLOW_SCALE);
    expect(sim.getWolfSpeedScaleAt(truck.x + RETROFIT_TRUCK_RADIUS + 5, truck.z), "半径外不该减速").toBe(1);
  });

  it("磨刃石：攻击冷却变短", () => {
    const cooldownOf = (own: boolean): number => {
      const sim = started();
      if (own) sim.chooseRetrofit("whetstone");
      sim.requestAttack();
      sim.update(STEP, { x: 0, z: 0 });
      return sim.player.attackCooldown;
    };
    const plain = cooldownOf(false);
    const sharp = cooldownOf(true);
    expect(sharp, "装了磨刃石冷却没变短").toBeLessThan(plain);
  });

  it("急救包：血跌破 30% 自动回血，且只触发一次", () => {
    const sim = started();
    sim.chooseRetrofit("med-kit");
    sim.player.health = 20;
    sim.update(STEP, { x: 0, z: 0 });
    expect(sim.player.health).toBeGreaterThan(20 + RETROFIT_MEDKIT_HEAL - 5);
    sim.player.health = 20;
    sim.update(STEP, { x: 0, z: 0 });
    expect(sim.player.health, "急救包触发了第二次").toBeLessThan(25);
  });

  it("装车发三选一，装满那一桶不发", () => {
    const sim = started() as any;
    let offers = 0;
    for (let n = 1; n <= FUEL_REQUIRED; n += 1) {
      sim.truck.loaded = n - 1;
      sim.carriedBarrel = sim.world.barrels[n - 1];
      sim.player.carrying = "fuel";
      sim.loadCarriedBarrel();
      for (const e of sim.drainEvents()) {
        if (e.type === "retrofit-offer") {
          offers += 1;
          expect(e.options.length).toBeGreaterThan(0);
          sim.chooseRetrofit(e.options[0]);
        }
      }
    }
    // 前 5 桶各发一次，第 6 桶（装满）不发；池子只有 6 件，够用
    expect(offers).toBe(FUEL_REQUIRED - 1);
  });
});
