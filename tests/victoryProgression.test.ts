import { describe, expect, it } from "vitest";
import html from "../index.html?raw";
import { DIFFICULTIES } from "../src/game/simulation/difficulty";

describe("通关页 · 下一局入口", () => {
  it("直接提供简单、普通、困难三个按钮", () => {
    const targets = [...html.matchAll(/data-victory-difficulty="([^"]+)"/g)].map((match) => match[1]);
    expect(targets).toEqual(DIFFICULTIES);
  });

  it("难度选择组有可本地化的无障碍名称", () => {
    expect(html).toContain('class="victory-actions" role="group"');
    expect(html).toContain('data-i18n-attr="aria-label:win.chooseDifficulty"');
  });
});
