import { describe, it, expect } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import type { WolfState } from "../src/game/simulation/types";

/**
 * 教学犬掉 1 张兽皮 —— "夜袭狼什么都不掉"唯一的例外。
 *
 * 锁两头：教学犬**必须**掉，别的夜袭犬**必须不**掉。
 * 中间那条线松掉哪一边都不会报错，只会安静地改掉整条兽皮经济：
 * 往松了漏，第一夜就能凑齐兽皮衣（4 张），"白天出门打野狗"这条循环直接消失；
 * 往紧了漏，第一夜又回到熬 150 秒零回报。
 */
describe("教学犬掉落", () => {
  /** 起一夜、把狼刷出来，返回场上所有狼。 */
  function spawnFirstNight(): { sim: GameSimulation; wolves: WolfState[] } {
    const sim = new GameSimulation(createWorld());
    const inner = sim as unknown as { phase: string; phaseTime: number; clockStarted: boolean; running: boolean };
    sim.start();
    inner.phase = "night";
    inner.phaseTime = 150;
    inner.clockStarted = true;
    sim.enableWolves();
    const STEP = 1 / 20;
    // 刷怪倒计时是 0.45 秒起步，跑几十秒足够把第一夜的头几只放出来。
    for (let step = 0; step < 20 * 40; step += 1) {
      sim.player.health = 1_000_000;
      sim.player.water = 100;
      sim.player.hunger = 100;
      sim.update(STEP, { x: 0, z: 0 });
    }
    return { sim, wolves: sim.wolves };
  }

  it("第一夜第一只是教学犬，而且全场只有它一只", () => {
    const { wolves } = spawnFirstNight();
    const tutorial = wolves.filter((w) => w.tutorial);
    expect(tutorial).toHaveLength(1);
    // 写死的剧本：28 血 / 5 咬伤 / 0 防，不吃难度倍率也不吃夜晚成长曲线。
    expect(tutorial[0].maxHealth).toBe(28);
    expect(tutorial[0].attack).toBe(5);
  });

  it("教学犬掉 1 张兽皮，同夜其它夜袭犬一件不掉", () => {
    const { sim, wolves } = spawnFirstNight();
    const inner = sim as unknown as { drops: Array<{ kind: string }> };
    const tutorial = wolves.find((w) => w.tutorial)!;
    const others = wolves.filter((w) => !w.tutorial && w.role === "raider" && w.mode !== "dead");
    expect(others.length).toBeGreaterThan(0);

    // killWolf 住在 WolfDirector 上，GameSimulation 只在扣血归零时转调它。
    const director = (sim as unknown as { wolfDirector: { killWolf(w: WolfState): void } }).wolfDirector;

    const before = inner.drops.length;
    for (const wolf of others) director.killWolf(wolf);
    expect(inner.drops.length - before).toBe(0);

    director.killWolf(tutorial);
    const dropped = inner.drops.slice(before);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].kind).toBe("hide");
  });

  it("1 张凑不出任何一件护甲，所以经济没被动", () => {
    const { sim } = spawnFirstNight();
    // 一阶护甲（穿着"无"时能造的那些）里，最便宜的一件要几张皮？
    const cheapestHideCost = Math.min(...sim.getUpgradeOptions("armor")
      .map((tier) => tier.cost.find(([kind]) => kind === "hide")?.[1] ?? 0)
      .filter((cost) => cost > 0));
    expect(cheapestHideCost).toBeGreaterThan(1);
  });
});
