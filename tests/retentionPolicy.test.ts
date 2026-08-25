import { describe, expect, it } from "vitest";
import html from "../index.html?raw";
import mainSource from "../src/main.ts?raw";
import { shouldBreakBeforeRestart } from "../src/ui/RetentionPolicy";

describe("死亡后留存策略", () => {
  it("每次死亡都直接进入死亡页并尝试展示广告复活", () => {
    expect(mainSource).toContain('if (event.type === "game-over") offerRevive();');
    expect(mainSource).toContain("if (!platform.supportsRewarded) return;");
    expect(mainSource).not.toContain("deathsThisSession");
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
