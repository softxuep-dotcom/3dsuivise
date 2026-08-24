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
 * ⚠️ 2026-08-24：策略补上投掷之后，机器人明显变强了 —— 活过第一夜从 55% 跳到
 *    **100%**（饱和了，这个指标暂时不能再用来量第一夜难度），平均单局 6m27s，
 *    已经**高于真人中位**（Poki 实测约 3 分钟）。它不再是"机械下界"，
 *    绝对值只当同一策略下的相对刻度用，见文件末尾 runBatch 的注释。
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

/**
 * 「有进展」的事件。
 *
 * 判据不是"有没有反馈"，是**这一下之后局面变了没有**：狼倒了、油进车了、
 * 装备升了、火点着了、状态档位跳了。挥刀（attack）、命中（wolf-hit）、
 * 连击（combo）这些每帧都在发，它们是**同一件事的持续**，不是新的事情 ——
 * 一个人可以一边不停挥刀一边觉得无聊，正是因为局面十秒没动过。
 *
 * 这条名单决定"无进展空档"这个指标的含义，改它等于换了无聊的定义。
 */
const PROGRESS_EVENTS = new Set([
  "wolf-killed", "critter-killed", "fuel-loaded", "craft-weapon", "craft-coat",
  "build", "cook", "truck-depart", "condition", "feed-fire", "structure-destroyed",
  "draw-water", "pickup",
]);

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
  /** 全程零事件的最长空档（秒）。走路、没打架、什么也没捡。 */
  maxSilence: number;
  /** 没有任何"进展事件"的最长空档（秒）。可以一直在挥刀，但局面十秒没动。 */
  maxNoProgress: number;
  /** 前五分钟每分钟的进展事件数。长度固定 5，跑不满的分钟记 -1。 */
  progressPerMinute: number[];
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
  /**
   * 会不会用「投掷」这个动作：捡石头当弹药、抓起晕倒的狼砸出去。
   *
   * 加这一条是因为 2026-08-23 那次复盘：投石、抓狼扔狼是 1.0.30 加的，
   * 而这份策略最后一次改动在 8-21 —— 机器人**根本不会用这些动词**。
   * 更糟的是 `hasAttackTargetInRange()` 在 carrying 非空时恒为假（扛东西不能挥刀），
   * 于是它捡起一块石头之后就再也不按攻击键，扛着走完一整局：
   * 承担了"不能近战"的全部代价，拿不到投掷的任何好处。读出来的
   * 「击杀 4→1、装备升级 60%→45%」因此是**纯代价**，不是这个机制的净值。
   *
   * 这一条量的是"用好了值不值钱"，不是"有多少人会发现它" —— 后者是另一个问题
   * （投掷藏在一个会变形的攻击键后面，而中位会话只有三分钟），要另外量。
   * 所以取值偏高，读出来的是**上界**。
   */
  usesThrow: boolean;
}

function rollPolicy(seed: number): Policy {
  const r = mulberry32(seed);
  return {
    needLow: 22 + r() * 16,
    woodStock: 4 + Math.floor(r() * 5),
    fireRadius: 6 + r() * 4,
    moveJitter: r() * 0.25,
    attackMiss: r() * 0.15,
    // **必须追加在最后。** rollPolicy 是顺序消费同一条随机流的，
    // 在中间插一次 r() 会把它后面每一个参数全部换掉 —— 那样新旧两份报表
    // 比的就不是"多了投掷"，而是"换了一批玩家"，A/B 直接作废。
    usesThrow: r() < 0.75,
  };
}

const norm = (v: Vec2): Vec2 => {
  const m = Math.hypot(v.x, v.z);
  return m < 1e-6 ? { x: 0, z: 0 } : { x: v.x / m, z: v.z / m };
};
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * 多远之内有狼就值得手里攥块石头。
 *
 * 这是**策略**数字，不是引擎数字，所以不去 import STONE_THROW_RANGE（那是 9）——
 * 14 比射程远，是为了在狼扑到之前就把石头准备好；扛石头期间不能挥刀，
 * 所以这个提前量买的是"第一下先砸中"，代价是这几秒不能近战。
 */
const STONE_AMMO_LOOKAHEAD = 14;

/** 半径内还有活狼吗。 */
function wolfWithin(sim: GameSimulation, radius: number): boolean {
  return sim.wolves.some((w) => w.mode !== "dead" && dist(sim.player, w) <= radius);
}

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

/**
 * 最近的一根地上枯木。
 *
 * **没有这一条，机器人整夜都点不着火。** 它原来只捡 hint 递到脚边的东西，
 * 于是白天 40 秒全花在搬桶上，进夜时背包 1 根柴、营地燃料 0，
 * 体温 50 → 0，失温挡掉整夜的回血（实测五座营地"有火可烤"都是 0%）。
 * 柴是体温的唯一来源，必须主动去找。
 */
function nearestWood(sim: GameSimulation): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const item of sim.items) {
    if (item.kind !== "wood") continue;
    const d = dist(sim.player, item);
    if (d < bestD) { bestD = d; best = { x: item.x, z: item.z }; }
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

  /*
   * 1b. 手里有石头、身前锥内又有活物 —— 扔。
   *
   * **必须和上一条分开判。** hasAttackTargetInRange() 在 carrying 非空时恒为假，
   * 只看它的话，捡起石头之后攻击键就再也不会被按到。石头伤害 60，
   * 是初始匕首近战（30）的两倍，射程 9 米还带击退和硬直 —— 白扛着是纯亏。
   */
  if (pol.usesThrow && sim.hasThrowTargetInRange() && rand() >= pol.attackMiss) {
    sim.requestAttack();
  }

  // 1c. 抓在手里的晕狼：直接砸出去，别扛着走。它本身就是一件武器。
  if (pol.usesThrow && p.carrying === "beast" && rand() >= pol.attackMiss) sim.requestAttack();

  // 2. 五轴告急：能就地解决的先就地解决，解决不了的走过去。
  if (p.water < pol.needLow && drinkSomething(sim)) return { x: 0, z: 0 };
  if (p.hunger < pol.needLow && eatSomething(sim)) return { x: 0, z: 0 };

  const hint = sim.getInteractionHint();

  // 3. 扛着桶就一路送到车上 —— 扛运期间移速 ×0.54，绕路的代价最贵。
  if (p.carrying === "fuel") {
    if (hint.action === "load") { sim.requestInteraction(); return { x: 0, z: 0 }; }
    return sim.directionToClickTarget(sim.truck) ?? { x: 0, z: 0 };
  }

  /*
   * 3b. 攥着石头但眼下没得扔（天亮了、狼散了）：**放下**。
   *
   * 不放下的话近战一整天都是失效的，而白天正是打猎换兽皮的时段 ——
   * 兽皮断了，装备线跟着断，第二夜就扛不住。这一条是 1.0.30 那次
   * 长尾塌陷的直接对症。
   */
  if (p.carrying === "stone" && !sim.hasThrowTargetInRange()
    && !wolfWithin(sim, STONE_AMMO_LOOKAHEAD)) {
    sim.requestInteraction();
    return { x: 0, z: 0 };
  }

  // 3c. 脚边有只被打晕的狼 —— 抓起来，下一帧就当武器砸向别的狼。
  if (pol.usesThrow && hint.action === "grab") {
    sim.requestInteraction();
    return { x: 0, z: 0 };
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
    /*
     * 石头单独判：**扛起来就等于把武器收了**（见 hasAttackTargetInRange）。
     *
     * 旧版这里只问"还有桶没装完吗"，而那个条件几乎恒为真，于是 E 键底下是什么
     * 就捡什么 —— 包括 1.0.30 撒进野外的那 10 块投掷石。白天在猎场顺手捡一块，
     * 那一趟猎就白打了。所以只在**马上要打架**时才捡：附近确实有狼。
     * 不想捡也不能 return，否则会站在石头边上发呆，得让它继续往下走。
     */
    if (sim.getPickupCandidate()?.kind === "stone") {
      if (pol.usesThrow && wolfWithin(sim, STONE_AMMO_LOOKAHEAD)) {
        sim.requestInteraction();
        return { x: 0, z: 0 };
      }
    } else {
      // 柴够了就不再捡，免得背包被木头占满、装不下肉和皮。
      const isWood = sim.getInventoryCount("wood") < pol.woodStock;
      if (isWood || sim.getFuelProgress().nearest !== null) sim.requestInteraction();
      return { x: 0, z: 0 };
    }
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

  /*
   * 8. 备柴优先于搬桶。
   *
   * 顺序不能反：柴是体温的唯一来源，而失温会把整夜的回血闸掉
   * （getRestBlocker 的 sim.38 / sim.41 两条），死得比没油快得多。
   * 搬桶只是通关进度，慢一趟不致命。
   */
  if (sim.getInventoryCount("wood") < pol.woodStock) {
    const wood = nearestWood(sim);
    if (wood) return sim.directionToClickTarget(wood) ?? { x: 0, z: 0 };
  }

  // 9. 白天去搬桶 —— 通关进度是唯一的长期目标。
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
  let lastAny = 0, lastProgress = 0, maxSilence = 0, maxNoProgress = 0;
  const perMinute = [0, 0, 0, 0, 0];

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

    const events = sim.drainEvents();
    const now = sim.elapsed;
    if (events.length) {
      maxSilence = Math.max(maxSilence, now - lastAny);
      lastAny = now;
    }
    const progressed = events.filter((e) => PROGRESS_EVENTS.has(e.type));
    if (progressed.length) {
      maxNoProgress = Math.max(maxNoProgress, now - lastProgress);
      lastProgress = now;
      const m = Math.floor(now / 60);
      if (m < 5) perMinute[m] += progressed.length;
    }
  }

  // 收尾：最后一段空档也要算进去，否则"死前干站了 40 秒"会被漏掉。
  maxSilence = Math.max(maxSilence, sim.elapsed - lastAny);
  maxNoProgress = Math.max(maxNoProgress, sim.elapsed - lastProgress);

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
    maxSilence: Math.round(maxSilence * 10) / 10,
    maxNoProgress: Math.round(maxNoProgress * 10) / 10,
    progressPerMinute: perMinute.map((n, i) => (sim.elapsed >= i * 60 ? n : -1)),
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
