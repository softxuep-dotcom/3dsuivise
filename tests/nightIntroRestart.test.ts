import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import type { Vec2 } from "../src/game/simulation/types";
import { NightIntro } from "../src/ui/NightIntro";
import type { NightIntroDeps } from "../src/ui/NightIntro";
import type { TutorialStage } from "../src/ui/TutorialStage";

describe("第一夜教学 · 软重开", () => {
  it("每一拍都读取新局 simulation，不缓存构造时的旧局", () => {
    const oldRun = new GameSimulation(createWorld());
    const newRun = new GameSimulation(createWorld());
    expect(oldRun.getInventoryCount("wood")).toBeGreaterThan(0);
    newRun.player.inventory.fill(null);
    let current = oldRun;
    const deps: NightIntroDeps = {
      get simulation() { return current; },
      stage: {} as TutorialStage,
      spotlight: () => undefined,
      focusCamera: () => undefined,
      setHold: () => undefined,
      setActionLabel: () => undefined,
      isTimerFrozen: () => false,
    };
    const intro = new NightIntro(deps);
    const beats = (intro as unknown as {
      beats: Array<{ sub(): string; spot(): Vec2 | null }>;
    }).beats;

    current = newRun;
    expect(beats[1].sub()).toBe("night.fire.noWood");
    // 第 3 拍的 spot 原先是 () => simulation.player，兼任第二个探针；现在它改成
    // 常量 null（镜头收回玩家之后不再压暗全场，见 NightIntro 那两段注释），
    // 不再读 simulation，也就当不了探针 —— 上面那句 sub() 是本条不变量唯一的证据。
    expect(beats[2].spot()).toBeNull();
    expect(beats[1].spot()).toBeNull();
  });
});

/**
 * 教学门禁按**页面会话**记，不写 localStorage。
 *
 * 原先看过一次就永久熄灭，前提是「玩家记得住」。而实测平均每局约 143 秒 ——
 * 大部分人第一次根本没走完就离开了，隔几天回来那面旗还立着，于是永远看不到。
 */
describe("第一夜教学 · 门禁", () => {
  const makeIntro = () => {
    const sim = new GameSimulation(createWorld());
    // NightIntro 用到的全部舞台方法（grep deps.stage. 得到），少一个就是 TypeError。
    const stage = {
      show: () => undefined, hide: () => undefined, setCaption: () => undefined,
      setUrgent: () => undefined, setLit: () => undefined,
      setDots: () => undefined, buildDots: () => undefined, onSkip: () => undefined,
    } as unknown as TutorialStage;
    const intro = new NightIntro({
      get simulation() { return sim; },
      stage,
      spotlight: () => undefined,
      focusCamera: () => undefined,
      setHold: () => undefined,
      setActionLabel: () => undefined,
      isTimerFrozen: () => false,
    });
    return intro;
  };
  const NIGHT = { type: "phase", phase: "night", day: 1 } as never;

  it("同一次页面里只播一次：死了重开不再播", () => {
    const intro = makeIntro();
    expect(intro.shouldRun()).toBe(true);
    intro.handle(NIGHT);
    expect(intro.active).toBe(true);

    // 死了 → 软重启 → 又一次入夜。
    intro.reset();
    expect(intro.shouldRun()).toBe(false);
    intro.handle(NIGHT);
    expect(intro.active).toBe(false);
  });

  it("演到一半死掉，重开也不再播 —— 置位在 start 不在收尾", () => {
    const intro = makeIntro();
    intro.handle(NIGHT);
    intro.handle({ type: "game-over" } as never);

    intro.reset();
    expect(intro.shouldRun()).toBe(false);
    intro.handle(NIGHT);
    expect(intro.active).toBe(false);
  });

  it("重新打开页面（新实例）会再播一次", () => {
    const first = makeIntro();
    first.handle(NIGHT);
    expect(first.shouldRun()).toBe(false);

    const second = makeIntro();
    expect(second.shouldRun()).toBe(true);
    second.handle(NIGHT);
    expect(second.active).toBe(true);
  });
});
