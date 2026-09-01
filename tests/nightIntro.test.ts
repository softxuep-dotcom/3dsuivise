import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSimulation } from "../src/game/simulation/GameSimulation";
import type { GameEvent } from "../src/game/simulation/types";
import { NightIntro, HOLD_SECONDS } from "../src/ui/NightIntro";
import type { TutorialStage } from "../src/ui/TutorialStage";

const NIGHT_EVENT = { type: "phase", phase: "night", day: 1 } as GameEvent;
// 从被测模块导入，不再本地抄一份 —— 抄的那份刚在 3.4 → 3.9 时悄悄漂移过，
// 四条测试一起红，而错的是测试不是实现。

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
  const setActionLabel = vi.fn();
  const intro = new NightIntro({
    simulation, stage, spotlight, focusCamera, setHold, setActionLabel,
    isTimerFrozen: () => false,
  });
  return { intro, camp, stage, spotlight, focusCamera, setHold, setActionLabel };
}

afterEach(() => vi.unstubAllGlobals());

describe("推镜期间的行动键", () => {
  /**
   * 镜头在营火上时玩家看不见自己，屏幕上唯一还认得出的交互物就是那颗行动键 ——
   * 它得当场写着「点燃」并且呼吸，而不是等镜头收回来让玩家自己猜。
   *
   * 还原必须和收镜头**同一刻**：镜头回到玩家身上，那颗键就该变回通用的「行动」。
   */
  it("推镜时写「点燃」并点亮，收镜头时一起还原", () => {
    const ctx = makeIntro();
    ctx.intro.handle(NIGHT_EVENT);

    expect(ctx.setActionLabel).toHaveBeenLastCalledWith({ action: "ignite", text: { key: "night.lightFire" } });
    expect(ctx.stage.setLit).toHaveBeenLastCalledWith(["action-button"]);

    ctx.intro.update(HOLD_SECONDS);
    expect(ctx.setActionLabel).toHaveBeenLastCalledWith(null);
    expect(ctx.stage.setLit).toHaveBeenLastCalledWith([]);
    expect(ctx.focusCamera).toHaveBeenLastCalledWith(null);
  });

  it("半路死掉也要还原 —— 否则那颗键永远写着「点燃」", () => {
    const ctx = makeIntro();
    ctx.intro.handle(NIGHT_EVENT);
    ctx.intro.update(HOLD_SECONDS / 2);
    ctx.intro.handle({ type: "game-over" } as GameEvent);

    expect(ctx.setActionLabel).toHaveBeenLastCalledWith(null);
    expect(ctx.stage.setLit).toHaveBeenLastCalledWith([]);
  });
});

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

  /**
   * 这段教学**按页面会话记，不写 localStorage**。
   *
   * 原先看过一次就永久熄灭，前提是「玩家记得住」。而平均每局约 143 秒、
   * r1/pack 只有 55~60% —— 大部分人第一次根本没走完就走了，隔几天回来
   * 那面旗还立着，于是他永远看不到这段教学。
   */
  it("同一次页面里只播一次：死了重开不再播", () => {
    const ctx = makeIntro();
    expect(ctx.intro.shouldRun()).toBe(true);

    ctx.intro.handle(NIGHT_EVENT);
    expect(ctx.intro.active).toBe(true);
    ctx.intro.update(HOLD_SECONDS);
    expect(ctx.intro.active).toBe(false);

    // 死了 → 软重启 → 又一次入夜：不该再播。
    ctx.intro.reset();
    expect(ctx.intro.shouldRun()).toBe(false);
    ctx.intro.handle(NIGHT_EVENT);
    expect(ctx.intro.active).toBe(false);
  });

  it("在推镜半路死掉，重开也不再播 —— 置位在 start 不在 finish", () => {
    const ctx = makeIntro();
    ctx.intro.handle(NIGHT_EVENT);
    ctx.intro.update(HOLD_SECONDS / 2);   // 只走了一半
    ctx.intro.handle({ type: "game-over" } as GameEvent);

    ctx.intro.reset();
    expect(ctx.intro.shouldRun()).toBe(false);
    ctx.intro.handle(NIGHT_EVENT);
    expect(ctx.intro.active).toBe(false);
  });

  it("重新打开页面（新实例）会再播一次", () => {
    const first = makeIntro();
    first.intro.handle(NIGHT_EVENT);
    first.intro.update(HOLD_SECONDS);
    expect(first.intro.shouldRun()).toBe(false);

    // 刷新页面 = 新的 NightIntro 实例。
    const second = makeIntro();
    expect(second.intro.shouldRun()).toBe(true);
    second.intro.handle(NIGHT_EVENT);
    expect(second.intro.active).toBe(true);
  });
});
