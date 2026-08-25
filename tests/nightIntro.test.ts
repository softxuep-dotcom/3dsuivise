import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSimulation } from "../src/game/simulation/GameSimulation";
import type { GameEvent } from "../src/game/simulation/types";
import { NightIntro } from "../src/ui/NightIntro";
import type { TutorialStage } from "../src/ui/TutorialStage";

const NIGHT_EVENT = { type: "phase", phase: "night", day: 1 } as GameEvent;

function makeIntro() {
  const camp = { id: 1, x: 12, z: -4 };
  let fireLit = false;
  let warmed = false;
  const simulation = {
    player: { x: 0, z: 0 },
    world: { camps: [camp] },
    getInventoryCount: () => 1,
    getNearestLitCamp: () => (fireLit ? camp : null),
    isWarmedByFire: () => warmed,
  } as unknown as GameSimulation;
  const stage = {
    onSkip: vi.fn(),
    buildDots: vi.fn(),
    show: vi.fn(),
    setCaption: vi.fn(),
    setDots: vi.fn(),
    setUrgent: vi.fn(),
    setLit: vi.fn(),
    hide: vi.fn(),
  } as unknown as TutorialStage;
  const spotlight = vi.fn();
  const focusCamera = vi.fn();
  const setHold = vi.fn();
  const setActionLabel = vi.fn();
  const intro = new NightIntro({
    simulation,
    stage,
    spotlight,
    focusCamera,
    setHold,
    setActionLabel,
    isTimerFrozen: () => false,
  });
  return {
    intro,
    camp,
    spotlight,
    focusCamera,
    setHold,
    lightFire: () => { fireLit = true; },
    setWarmed: () => { warmed = true; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("第一夜教学 · 镜头、时间与光照边界", () => {
  it("只在镜头推向营地时冻结时间，镜头返回便恢复时间和正常光照", () => {
    const ctx = makeIntro();
    ctx.intro.handle(NIGHT_EVENT);

    expect(ctx.focusCamera).toHaveBeenLastCalledWith(ctx.camp);
    expect(ctx.setHold).toHaveBeenLastCalledWith(true);

    ctx.intro.update(3.4);
    expect(ctx.focusCamera).toHaveBeenLastCalledWith(null);
    expect(ctx.setHold).toHaveBeenLastCalledWith(false);

    ctx.spotlight.mockClear();
    ctx.intro.update(0.016);
    expect(ctx.spotlight).toHaveBeenLastCalledWith(null);
  });

  it("点火与取暖阶段都保持正常光照，不再把玩家压回黑暗", () => {
    const ctx = makeIntro();
    ctx.intro.handle(NIGHT_EVENT);
    ctx.intro.update(3.4);

    ctx.spotlight.mockClear();
    ctx.lightFire();
    ctx.intro.update(0.9);
    ctx.setWarmed();
    ctx.intro.update(0.1);

    expect(ctx.spotlight).toHaveBeenCalled();
    expect(ctx.spotlight.mock.calls.every(([target]) => target === null)).toBe(true);
    expect(ctx.setHold).toHaveBeenLastCalledWith(false);
  });

  it("旧版 v1 标记不会吞掉修正版，并在播完后写入 v2 标记", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => key === "desert-survivor.nightIntro.v1" ? "1" : null,
        setItem,
      },
    });

    expect(NightIntro.shouldRun()).toBe(true);
    const ctx = makeIntro();
    ctx.intro.handle(NIGHT_EVENT);
    ctx.intro.update(46);
    expect(setItem).toHaveBeenCalledWith("desert-survivor.nightIntro.v2", "1");
  });
});
