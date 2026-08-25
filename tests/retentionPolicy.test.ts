import { describe, expect, it } from "vitest";
import html from "../index.html?raw";
import { isRunWorthReviving, shouldBreakBeforeRestart } from "../src/ui/RetentionPolicy";

const run = (overrides: Partial<{
  day: number;
  loaded: number;
  weapon: "survival-knife" | "saber-1";
  armor: "none" | "hide-1";
}> = {}) => ({
  day: overrides.day ?? 1,
  truck: { loaded: overrides.loaded ?? 0 },
  player: {
    weapon: overrides.weapon ?? "survival-knife",
    armor: overrides.armor ?? "none",
  },
});

describe("死亡后留存策略", () => {
  it("开局空手死亡不展示激励复活", () => {
    expect(isRunWorthReviving(run())).toBe(false);
  });

  it.each([
    ["活到第二天", run({ day: 2 })],
    ["已经装油", run({ loaded: 1 })],
    ["已经造武器", run({ weapon: "saber-1" })],
    ["已经造护甲", run({ armor: "hide-1" })],
  ])("%s 时值得提供复活", (_label, candidate) => {
    expect(isRunWorthReviving(candidate)).toBe(true);
  });

  it("第一次重开免插屏，第二次起恢复平台控频", () => {
    expect(shouldBreakBeforeRestart(1)).toBe(false);
    expect(shouldBreakBeforeRestart(2)).toBe(true);
    expect(shouldBreakBeforeRestart(3)).toBe(true);
  });

  it("死亡页把重开和复活动作放在长报告之前，且重开排第一", () => {
    const actions = html.indexOf('class="game-over-actions"');
    const restart = html.indexOf('id="restart-button"');
    const revive = html.indexOf('id="revive-button"');
    const report = html.indexOf('class="death-report"');
    expect(actions).toBeGreaterThan(-1);
    expect(actions).toBeLessThan(report);
    expect(restart).toBeLessThan(revive);
    expect(revive).toBeLessThan(report);
  });
});
