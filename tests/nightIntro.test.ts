import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSimulation } from "../src/game/simulation/GameSimulation";
import type { GameEvent } from "../src/game/simulation/types";
import { NightIntro } from "../src/ui/NightIntro";
import type { TutorialStage } from "../src/ui/TutorialStage";

const NIGHT_EVENT = { type: "phase", phase: "night", day: 1 } as GameEvent;
const HOLD_SECONDS = 3.4;

function makeIntro() {
  const camp = { id: 1, x: 12, z: -4 };
  const simulation = {
    player: { x: 0, z: 0 },
    world: { camps: [camp] },
  } as unknown as GameSimulation;
  const stage = {
    show: vi.fn(),
    setCaption: vi.fn(),
    setLit: vi.fn(),
    hide: vi.fn(),
  } as unknown as TutorialStage;
  const spotlight = vi.fn();
  const focusCamera = vi.fn();
  const setHold = vi.fn();
  const intro = new NightIntro({
    simulation, stage, spotlight, focusCamera, setHold, isTimerFrozen: () => false,
  });
  return { intro, camp, stage, spotlight, focusCamera, setHold };
}

afterEach(() => vi.unstubAllGlobals());

/*
 * 这一段从三拍二十秒砍成了一拍三秒半：推镜过去、说一句「点燃篝火」、收回来。
 *
 * 所以这里守的东西也跟着变了。原先要守"哪一拍冻时间、哪一拍恢复光照"那条边界，
 * 现在整段只有一个边界：**推镜期间世界冻着，镜头一收全部还给玩家**。
 * 顺带守住"没有第二拍"——一旦有人再把操作要求加回来，第一条就会红。
 */
describe("第一夜教学 · 一次推镜就结束", () => {
  it("推镜时冻住世界，到点收镜并把时间和光照一起还回去", () => {
    const ctx = makeIntro();
    ctx.intro.handle(NIGHT_EVENT);

    expect(ctx.focusCamera).toHaveBeenLastCalledWith(ctx.camp);
    expect(ctx.spotlight).toHaveBeenLastCalledWith(ctx.camp);
    expect(ctx.setHold).toHaveBeenLastCalledWith(true);
    expect(ctx.intro.active).toBe(true);

    ctx.intro.update(HOLD_SECONDS);

    expect(ctx.focusCamera).toHaveBeenLastCalledWith(null);
    expect(ctx.spotlight).toHaveBeenLastCalledWith(null);
    expect(ctx.setHold).toHaveBeenLastCalledWith(false);
    expect(ctx.intro.active).toBe(false);
  });

  it("整段只说一句话，不等玩家做任何操作", () => {
    const ctx = makeIntro();
    ctx.intro.handle(NIGHT_EVENT);
    ctx.intro.update(HOLD_SECONDS);

    expect(ctx.stage.setCaption).toHaveBeenCalledTimes(1);
    expect(ctx.stage.hide).toHaveBeenCalledTimes(1);
  });

  it("死亡立刻收摊，不会隔着结算页留一块压暗的 HUD", () => {
    const ctx = makeIntro();
    ctx.intro.handle(NIGHT_EVENT);
    ctx.intro.handle({ type: "game-over" } as GameEvent);

    expect(ctx.intro.active).toBe(false);
    expect(ctx.setHold).toHaveBeenLastCalledWith(false);
    expect(ctx.stage.hide).toHaveBeenCalled();
  });

  it("看过 v1 / v2 的玩家仍会看到这一版一次，播完写 v3", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => (key === "desert-survivor.nightIntro.v3" ? null : "1"),
        setItem,
      },
    });

    expect(NightIntro.shouldRun()).toBe(true);
    const ctx = makeIntro();
    ctx.intro.handle(NIGHT_EVENT);
    ctx.intro.update(HOLD_SECONDS);
    expect(setItem).toHaveBeenCalledWith("desert-survivor.nightIntro.v3", "1");
  });
});
