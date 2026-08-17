import { createWorld } from "../../src/game/content/createWorld";
import { GameSimulation } from "../../src/game/simulation/GameSimulation";
import { terrainHeightAt } from "../../src/game/terrain/TerrainModel";
import type { Vec2, WolfState, WorldDefinition } from "../../src/game/simulation/types";

/**
 * 模拟层测试的公共脚手架。
 *
 * 为什么这些测试只跑模拟层、不开浏览器：本作的寻路 / 地形 / 狼群状态机全部是纯计算，
 * 而它们出问题的样子（狗站在崖下不动）在截图里和"狗正在巡逻"一模一样 —— 肉眼分不出，
 * typecheck 也发现不了，只有把一整夜跑完再看统计量才看得见。
 *
 * 步长取 1/20 秒：这正是 GameSimulation.update() 内部 `Math.min(delta, 0.05)` 的上限，
 * 所以它是"仍然被逐帧完整处理"的最粗步长 —— 比 1/60 快三倍，而模拟结果不失真。
 * 随机数是固定种子（mulberry32(847331)），所以整套测试是确定性的。
 */
export const STEP = 1 / 20;
export const NIGHT_SECONDS = 180;

export const sharedWorld: WorldDefinition = createWorld();

export const CAMP_IDS = [0, 1, 2, 3, 4] as const;

export function campLabel(id: number): string {
  return `营地 ${id} ${sharedWorld.camps[id].kind}`;
}

interface NightOptions {
  /** 玩家守着哪座营地。 */
  campId: number;
  /** 跑多少秒，默认一整夜。 */
  seconds?: number;
  /** 每步之后的回调，用来采样。 */
  onStep?: (sim: GameSimulation, step: number) => void;
}

/**
 * 起一夜：玩家坐在指定营地的火边不动，狗按正常规则从狗巢刷入。
 *
 * 只点亮玩家所在的那座营地 —— getRaidTarget 之外的攻营判定认燃料，
 * 全都不点的话攻营犬没有目标，会散在别处巡逻，测出来的全是噪音。
 * 玩家血量每步回填：我们要观察的是整夜的狗群行为，不是玩家能撑多久。
 */
export function runNight({ campId, seconds = NIGHT_SECONDS, onStep }: NightOptions): GameSimulation {
  const sim = new GameSimulation(sharedWorld);
  const inner = sim as unknown as {
    phase: string; phaseTime: number; clockStarted: boolean; running: boolean;
  };
  const camp = sharedWorld.camps[campId];
  sim.player.x = camp.x;
  sim.player.z = camp.z;
  inner.phase = "night";
  inner.phaseTime = NIGHT_SECONDS;
  inner.clockStarted = true;
  inner.running = true;

  const steps = Math.round(seconds / STEP);
  for (let step = 0; step < steps; step += 1) {
    for (const c of sim.camps) c.fuel = c.id === campId ? 999 : 0;
    sim.player.health = 1_000_000;
    sim.update(STEP, { x: 0, z: 0 });
    onStep?.(sim, step);
  }
  return sim;
}

/** 场上还活着的夜袭犬。 */
export function livingRaiders(sim: GameSimulation): WolfState[] {
  return sim.wolves.filter((w) => w.role === "raider" && w.mode !== "dead");
}

export function distanceTo(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function heightAt(point: Vec2): number {
  return terrainHeightAt(sharedWorld, point);
}
