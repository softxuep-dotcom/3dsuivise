/**
 * 行为基线：把一局游戏跑成一段可以逐字比对的文本。
 *
 * ## 它是干什么的
 *
 * 接下来几轮重构要把 GameSimulation 的三千五百行拆成十来个文件。拆分本身不该改变
 * 任何行为，但"不该"需要有人证明。单元测试证明不了这个 —— 它们各自盯着一条窄路
 * （教学桶的余量、狼的寻路、Toast 时长），而拆分出错的地方往往在它们之间：
 * 某个常量搬走时手抖改了一位小数、某两步的调用顺序在搬运中对调了。
 *
 * 这份基线换一种打法：**不断言任何具体数值，只断言"和上次一模一样"**。
 * 快照文件进版本库，重构之后 diff 为空就算搬对了。如果 diff 不为空，
 * 它会直接指出是哪一秒、哪条轴、哪个事件变了。
 *
 * ## 为什么这件事做得到
 *
 * 因为这个模拟层是完全确定性的：随机源是 `mulberry32(847331)`（实例私有，
 * 每个 GameSimulation 自带一份），世界是 `mulberry32(71291)`，
 * 全层没有一处 `Date.now()` / `performance.now()` / `Math.random()`。
 * `Math.random` 只出现在音频和渲染的装饰用途（扬沙、震屏），碰不到这里。
 *
 * ## 三个场景各锁什么
 *
 *   A 静止的一昼夜  五轴衰减、体温的白天地板与日晒基线、中暑阈值、
 *                   相位时长（首日 40 秒 / 首夜 150 秒）、目标行推进、死因
 *   B 跑一趟油桶    移速、扛桶时的移速惩罚、拾取与装车的判定距离、通关计数
 *   C 一整夜的狗    刷狼节奏、难度调校、夜袭与撤退的时间线
 *
 * 三个场景合起来覆盖了阶段 1 要搬走的全部数值。
 *
 * ## 加新场景时
 *
 * 采样一律走 {@link fmt}，不要直接写 `toFixed` —— 浮点尾数在不同取整位数下
 * 会把无关的抖动放进快照，那会让基线开始"随机变红"，而一个会随机变红的基线
 * 比没有基线更糟。
 */
import { createWorld } from "../../src/game/content/createWorld";
import { GameSimulation } from "../../src/game/simulation/GameSimulation";
import type { GameEvent, Vec2 } from "../../src/game/simulation/types";
import { runNight, STEP } from "./simHarness";

/** 统一的数值格式。位数少一点，抖动就进不来。 */
const fmt = (value: number, digits = 1): string => value.toFixed(digits);

/**
 * 把一个事件压成一行。
 *
 * `params` 必须展开成 JSON：消息事件的参数里带着距离、桶数、方位这些**会被重构碰到**的数字，
 * 而直接 String() 一个对象只会得到 `[object Object]` —— 那等于把最该锁的东西丢了。
 */
function describeEvent(event: GameEvent): string {
  const rest = Object.entries(event)
    .filter(([key]) => key !== "type")
    .map(([key, value]) => {
      if (typeof value === "number") return `${key}=${fmt(value, 2)}`;
      if (value !== null && typeof value === "object") return `${key}=${JSON.stringify(value)}`;
      return `${key}=${String(value)}`;
    })
    .join(" ");
  return rest ? `${event.type} ${rest}` : event.type;
}

/** 目标行/提示语只取键名。英文原文会改，键不会 —— 基线不该被一次文案润色弄红。 */
const keyOf = (text: { key: string } | string): string =>
  typeof text === "string" ? text : text.key;

/**
 * 造一局并把时钟直接打开。
 *
 * 每个场景都自己造世界，**不要共用** —— GameSimulation 会就地改动 world 上的结构，
 * 共用会让后跑的场景拿到被前一个场景改过的世界，同一份快照单跑和整套跑不一样。
 * simHarness.runNight 顶上有同一条注释，那是踩出来的。
 */
function freshRun(): GameSimulation {
  const sim = new GameSimulation(createWorld());
  sim.start();
  // 正常游戏里时钟由玩家第一次移动点亮（noteActivity）。场景 A 全程站着不动，
  // 不手动打开的话世界永远停在第 0 秒。
  sim.clockStarted = true;
  return sim;
}

/** 场景 A：站着不动，直到死。 */
export function baselineIdleDay(): string {
  const sim = freshRun();
  const lines: string[] = [];
  const events: string[] = [];
  lines.push("场景 A · 站着不动，什么也不做，直到死");
  lines.push(`起点 (${fmt(sim.player.x, 2)}, ${fmt(sim.player.z, 2)})  营地 #${sim.world.startCampId}`);
  lines.push("");
  lines.push("     t   day 相位    血    水    饿   体温   劳力  状态         目标行");

  const still: Vec2 = { x: 0, z: 0 };
  let elapsed = 0;
  let nextSample = 0;
  for (let step = 0; step < Math.round(300 / STEP) && sim.running; step += 1) {
    if (elapsed >= nextSample) {
      const p = sim.player;
      lines.push(
        [
          fmt(elapsed).padStart(6),
          String(sim.day).padStart(3),
          sim.phase.padEnd(6),
          fmt(p.health).padStart(6),
          fmt(p.water).padStart(6),
          fmt(p.hunger).padStart(6),
          fmt(p.warmth).padStart(6),
          fmt(p.stamina).padStart(6),
          p.condition.padEnd(12),
          keyOf(sim.getObjective()),
        ].join(" "),
      );
      nextSample += 5;
    }
    sim.update(STEP, still);
    elapsed += STEP;
    for (const event of sim.drainEvents()) events.push(`  t=${fmt(elapsed)} ${describeEvent(event)}`);
  }

  lines.push("");
  lines.push(`结束于 t=${fmt(elapsed)}  running=${sim.running}  死因=${sim.deathCause}  瘫痪状态=${sim.deathCondition}`);
  lines.push("");
  lines.push("事件流");
  lines.push(...events);
  return lines.join("\n");
}

/**
 * 场景 B：量移速，然后取一桶油装上车。
 *
 * ## 为什么要先量两段直线
 *
 * 出生点那桶教学油就躺在 2.2 米外，而拾取判定是 2.6 米 —— 一步都不用走就能拿到。
 * 于是"走过去、扛回来"这个动作根本量不出移速，更量不出**扛桶时移速只剩 0.54 倍**
 * 这条支撑整个通关设计的规则。
 *
 * 所以先在同一个起点上量两段同样长的直线：空手一段、扛桶一段。两段的**比值**
 * 就是扛运惩罚，它跟地形无关（同一段路），常量改一位小数这里立刻变。
 * 中间那次把玩家放回起点是有意的：不放回去，两段走的就是不同的坡，比值失去意义。
 */
export function baselineFuelRun(): string {
  const sim = freshRun();
  const lines: string[] = [];
  const events: string[] = [];
  const drain = (at: number): void => {
    for (const event of sim.drainEvents()) events.push(`  t=${fmt(at)} ${describeEvent(event)}`);
  };

  lines.push("场景 B · 量移速，然后取一桶油装上车");
  const origin: Vec2 = { x: sim.player.x, z: sim.player.z };
  lines.push(`起点 (${fmt(origin.x, 2)}, ${fmt(origin.z, 2)})  卡车 (${fmt(sim.truck.x, 2)}, ${fmt(sim.truck.z, 2)})`);

  let elapsed = 0;
  /** 朝固定方向推 seconds 秒，返回直线位移。方向不归一化的话推力大小会混进结果。 */
  const strideFor = (seconds: number, heading: Vec2): number => {
    const from = { x: sim.player.x, z: sim.player.z };
    for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
      sim.update(STEP, heading);
      elapsed += STEP;
      drain(elapsed);
    }
    return Math.hypot(sim.player.x - from.x, sim.player.z - from.z);
  };

  const heading: Vec2 = { x: 1, z: 0 };
  const empty = strideFor(3, heading);
  // 放回起点：两段必须走同一段地形，否则比值量的是坡度不是扛运惩罚。
  sim.player.x = origin.x;
  sim.player.z = origin.z;

  const barrel = [...sim.barrels]
    .filter((item) => item.placement === "ground")
    .sort((a, b) => Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z))[0];
  lines.push(`教学桶 #${barrel.id} 在 ${fmt(Math.hypot(barrel.x - origin.x, barrel.z - origin.z))} 米外`
    + `  现场守卫=${sim.getFuelProgress().nearest?.guarded}`);
  sim.requestInteraction();
  drain(elapsed);
  const carrying = sim.getFuelProgress().carrying;
  const carried = strideFor(3, heading);

  lines.push("");
  lines.push(`空手 3 秒走了 ${fmt(empty, 2)} 米（${fmt(empty / 3, 2)} m/s）`);
  lines.push(`扛桶 3 秒走了 ${fmt(carried, 2)} 米（${fmt(carried / 3, 2)} m/s）  拾起成功=${carrying}`);
  lines.push(`扛运惩罚 = ${fmt(carried / empty, 3)} 倍`);
  lines.push("");

  /** 朝目标直线走。`stall` 是必需的：撞上不可走的坡会原地贴着，没有出口就空转到预算耗尽。 */
  const walkTo = (target: Vec2, stopAt: number, budget: number, label: string): void => {
    const startAt = elapsed;
    let last = 1e9;
    let stall = 0;
    let arrived = false;
    for (let i = 0; i < budget / STEP; i += 1) {
      const gap = Math.hypot(target.x - sim.player.x, target.z - sim.player.z);
      if (gap <= stopAt) { arrived = true; break; }
      const len = gap || 1;
      sim.update(STEP, { x: (target.x - sim.player.x) / len, z: (target.z - sim.player.z) / len });
      elapsed += STEP;
      drain(elapsed);
      stall = Math.abs(gap - last) < 1e-7 ? stall + 1 : 0;
      last = gap;
      if (stall > 30) break;
    }
    lines.push(`${label.padEnd(10)} 到达=${String(arrived).padEnd(5)} 用时=${fmt(elapsed - startAt)}s `
      + `剩余距离=${fmt(Math.hypot(target.x - sim.player.x, target.z - sim.player.z), 2)}m`);
  };

  walkTo(sim.truck, 4.2, 120, "扛回卡车");
  sim.requestInteraction();
  drain(elapsed);

  const fuel = sim.getFuelProgress();
  lines.push("");
  lines.push(`装车后  已装 ${fuel.loaded}/${fuel.required}  扛桶=${fuel.carrying}  离车 ${fmt(fuel.truckDistance)} 米`);
  lines.push(`总用时 ${fmt(elapsed)}s  目标行=${keyOf(sim.getObjective())}`);
  lines.push("");
  lines.push("事件流");
  lines.push(...events);
  return lines.join("\n");
}

/**
 * 场景 C：守着 0 号营地过一整夜，只看狗。
 *
 * 除了在场数量，还记**离玩家最近的那只有多远**和模式分布 —— 只数头数的话，
 * 刷满之后十几行采样会一模一样，等于后半夜没有被锁住任何东西。
 * 距离这一列会一直动，刷狼节奏、寻路、撤退时机任何一处变了它都会变。
 */
export function baselineNightPack(): string {
  const lines: string[] = [];
  lines.push("场景 C · 守 0 号营地过一整夜（180 秒），玩家不动、不死");
  lines.push("");
  lines.push("     t  在场  小狼  大狼  夜袭  守巢  野生  已死   最近  模式分布");

  let nextSample = 0;
  const sim = runNight({
    campId: 0,
    seconds: 180,
    onStep: (run, step) => {
      const elapsed = step * STEP;
      if (elapsed < nextSample) return;
      nextSample += 15;
      const alive = run.wolves.filter((wolf) => wolf.mode !== "dead");
      const count = (predicate: (wolf: typeof alive[number]) => boolean): string =>
        String(alive.filter(predicate).length).padStart(5);
      const nearest = alive.reduce(
        (best, wolf) => Math.min(best, Math.hypot(wolf.x - run.player.x, wolf.z - run.player.z)),
        Infinity,
      );
      const modes = [...new Set(alive.map((wolf) => wolf.mode))].sort().join(",");
      lines.push(
        [
          fmt(elapsed).padStart(6),
          String(alive.length).padStart(5),
          count((wolf) => wolf.kind === "small"),
          count((wolf) => wolf.kind === "large"),
          count((wolf) => wolf.role === "raider"),
          count((wolf) => wolf.role === "guard"),
          count((wolf) => wolf.role === "wild"),
          String(run.wolves.length - alive.length).padStart(5),
          (Number.isFinite(nearest) ? fmt(nearest) : "-").padStart(6),
          "  " + modes,
        ].join(" "),
      );
    },
  });

  const alive = sim.wolves.filter((wolf) => wolf.mode !== "dead");
  lines.push("");
  lines.push(`整夜共放出 ${sim.wolves.length} 只，天亮时在场 ${alive.length} 只`);
  lines.push(`精英狼 ${sim.wolves.filter((wolf) => wolf.kind === "elite").length} 只（第 3 天起才可能出现）`);
  lines.push(`收尾模式分布：${[...new Set(sim.wolves.map((wolf) => wolf.mode))].sort().join(" ")}`);
  return lines.join("\n");
}
