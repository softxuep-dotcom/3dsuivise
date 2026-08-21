/**
 * 常驻自动机：让模拟层自己把一局玩完，用来回答**机械问题**。
 *
 * ## 为什么要有这个文件
 *
 * Poki 的 Player Fit Test 一天只能跑 2 次、每次约 5 小时，所以它只能当**验收**，
 * 不能当调试循环。而清单上待办的那几条（保底成长线、大狼防御、第一昼夜时长）
 * 决定的都是"人会不会死"——死是纯计算，模拟层秒级就能答。
 *
 * 以前每次要问这类问题都现写一个机器人扔进 `tests/tmp/`，而 `tmp/` 在 .gitignore 里，
 * 跑完就没了：下一次重写，顺便把"机器人不守火所以绝对值偏悲观"这类坑重踩一遍。
 * 这个文件就是把它变成常驻资产。
 *
 * ## 它能答什么、不能答什么
 *
 * ✅ 能答：能不能活过第一夜、几点到黎明、单局时长分布、死因分布、材料够不够、
 *         剪刀差有没有被填平。
 * ❌ 不能答：**愿不愿留、愿不愿按"再来一局"、看不看得懂。**
 *
 * 这条界线是 1.0.23 用一整轮 Fit Test 换来的：白天 40→55 让机器人存活 +21%，
 * 真人却提前走了 —— 机器人不会因为无聊退出。所以它的**绝对值只当机械下界**，
 * 绝不能拿去预测留存；有效信息永远是同一个策略下两套配置的**差值**。
 *
 * ## 用法
 *
 *   npm run autoplay
 *   AUTOPLAY_RUNS=40 npm run autoplay
 *   AUTOPLAY_DIFFICULTY=normal npm run autoplay
 *
 * 输出四张表：逐局明细 / 单局时长分布 / 死因×时刻 / 十分钟能开几局。
 *
 * ## 已知缺陷（读数之前先看这一段）
 *
 * 1. **`starved` 这一档还不可信。** 狩猎分支排在"夜里守火"之后，所以整夜都不会
 *    去找吃的；camp 0 因此每局都在同一秒饿死（5m52s），那是口粮按固定时钟耗尽，
 *    不是游戏事实。要用饿死数据的话先把狩猎提到守火前面，并验证 camp 0 不再恒定。
 *
 * 2. **策略抖动改不动结局，地图才是主导。** 同一座营地换 policy 种子，结果几乎一样
 *    （seed 3/7 都是 camp 4 → 1m36s）。所以现在 n>5 不增加信息量，跑 40 局和跑 5 局
 *    看到的是同一件事。要真正的分布，得让抖动幅度大到能改变结局，或者改抖世界种子。
 *
 * **`killed` 这一档是可信的**，而且正好是待办清单要动的那一档：保底成长线、
 * 大狼防御 7→3、第一昼夜时长，改的全是"第一夜会不会被咬死"。8 局里有 6 局走这条路径。
 */
import { createWorld, pickStartCamp } from "../src/game/content/createWorld";
import { mulberry32 } from "../src/game/simulation/geometry";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import type {
  DeathCause, InventoryItemKind, Phase, Vec2, WolfKind,
} from "../src/game/simulation/types";
import type { Difficulty } from "../src/game/simulation/difficulty";

/**
 * 步长 1/20 秒 —— 正是 GameSimulation.update() 内部 `Math.min(delta, 0.05)` 的上限，
 * 也就是"仍然被逐帧完整处理"的最粗步长。比 1/60 快三倍而结果不失真。
 * 与 tests/helpers/simHarness.ts 保持同一个数，两边的结论才能互相引用。
 */
export const STEP = 1 / 20;

/** 单局最长跑多少模拟秒。900 秒 = 15 分钟，远超 5m+ 群体的实际停留。 */
const RUN_LIMIT_SECONDS = 900;

export type RunOutcome = DeathCause | "victory" | "timeout";

export interface RunResult {
  campId: number;
  seed: number;
  seconds: number;
  outcome: RunOutcome;
  killer: WolfKind | null;
  day: number;
  phase: Phase;
  fuelLoaded: number;
  kills: number;
  weapon: string;
  armor: string;
  /** 这一局有没有真的升过阶。对照的是本局开局值，不是别局的终值。 */
  upgraded: boolean;
  /** 活过第一夜没有 —— 节奏表里最关键的那道闸。 */
  reachedDawn: boolean;
}

/* ------------------------------------------------------------------ *
 * 策略
 * ------------------------------------------------------------------ */

/**
 * 一个玩家画像。
 *
 * **为什么必须抖动**：世界种子是固定的 71291，`pickStartCamp` 只轮五座营地，
 * 而模拟层和策略都是确定的 —— 所以不抖动的话第 6 局起就是前 5 局的逐字节重放，
 * n=20 实际是 n=5。第一版就栽在这儿：n=3 和 n=20 的「5m+ 停留」都是 5m52s，
 * 那不是稳定，那是同一条数据被抄了四遍。
 *
 * 抖的是**玩家**不是**世界**：真人面对的是同一张图（首局永远是设计好的 #1），
 * 变的是反应快慢、盯不盯条、守不守火。所以这里只抖策略参数，
 * `createWorld` 的种子一动不动 —— 这样量出来的分布才对应生产环境的那一个分布。
 */
interface Policy {
  /** 五轴掉到多少才去补。真人不会盯着条走，所以不是一掉就补。 */
  needLow: number;
  /** 背包里留几根柴就不再捡，免得占满装不下肉和皮。 */
  woodStock: number;
  /** 夜里离火多远就往回走。 */
  fireRadius: number;
  /** 走路的角度噪声（弧度）。手指没那么准。 */
  moveJitter: number;
  /** 每帧放弃一次攻击的概率 —— 模拟反应不及时，不是模拟手残。 */
  attackMiss: number;
}

function rollPolicy(seed: number): Policy {
  const r = mulberry32(seed);
  return {
    needLow: 22 + r() * 16,
    woodStock: 4 + Math.floor(r() * 5),
    fireRadius: 6 + r() * 4,
    moveJitter: r() * 0.25,
    attackMiss: r() * 0.15,
  };
}

const norm = (v: Vec2): Vec2 => {
  const m = Math.hypot(v.x, v.z);
  return m < 1e-6 ? { x: 0, z: 0 } : { x: v.x / m, z: v.z / m };
};
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * 升一阶。
 *
 * **不能直接用 craftWeapon() / craftArmor()** —— 它们要求
 * `getUpgradeOptions(slot).length === 1`，而 0 阶时 `line === "none"`，
 * 那个函数返回的是**全部一阶**（武器两条线、护甲两条线），长度是 2，
 * 于是两个方法在 0 阶恒返回 false。第一版机器人就是这么写的，读出来
 * 「装备升级 0.0%」，看着像是剪刀差的证据，其实是探针自己没接上线。
 *
 * 所以 0 阶必须按 id 指定走哪条线。默认选 sword-1 / hide-1：这两件
 * `needsFire: false`，是节奏表 §5 里保底成长①指定的那一档 ——
 * 第一只狼倒下掉 2皮2肉1牙，当场就够 sword-1（1皮+2木），不用回火边。
 * 1 阶之后 getUpgradeOptions 只剩一个候选，官方方法就能用了。
 */
const LINE_ENTRY = { weapon: "sword-1", armor: "hide-1" } as const;

function tryUpgrade(sim: GameSimulation): void {
  if (!sim.isEquipmentUnlocked()) return;
  for (const slot of ["weapon", "armor"] as const) {
    const options = sim.getUpgradeOptions(slot);
    if (options.length === 1) { sim.craftEquip(slot, options[0].id); continue; }
    if (options.some((tier) => tier.id === LINE_ENTRY[slot])) {
      sim.craftEquip(slot, LINE_ENTRY[slot]);
    }
  }
}

/** 背包里第一个指定种类的槽位；没有返回 -1。 */
function slotOf(sim: GameSimulation, kind: InventoryItemKind): number {
  return sim.player.inventory.findIndex((s) => s?.kind === kind);
}

/** 按"先熟肉、再仙人掌汁、最后生肉"的顺序吃一口；吃到了返回 true。 */
function eatSomething(sim: GameSimulation): boolean {
  for (const kind of ["cooked-meat", "cactus-juice", "raw-meat"] as const) {
    const i = slotOf(sim, kind);
    if (i >= 0) { sim.useInventorySlot(i); return true; }
  }
  return false;
}

/** 按"先水、再仙人掌汁"的顺序喝一口。 */
function drinkSomething(sim: GameSimulation): boolean {
  for (const kind of ["water", "cactus-juice"] as const) {
    const i = slotOf(sim, kind);
    if (i >= 0) { sim.useInventorySlot(i); return true; }
  }
  return false;
}

/**
 * 最近的活猎物。
 *
 * 没有这一条的话机器人**永远不会主动找吃的** —— 它只会捡 hint 递到脚边的东西，
 * 于是开局那份口粮按固定时钟耗尽，每局都在同一秒饿死（实测 camp 0 恒定 5m52s）。
 * 那个数字看着像一条结论，其实是探针自己不吃饭。狩猎补上之后 starved 才是游戏事实。
 */
function nearestCritter(sim: GameSimulation): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const c of sim.critters) {
    if (c.mode === "dead") continue;
    const d = dist(sim.player, c);
    if (d < bestD) { bestD = d; best = { x: c.x, z: c.z }; }
  }
  return best;
}

/** 地上还没被搬走的桶里最近的那个。 */
function nearestGroundBarrel(sim: GameSimulation): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const barrel of sim.barrels) {
    if (barrel.placement !== "ground") continue;
    const d = dist(sim.player, barrel);
    if (d < bestD) { bestD = d; best = { x: barrel.x, z: barrel.z }; }
  }
  return best;
}

/**
 * 一帧的决策，返回这一帧要往哪走（不走就返回零向量）。
 *
 * 顺序即优先级。战斗排在最前面 —— requestAttack 有自己的冷却，
 * 每帧调用是安全的，射程外它自己会 return。
 */
function decide(sim: GameSimulation, homeCamp: Vec2, pol: Policy, rand: () => number): Vec2 {
  const p = sim.player;

  // 1. 打得着就打。攻击不打断移动，所以这一条不 return。
  if (sim.hasAttackTargetInRange() && rand() >= pol.attackMiss) sim.requestAttack();

  // 2. 五轴告急：能就地解决的先就地解决，解决不了的走过去。
  if (p.water < pol.needLow && drinkSomething(sim)) return { x: 0, z: 0 };
  if (p.hunger < pol.needLow && eatSomething(sim)) return { x: 0, z: 0 };

  const hint = sim.getInteractionHint();

  // 3. 扛着桶就一路送到车上 —— 扛运期间移速 ×0.54，绕路的代价最贵。
  if (p.carrying === "fuel") {
    if (hint.action === "load") { sim.requestInteraction(); return { x: 0, z: 0 }; }
    return sim.directionToClickTarget(sim.truck) ?? { x: 0, z: 0 };
  }

  // 4. 脚边就能做的事：捡柴（够了就不捡）、添柴点火、打水、扛桶。
  //    hint 已经是优先级表算过的结果，这里只决定"要不要按"。
  if (hint.action === "feed" || hint.action === "ignite") {
    sim.requestInteraction();
    return { x: 0, z: 0 };
  }
  if (hint.action === "well" && p.water < 90) {
    sim.requestInteraction();
    return { x: 0, z: 0 };
  }
  if (hint.action === "pickup") {
    // 柴够了就不再捡，免得背包被木头占满、装不下肉和皮。
    const isWood = sim.getInventoryCount("wood") < pol.woodStock;
    if (isWood || sim.getFuelProgress().nearest !== null) sim.requestInteraction();
    return { x: 0, z: 0 };
  }

  // 5. 材料够就升一阶。
  tryUpgrade(sim);

  // 6. 夜里守火：火是这个游戏唯一的体温来源，机器人不守火的话
  //    量出来的存活时间会系统性偏低（这正是 1.0.23 那次 A/B 的已知偏差）。
  if (sim.phase === "night") {
    const fire = sim.findNearestLitFire(pol.fireRadius);
    const anchor = fire ?? homeCamp;
    if (dist(p, anchor) > 4) return sim.directionToClickTarget(anchor) ?? { x: 0, z: 0 };
    return { x: 0, z: 0 };
  }

  /*
   * 7. 存粮见底就去打猎。
   *
   * 排在搬桶前面：饿死是不可逆的，而装车进度掉一趟只是慢一点。
   * 门槛用 needLow + 20 而不是 needLow —— 等饿到告急线才出发，
   * 路上那段就已经来不及了（最近的猎物在 6~8 米，但打完还要走回火边烤）。
   */
  const foodInBag = sim.getInventoryCount("cooked-meat") + sim.getInventoryCount("raw-meat")
    + sim.getInventoryCount("cactus-juice");
  if (foodInBag === 0 && p.hunger < pol.needLow + 20) {
    const prey = nearestCritter(sim);
    if (prey) return sim.directionToClickTarget(prey) ?? { x: 0, z: 0 };
  }

  // 8. 白天去搬桶 —— 通关进度是唯一的长期目标。
  const barrel = nearestGroundBarrel(sim);
  if (barrel) return sim.directionToClickTarget(barrel) ?? { x: 0, z: 0 };
  return { x: 0, z: 0 };
}

/* ------------------------------------------------------------------ *
 * 跑一局
 * ------------------------------------------------------------------ */

export function runOnce(campId: number, difficulty: Difficulty = "easy", seed = 1): RunResult {
  const pol = rollPolicy(seed);
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const world = createWorld(undefined, campId);
  const sim = new GameSimulation(world, difficulty);
  // 生产环境等模型下载完才调；探针里必须手动开，否则整夜一只狗都不来。
  sim.enableWolves();
  sim.enableCritters();
  sim.start();

  const homeCamp: Vec2 = { x: world.camps[campId].x, z: world.camps[campId].z };
  const startWeapon = sim.player.weapon;
  const startArmor = sim.player.armor;
  let reachedDawn = false;

  for (let t = 0; t < RUN_LIMIT_SECONDS / STEP; t += 1) {
    if (!sim.running) break;
    let move = decide(sim, homeCamp, pol, rand);
    // 角度噪声：手指没那么准，而"永远走最优直线"会系统性高估存活。
    if (pol.moveJitter > 0 && (move.x || move.z)) {
      const a = Math.atan2(move.z, move.x) + (rand() - 0.5) * 2 * pol.moveJitter;
      move = { x: Math.cos(a), z: Math.sin(a) };
    }
    /*
     * 时钟闸：clockStarted 要玩家第一次**真实移动**才置 true（阈值 0.08），
     * 在那之前五轴不掉、相位不走、狼不动。开局这一下必须真的动，
     * 否则会出现"跑了 300 秒什么都没发生"。
     */
    if (!sim.clockStarted && Math.hypot(move.x, move.z) < 0.09) move = { x: 1, z: 0 };
    sim.update(STEP, norm(move));
    if (sim.day >= 2 && sim.phase === "day") reachedDawn = true;
    sim.drainEvents();
  }

  const outcome: RunOutcome = sim.deathCause
    ?? (sim.truck.loaded >= 6 ? "victory" : "timeout");

  return {
    campId,
    seed,
    seconds: Math.round(sim.elapsed * 10) / 10,
    outcome,
    killer: sim.deathKiller,
    day: sim.day,
    phase: sim.phase,
    fuelLoaded: sim.truck.loaded,
    kills: sim.player.kills,
    weapon: sim.player.weapon,
    armor: sim.player.armor,
    upgraded: sim.player.weapon !== startWeapon || sim.player.armor !== startArmor,
    reachedDawn,
  };
}

/**
 * 按 pickStartCamp 的真实轮换顺序跑 n 局 —— 首局永远是设计好的 #1。
 *
 * 每局换一个 policy 种子（i + 1），所以同一座营地会被不同画像的玩家反复跑，
 * 这正是生产环境的形状：一张固定的图，一群不同的人。
 * 种子是确定的，所以整份报表可复现 —— 两套配置的差值才有意义。
 */
export function runBatch(runs: number, difficulty: Difficulty = "easy"): RunResult[] {
  const out: RunResult[] = [];
  for (let i = 0; i < runs; i += 1) out.push(runOnce(pickStartCamp(i), difficulty, i + 1));
  return out;
}
