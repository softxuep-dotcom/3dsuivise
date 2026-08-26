import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import type { InventoryItemKind } from "../src/game/simulation/types";

type Materials = Partial<Record<InventoryItemKind, number>>;

function simulationWith(materials: Materials, litFire = false): GameSimulation {
  const simulation = new GameSimulation(createWorld());
  simulation.start();
  simulation.player.inventory.fill(null);
  Object.entries(materials).forEach(([kind, count], index) => {
    if (!count) return;
    simulation.player.inventory[index] = { kind: kind as InventoryItemKind, count };
    simulation.onItemAcquired(kind as InventoryItemKind);
  });
  if (litFire) {
    const camp = simulation.world.camps[simulation.world.startCampId];
    simulation.player.x = camp.x;
    simulation.player.z = camp.z;
    simulation.camps[camp.id].fuel = 999;
  }
  simulation.drainEvents();
  return simulation;
}

const ids = (simulation: GameSimulation, slot: "weapon" | "armor"): string[] =>
  simulation.getCraftableUpgrades(slot).map((tier) => tier.id);

describe("HUD 装备快捷制作候选", () => {
  it("只返回材料与火源都已满足的具体装备", () => {
    const remoteWeapon = simulationWith({ hide: 1, wood: 2 });
    expect(ids(remoteWeapon, "weapon")).toEqual(["sword-1"]);
    expect(ids(remoteWeapon, "armor")).toEqual([]);

    const hideArmor = simulationWith({ hide: 4 });
    expect(ids(hideArmor, "armor")).toEqual(["hide-1"]);
  });

  it("需要锻火的铁线只有站在燃烧营地旁才出现", () => {
    const simulation = simulationWith({ "iron-ore": 4 });
    expect(ids(simulation, "weapon")).toEqual([]);
    expect(ids(simulation, "armor")).toEqual([]);

    const camp = simulation.world.camps[simulation.world.startCampId];
    simulation.player.x = camp.x;
    simulation.player.z = camp.z;
    simulation.camps[camp.id].fuel = 999;
    expect(ids(simulation, "weapon")).toEqual(["saber-1"]);
    expect(ids(simulation, "armor")).toEqual(["scale-1"]);
  });

  it("同槽两条路线都可造时把两件都交给 UI，不擅自替玩家选线", () => {
    const simulation = simulationWith({ "iron-ore": 4, hide: 1, wood: 2 }, true);
    expect(ids(simulation, "weapon")).toEqual(["saber-1", "sword-1"]);
  });

  it("点击候选后仍走权威制作入口：扣料、装备、发事件并移除旧候选", () => {
    const weapon = simulationWith({ hide: 1, wood: 2 });
    expect(weapon.craftEquip("weapon", "sword-1")).toBe(true);
    expect(weapon.player.weapon).toBe("sword-1");
    expect(weapon.getInventoryCount("hide")).toBe(0);
    expect(weapon.getInventoryCount("wood")).toBe(0);
    expect(ids(weapon, "weapon")).toEqual([]);
    expect(weapon.drainEvents().map((event) => event.type)).toContain("craft-weapon");

    const armor = simulationWith({ hide: 4 });
    expect(armor.craftEquip("armor", "hide-1")).toBe(true);
    expect(armor.player.armor).toBe("hide-1");
    expect(armor.getInventoryCount("hide")).toBe(0);
    expect(ids(armor, "armor")).toEqual([]);
    expect(armor.drainEvents().map((event) => event.type)).toContain("craft-coat");
  });
});
