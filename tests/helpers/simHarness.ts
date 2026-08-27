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
  /**
   * 玩家这一帧往哪走，参数是已经过去的模拟秒数。默认站着不动。
   *
   * 站桩是大多数用例要的（观察对象是狗，玩家不该成为变量），但有些坏法**只有
   * 玩家会动才暴露**：狗一旦贴上不动的人就永远贴着，根本不会追丢，
   * 于是"追丢之后还回不回来"这条路径一次都跑不到。
   */
  move?: (elapsed: number) => Vec2;
}

/**
 * 起一夜：玩家坐在指定营地的火边不动，狗按正常规则从狗巢刷入。
 *
 * 只点亮玩家所在的那座营地 —— getRaidTarget 之外的攻营判定认燃料，
 * 全都不点的话攻营犬没有目标，会散在别处巡逻，测出来的全是噪音。
 * 玩家血量每步回填：我们要观察的是整夜的狗群行为，不是玩家能撑多久。
 */
export function runNight({ campId, seconds = NIGHT_SECONDS, onStep, move }: NightOptions): GameSimulation {
  /*
   * 每次都现造一个世界，**不要**复用 sharedWorld。
   *
   * GameSimulation 会就地改动 world 上的一些结构，于是共享同一个 world 时，
   * 一条用例的结果取决于它前面跑过几条 —— 同样是 1/20 步长、同样的营地，
   * 单独跑给出 5 只攻营犬到达，放进整套里跑就变成 0 只。这种"顺序依赖"的假失败
   * 会把真回归淹掉，而且极难复现。sharedWorld 只留给只读用途（量地形高度、取名字）。
   */
  const sim = new GameSimulation(createWorld());
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
  // 生产环境等 Wolf.glb 下载完成后才启用；这里在夜相位设置好后模拟“资源已就绪”。
  sim.enableWolves();

  const steps = Math.round(seconds / STEP);
  for (let step = 0; step < steps; step += 1) {
    for (const c of sim.camps) c.fuel = c.id === campId ? 999 : 0;
    keepPlayerAlive(sim);
    sim.update(STEP, move?.(step * STEP) ?? { x: 0, z: 0 });
    onStep?.(sim, step);
  }
  return sim;
}

/**
 * 每步把玩家的五条轴顶满。我们观察的是整夜的狗群行为，玩家不该成为变量。
 *
 * **水分和饥饿必须一起顶**，只顶血是不够的：两者每秒 -0.42，开局分别为 85 / 90，
 * 水分先在第 202.4 秒归零并触发 endGame，running 置 false，
 * 此后 update() 直接 return —— 整个世界静止。跑超过一夜的用例（比如天亮撤退）
 * 会看到"27 只狗卡在原地 200 秒"，那不是寻路坏了，是模拟停了。
 */
export function keepPlayerAlive(sim: GameSimulation): void {
  sim.player.health = 1_000_000;
  sim.player.water = 100;
  sim.player.hunger = 100;
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
