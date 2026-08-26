import { describe, it, expect } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import {
  CARRY_BASE_SCALE,
  FUEL_PERKS,
  FUEL_PERK_BY_ID,
  type FuelPerkId,
} from "../src/game/balance/fuelPerks";
import { FUEL_REQUIRED } from "../src/game/simulation/types";

/**
 * 搬油三选一。规格见 docs/搬油三选一-开发交接.md §10。
 *
 * 这一段在浏览器里验不了（预览面板的 document.hidden 恒为 true，帧循环不跑），
 * 而抽卡是**受控随机** —— 它的全部价值就在"同一个 seed 能复现"，
 * 那件事只有测试问得出来。
 */
describe("搬油三选一", () => {
  /** 直接把桶塞进车里，跳过搬运。返回这一次装完之后的 offer。 */
  const loadBarrel = (sim: GameSimulation): readonly FuelPerkId[] | null => {
    sim.notePerkFuelLoaded(sim.truck.loaded + 1, FUEL_REQUIRED);
    sim.truck.loaded += 1;
    return sim.getFuelPerkOffer();
  };
  const fresh = (): GameSimulation => {
    const sim = new GameSimulation(createWorld());
    sim.start();
    return sim;
  };
  /** 走完一整局五次选择，每次都选第一张。 */
  const playFive = (sim: GameSimulation): FuelPerkId[] => {
    const chosen: FuelPerkId[] = [];
    for (let n = 0; n < 5; n += 1) {
      const offer = loadBarrel(sim);
      expect(offer, `第 ${n + 1} 桶应该弹卡`).not.toBeNull();
      expect(sim.chooseFuelPerk(offer![0])).toBe(true);
      chosen.push(offer![0]);
    }
    return chosen;
  };

  it("装第 1~5 桶各弹一次，第 6 桶不弹", () => {
    const sim = fresh();
    playFive(sim);
    expect(sim.truck.loaded).toBe(5);
    // 第六桶：装完直接进上车发车，不能再弹 —— 那时给了也来不及用。
    expect(loadBarrel(sim)).toBeNull();
    expect(sim.truck.loaded).toBe(FUEL_REQUIRED);
  });

  it("选完就关，不选就一直挂着 —— 同一桶不会重复触发", () => {
    const sim = fresh();
    const offer = loadBarrel(sim);
    expect(offer).not.toBeNull();
    // 没选之前一直是同一组
    expect(sim.getFuelPerkOffer()).toEqual(offer);
    expect(sim.chooseFuelPerk(offer![0])).toBe(true);
    expect(sim.getFuelPerkOffer()).toBeNull();
  });

  it("同一个 seed 逐字复现 —— 抽卡走模拟层的随机源，不碰 Math.random", () => {
    const a = playFive(fresh());
    const b = playFive(fresh());
    expect(a).toEqual(b);
  });

  it("每组三张：不重名、不发满层卡、至少覆盖两条路线", () => {
    const sim = fresh();
    for (let n = 0; n < 5; n += 1) {
      const offer = loadBarrel(sim)!;
      expect(offer).toHaveLength(3);
      expect(new Set(offer).size, `第 ${n + 1} 组重名了：${offer}`).toBe(3);
      for (const id of offer) {
        expect(sim.fuelPerkStacks(id), `${id} 已满层还在发`)
          .toBeLessThan(FUEL_PERK_BY_ID[id].maxStacks);
      }
      const lines = new Set(offer.map((id) => FUEL_PERK_BY_ID[id].line));
      expect(lines.size, `第 ${n + 1} 组只有一条路线：${offer}`).toBeGreaterThanOrEqual(2);
      sim.chooseFuelPerk(offer[0]);
    }
  });

  it("不在本次 offer 里的 ID 一律拒绝 —— 层数上限是全部平衡的前提", () => {
    const sim = fresh();
    const offer = loadBarrel(sim)!;
    const outsider = FUEL_PERKS.map((p) => p.id).find((id) => !offer.includes(id))!;
    expect(sim.chooseFuelPerk(outsider)).toBe(false);
    expect(sim.fuelPerkStacks(outsider)).toBe(0);
    // 拒绝之后 offer 还在，玩家仍然要选
    expect(sim.getFuelPerkOffer()).toEqual(offer);
  });

  it("军用肩带：减的是惩罚不是加移速，三层仍明显慢于空手", () => {
    const sim = fresh();
    const expected = [0.540, 0.632, 0.706, 0.764];
    for (let stacks = 0; stacks <= 3; stacks += 1) {
      expect(sim.fuelPerks.carryScale()).toBeCloseTo(expected[stacks], 3);
      if (stacks < 3) sim.fuelPerks["stacks"].set("carry-rig", stacks + 1);
    }
    // 堆满也不能越过 1，否则"扛着桶比空手快"，整个搬运玩法就没了
    expect(sim.fuelPerks.carryScale()).toBeLessThan(1);
    expect(sim.fuelPerks.carryScale()).toBeGreaterThan(CARRY_BASE_SCALE);
  });

  it("加固内衬：最终防御 = 装备防御 + 2/层，而且不改 player.armor", () => {
    const sim = fresh();
    const base = sim.getDefense();
    const armorBefore = sim.player.armor;
    for (let stacks = 1; stacks <= 3; stacks += 1) {
      sim.fuelPerks["stacks"].set("armor-plate", stacks);
      expect(sim.getDefense()).toBe(base + stacks * 2);
    }
    expect(sim.player.armor).toBe(armorBefore);
  });

  it("调匀呼吸：+2/s/层是平坦加值，不吃护甲倍率", () => {
    const sim = fresh();
    for (let stacks = 0; stacks <= 3; stacks += 1) {
      sim.fuelPerks["stacks"].set("steady-breath", stacks);
      expect(sim.perkBonusStaminaRegen()).toBe(stacks * 2);
    }
  });

  it("后座补给：选中当下立即结算一次，之后每次装车继续结算", () => {
    const sim = fresh();
    sim.player.health = 40;
    sim.player.water = 40;
    sim.player.hunger = 40;
    // 手动把这张塞进 offer，免得依赖抽卡运气
    sim.fuelPerks["offer"] = ["truck-supplies"];
    expect(sim.chooseFuelPerk("truck-supplies")).toBe(true);
    // 选中那一刻就该看见回复，否则第一层表现成"选了但什么都没发生"
    expect(sim.player.health).toBeCloseTo(55, 3);
    expect(sim.player.water).toBeCloseTo(52, 3);
    expect(sim.player.hunger).toBeCloseTo(52, 3);

    sim.player.health = 40;
    loadBarrel(sim);
    expect(sim.player.health).toBeCloseTo(55, 3);
  });

  it("省着点吃：水分与饥饿同一个倍率，别只减一条", () => {
    const sim = fresh();
    expect(sim.perkDecayScale()).toBe(1);
    sim.fuelPerks["stacks"].set("rationing", 3);
    expect(sim.perkDecayScale()).toBeCloseTo(0.88 ** 3, 6);
  });

  it("五次选完仍能正常装第 6 桶", () => {
    const sim = fresh();
    playFive(sim);
    expect(loadBarrel(sim)).toBeNull();
    expect(sim.truck.loaded).toBe(FUEL_REQUIRED);
  });

  it("软重开：新的一局层数归零（GameSimulation 是重建的）", () => {
    const sim = fresh();
    playFive(sim);
    const total = FUEL_PERKS.reduce((n, p) => n + sim.fuelPerkStacks(p.id), 0);
    expect(total).toBe(5);
    const next = fresh();
    expect(FUEL_PERKS.reduce((n, p) => n + next.fuelPerkStacks(p.id), 0)).toBe(0);
    expect(next.getFuelPerkOffer()).toBeNull();
  });

  it("发 offer 和选卡各发一次事件，供表现层挂钩", () => {
    const sim = fresh();
    sim.drainEvents();
    const offer = loadBarrel(sim)!;
    const offered = sim.drainEvents().filter((e) => e.type === "fuel-perk-offer");
    expect(offered).toHaveLength(1);
    sim.chooseFuelPerk(offer[0]);
    const chosen = sim.drainEvents().filter((e) => e.type === "fuel-perk-chosen");
    expect(chosen).toHaveLength(1);
  });
});
