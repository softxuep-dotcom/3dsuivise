import { describe, expect, it } from "vitest";
import { createWorld, pickStartCamp } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import { distance } from "../src/game/simulation/geometry";
import { isTerrainWalkable, terrainSlopeAt } from "../src/game/terrain/TerrainModel";

const STEP = 1 / 20;

const advance = (simulation: GameSimulation, seconds: number): void => {
  for (let elapsed = 0; elapsed < seconds - 0.0001; elapsed += STEP) {
    simulation.update(STEP, { x: 0, z: 0 });
  }
};

const pointToSegment = (
  point: { x: number; z: number },
  start: { x: number; z: number },
  end: { x: number; z: number },
): number => {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = Math.max(0.0001, dx * dx + dz * dz);
  const amount = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared,
  ));
  return Math.hypot(point.x - (start.x + dx * amount), point.z - (start.z + dz * amount));
};

/** 线段真正穿过旋转椭圆的长度；“擦到边”不能算成有玩法意义的运输风险。 */
const saltChordLength = (
  site: { x: number; z: number; radiusX: number; radiusZ: number; rotation: number },
  start: { x: number; z: number },
  end: { x: number; z: number },
): number => {
  const cosine = Math.cos(-site.rotation);
  const sine = Math.sin(-site.rotation);
  const local = (point: { x: number; z: number }): { x: number; z: number } => {
    const dx = point.x - site.x;
    const dz = point.z - site.z;
    return { x: dx * cosine - dz * sine, z: dx * sine + dz * cosine };
  };
  const from = local(start);
  const to = local(end);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const a = dx * dx / (site.radiusX * site.radiusX) + dz * dz / (site.radiusZ * site.radiusZ);
  const b = 2 * (from.x * dx / (site.radiusX * site.radiusX) + from.z * dz / (site.radiusZ * site.radiusZ));
  const c = from.x * from.x / (site.radiusX * site.radiusX) + from.z * from.z / (site.radiusZ * site.radiusZ) - 1;
  const discriminant = b * b - 4 * a * c;
  if (a <= 0 || discriminant <= 0) return 0;
  const root = Math.sqrt(discriminant);
  const first = (-b - root) / (2 * a);
  const second = (-b + root) / (2 * a);
  const low = Math.max(0, Math.min(first, second));
  const high = Math.min(1, Math.max(first, second));
  return high > low ? Math.hypot(end.x - start.x, end.z - start.z) * (high - low) : 0;
};

describe("脆盐壳世界生成", () => {
  it("五个出生营地都稳定生成两条可绕行的运输风险", () => {
    for (const run of [0, 1, 2, 3, 4]) {
      const campId = pickStartCamp(run);
      const world = createWorld(undefined, campId);
      const again = createWorld(undefined, campId);
      expect(world.saltCrusts, `营地 #${campId} 没有两块盐壳`).toHaveLength(2);
      expect(JSON.stringify(world.saltCrusts)).toBe(JSON.stringify(again.saltCrusts));
      expect(distance(world.saltCrusts[0], world.saltCrusts[1])).toBeGreaterThan(28);

      const startCamp = world.camps[campId];
      const routeBarrels = world.barrels.filter((barrel) => !barrel.guarded && distance(barrel, startCamp) > 16);
      for (const site of world.saltCrusts) {
        expect(distance(site, world.truck)).toBeGreaterThan(15);
        expect(world.camps.every((camp) => distance(site, camp) > camp.radius + site.radiusX + 3.9)).toBe(true);
        // 至少一条真实的野外桶运输直线穿过椭圆长轴范围，风险不是无意义地撒在荒地里。
        expect(routeBarrels.some((barrel) => pointToSegment(site, barrel, world.truck) < site.radiusX)).toBe(true);
        // 至少一条真实运输线在壳上走够 8.4m：按油桶速度与承重率会越过 critical，
        // 不允许生成只擦边、连第一档反馈都触发不了的“假风险”。
        expect(Math.max(...routeBarrels.map((barrel) => saltChordLength(site, barrel, world.truck)))).toBeGreaterThanOrEqual(8.4);
        // 椭圆外一圈的地形无断崖；零散矮墙和石头仍可在这一圈外局部绕开。
        for (let index = 0; index < 24; index += 1) {
          const angle = index / 24 * Math.PI * 2;
          const localX = Math.cos(angle) * (site.radiusX + 2.4);
          const localZ = Math.sin(angle) * (site.radiusZ + 2.4);
          const cosine = Math.cos(site.rotation);
          const sine = Math.sin(site.rotation);
          const point = {
            x: site.x + localX * cosine - localZ * sine,
            z: site.z + localX * sine + localZ * cosine,
          };
          expect(isTerrainWalkable(world, point), `营地 #${campId} 盐壳 #${site.id} 的绕行圈断了`).toBe(true);
          expect(terrainSlopeAt(world, point)).toBeLessThanOrEqual(0.46);
        }
      }
    }
  });
});

describe("脆盐壳承重与塌陷", () => {
  const atFirstSite = (): { simulation: GameSimulation; site: GameSimulation["saltCrusts"][number] } => {
    const simulation = new GameSimulation(createWorld());
    simulation.start();
    simulation.setTutorialHold(true);
    const site = simulation.saltCrusts[0];
    simulation.player.x = site.x;
    simulation.player.z = site.z;
    simulation.drainEvents();
    return { simulation, site };
  };

  it("空手、树桩、油桶和大石按重量依次加快承重", () => {
    const pressure = (carrying: "stake" | "fuel" | "stone" | null): number => {
      const { simulation, site } = atFirstSite();
      simulation.player.carrying = carrying;
      advance(simulation, 1);
      return site.pressure;
    };
    const empty = pressure(null);
    const stake = pressure("stake");
    const fuel = pressure("fuel");
    const stone = pressure("stone");
    expect(empty).toBeCloseTo(0.18, 2);
    expect(empty).toBeLessThan(stake);
    expect(stake).toBeLessThan(fuel);
    expect(fuel).toBeLessThan(stone);
  });

  it("真实走过短轴时，空手安全、油桶明显开裂、大石会进入两秒倒计时", () => {
    const cross = (carrying: "fuel" | "stone" | null): { peak: number; sawGrace: boolean; collapsed: boolean } => {
      const { simulation, site } = atFirstSite();
      const travel = { x: -Math.sin(site.rotation), z: Math.cos(site.rotation) };
      simulation.player.x = site.x - travel.x * (site.radiusZ + 1.2);
      simulation.player.z = site.z - travel.z * (site.radiusZ + 1.2);
      simulation.player.facing = travel;
      simulation.player.carrying = carrying;
      let peak = 0;
      let sawGrace = false;
      let entered = false;
      for (let step = 0; step < 180; step += 1) {
        simulation.update(STEP, travel);
        peak = Math.max(peak, site.pressure);
        entered ||= site.inside;
        sawGrace ||= site.stage === "grace";
        const progress = (simulation.player.x - site.x) * travel.x + (simulation.player.z - site.z) * travel.z;
        if (entered && progress > site.radiusZ + 0.7) break;
      }
      return { peak, sawGrace, collapsed: site.stage === "collapsed" };
    };
    const empty = cross(null);
    const fuel = cross("fuel");
    const stone = cross("stone");
    expect(empty.peak).toBeLessThan(0.42);
    expect(fuel.peak).toBeGreaterThan(0.72);
    expect(stone.sawGrace).toBe(true);
    expect(stone.collapsed).toBe(false);
  });

  it("到满载后仍给足两秒，退出即可取消塌陷", () => {
    const { simulation, site } = atFirstSite();
    simulation.player.carrying = "fuel";
    advance(simulation, 2.7);
    expect(site.stage).toBe("grace");
    expect(site.graceRemaining).toBeGreaterThan(1.85);
    simulation.player.x = site.x + site.radiusX + 2;
    simulation.player.z = site.z;
    simulation.update(STEP, { x: 0, z: 0 });
    expect(site.stage).not.toBe("collapsed");
    expect(site.graceRemaining).toBe(0);
  });

  it("倒计时不足两秒绝不塌，越过边界才结算", () => {
    const { simulation, site } = atFirstSite();
    site.pressure = 1;
    site.stage = "grace";
    site.graceRemaining = 2;
    advance(simulation, 1.95);
    expect(site.stage).toBe("grace");
    expect(site.graceRemaining).toBeGreaterThan(0);
    advance(simulation, 0.1);
    expect(site.stage).toBe("collapsed");
  });

  it("塌陷只把玩家和油桶送回入口，不伤人也不丢货", () => {
    const world = createWorld();
    const simulation = new GameSimulation(world);
    simulation.start();
    simulation.setTutorialHold(true);
    const barrel = simulation.barrels.find((candidate) => candidate.placement === "ground");
    expect(barrel).toBeDefined();
    simulation.player.x = barrel!.x;
    simulation.player.z = barrel!.z;
    simulation.requestInteraction();
    expect(simulation.player.carrying).toBe("fuel");

    const site = simulation.saltCrusts[0];
    simulation.player.x = site.x;
    simulation.player.z = site.z;
    const health = simulation.player.health;
    simulation.drainEvents();
    advance(simulation, 5);

    expect(site.stage).toBe("collapsed");
    expect(simulation.player.carrying).toBe("fuel");
    expect(barrel!.placement).toBe("carried");
    expect(simulation.player.health).toBe(health);
    expect(Math.hypot(simulation.player.x - site.x, simulation.player.z - site.z)).toBeGreaterThan(site.radiusZ);
    expect(simulation.drainEvents()).toContainEqual({ type: "salt-crust", siteId: site.id, stage: "collapse" });

    // 恢复中的断口从另一侧二次闯入，只退回当前这一侧，不横穿回第一次的旧入口。
    const side = { x: Math.cos(site.rotation), z: Math.sin(site.rotation) };
    simulation.player.x = site.x + side.x * (site.radiusX + 0.05);
    simulation.player.z = site.z + side.z * (site.radiusX + 0.05);
    simulation.update(STEP, { x: -side.x, z: -side.z });
    const sameSide = (simulation.player.x - site.x) * side.x + (simulation.player.z - site.z) * side.z;
    expect(sameSide).toBeGreaterThan(site.radiusX);
    expect(simulation.drainEvents()).toContainEqual({ type: "salt-crust", siteId: site.id, stage: "eject" });
  });

  it("先把油桶放在盐壳上，塌陷也会把桶推回入口并保持可拾取", () => {
    const world = createWorld();
    const simulation = new GameSimulation(world);
    simulation.start();
    simulation.setTutorialHold(true);
    const barrel = simulation.barrels.find((candidate) => candidate.placement === "ground")!;
    simulation.player.x = barrel.x;
    simulation.player.z = barrel.z;
    simulation.requestInteraction();
    expect(simulation.player.carrying).toBe("fuel");

    const site = simulation.saltCrusts[0];
    simulation.player.x = site.x;
    simulation.player.z = site.z;
    simulation.player.facing = { x: Math.cos(site.rotation), z: Math.sin(site.rotation) };
    simulation.update(STEP, { x: 0, z: 0 });
    simulation.requestInteraction();
    expect(barrel.placement).toBe("ground");
    site.pressure = 0.99;
    site.stage = "critical";
    advance(simulation, 2.2);

    expect(site.stage).toBe("collapsed");
    expect(barrel.placement).toBe("ground");
    const cosine = Math.cos(-site.rotation);
    const sine = Math.sin(-site.rotation);
    const dx = barrel.x - site.x;
    const dz = barrel.z - site.z;
    const localX = dx * cosine - dz * sine;
    const localZ = dx * sine + dz * cosine;
    expect(localX * localX / (site.radiusX * site.radiusX) + localZ * localZ / (site.radiusZ * site.radiusZ)).toBeGreaterThan(1);
    expect(distance(simulation.player, barrel)).toBeLessThan(2.6);
    simulation.requestInteraction();
    expect(simulation.player.carrying).toBe("fuel");
  });

  it("放下大石会形成落脚点并快速卸载承重", () => {
    const { simulation, site } = atFirstSite();
    const stone = simulation.items.find((item) => item.kind === "stone" && item.active);
    expect(stone).toBeDefined();
    simulation.player.x = stone!.x;
    simulation.player.z = stone!.z;
    simulation.requestInteraction();
    expect(simulation.player.carrying).toBe("stone");

    site.pressure = 0.82;
    site.stage = "critical";
    simulation.player.x = site.x;
    simulation.player.z = site.z;
    simulation.player.facing = { x: Math.cos(site.rotation), z: Math.sin(site.rotation) };
    simulation.requestInteraction();
    expect(simulation.player.carrying).toBeNull();
    const before = site.pressure;
    simulation.update(STEP, { x: 0, z: 0 });
    expect(site.supported).toBe(true);
    expect(site.pressure).toBeLessThan(before);
  });

  it("最后两秒放下大石也能立刻取消塌陷", () => {
    const { simulation, site } = atFirstSite();
    const stone = simulation.items.find((item) => item.kind === "stone" && item.active)!;
    simulation.player.x = stone.x;
    simulation.player.z = stone.z;
    simulation.requestInteraction();
    simulation.player.x = site.x;
    simulation.player.z = site.z;
    simulation.player.facing = { x: Math.cos(site.rotation), z: Math.sin(site.rotation) };
    site.pressure = 1;
    site.stage = "grace";
    site.graceRemaining = 0.4;
    simulation.requestInteraction();
    simulation.update(STEP, { x: 0, z: 0 });
    expect(site.supported).toBe(true);
    expect(site.stage).not.toBe("grace");
    expect(site.graceRemaining).toBe(0);
  });
});
