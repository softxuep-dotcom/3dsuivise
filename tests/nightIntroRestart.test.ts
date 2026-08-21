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
    expect(beats[2].spot()).toBe(newRun.player);
  });
});

