/**
 * 自动机报表入口。**不进 `npm test`** —— 它跑的是整局，比单元测试慢一个量级。
 *
 *   npm run autoplay            默认 20 局
 *   AUTOPLAY_RUNS=60 npm run autoplay
 *   AUTOPLAY_DIFFICULTY=normal npm run autoplay
 *
 * 三张表分别对应节奏表（docs/一局节奏表.md）里的三个待答问题：
 *   表 1 → 5m+ 占比与 5m+ 停留时长，也就是 §7 定的两个验收指标
 *   表 2 → §5 "每个流失峰值必须映射到本表某一行"
 *   表 3 → §4 "长会话 = 短局 × 反复重开"
 */
import { describe, it } from "vitest";
import { runBatch, type RunResult } from "./autoplay";
import type { Difficulty } from "../src/game/simulation/difficulty";

const RUNS = Number(process.env.AUTOPLAY_RUNS ?? 20);
const DIFFICULTY = (process.env.AUTOPLAY_DIFFICULTY ?? "easy") as Difficulty;

const BUCKETS = [
  { label: "0–1m", lo: 0, hi: 60 },
  { label: "1–2m", lo: 60, hi: 120 },
  { label: "2–3m", lo: 120, hi: 180 },
  { label: "3–4m", lo: 180, hi: 240 },
  { label: "4–5m", lo: 240, hi: 300 },
  { label: "5m+ ", lo: 300, hi: Infinity },
];

const pct = (n: number, total: number): string => `${((n / total) * 100).toFixed(1)}%`;
const mmss = (s: number): string => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function tableDuration(runs: RunResult[]): void {
  const total = runs.length;
  const secs = runs.map((r) => r.seconds);
  const mean = secs.reduce((a, b) => a + b, 0) / total;

  console.log("\n表 1  单局时长分布");
  console.log("─".repeat(56));
  for (const b of BUCKETS) {
    const hit = runs.filter((r) => r.seconds >= b.lo && r.seconds < b.hi);
    const bar = "█".repeat(Math.round((hit.length / total) * 34));
    console.log(`  ${b.label}  ${String(hit.length).padStart(3)}  ${pct(hit.length, total).padStart(6)}  ${bar}`);
  }
  const tail = runs.filter((r) => r.seconds >= 300);
  const over3 = runs.filter((r) => r.seconds >= 180);
  console.log("─".repeat(56));
  console.log(`  平均 ${mmss(mean)}   中位 ${mmss(median(secs))}`);
  console.log(`  ≥3min 占比 ${pct(over3.length, total)}          （Poki 判据之二：≥25%）`);
  console.log(`  ★ 5m+ 占比 ${pct(tail.length, total)}           （节奏表目标：16%）`);
  const tailDwell = tail.length
    ? tail.reduce((a, r) => a + r.seconds, 0) / tail.length : 0;
  console.log(`  ★ 5m+ 停留 ${tail.length ? mmss(tailDwell) : "—"}           （节奏表目标：11 分钟）`);
  console.log(`  活过第一夜 ${pct(runs.filter((r) => r.reachedDawn).length, total)}`);
}

function tableDeaths(runs: RunResult[]): void {
  console.log("\n表 2  死因 × 时刻");
  console.log("─".repeat(56));
  console.log("  死因        次数   中位时刻   典型阶段        killer");
  const causes = [...new Set(runs.map((r) => r.outcome))];
  for (const cause of causes) {
    const hit = runs.filter((r) => r.outcome === cause);
    const when = median(hit.map((r) => r.seconds));
    const stage = `第${median(hit.map((r) => r.day))}天 ${hit[0].phase === "night" ? "夜" : "昼"}`;
    const killers = [...new Set(hit.map((r) => r.killer).filter(Boolean))].join("/") || "—";
    console.log(
      `  ${String(cause).padEnd(10)}  ${String(hit.length).padStart(3)}   ${mmss(when).padStart(7)}   ${stage.padEnd(12)}  ${killers}`,
    );
  }
}

function tableSession(runs: RunResult[]): void {
  const secs = runs.map((r) => r.seconds);
  const mean = secs.reduce((a, b) => a + b, 0) / runs.length;
  console.log("\n表 3  十分钟能开几局   （§4：长会话 = 短局 × 反复重开）");
  console.log("─".repeat(56));
  console.log(`  按平均单局 ${mmss(mean)} 算：600 / ${mean.toFixed(0)} = ${(600 / mean).toFixed(1)} 局`);
  console.log(`  按中位单局 ${mmss(median(secs))} 算：${(600 / Math.max(1, median(secs))).toFixed(1)} 局`);
  const fuel = runs.map((r) => r.fuelLoaded);
  console.log(`  单局装车进度  中位 ${median(fuel)}/6   最好 ${Math.max(...fuel)}/6`);
  console.log(`  单局击杀      中位 ${median(runs.map((r) => r.kills))}`);
  const upgraded = runs.filter((r) => r.upgraded);
  console.log(`  出现装备升级  ${pct(upgraded.length, runs.length)}   ← 剪刀差是否被填平的直接读数`);
  console.log("\n  注：机器人量的是「能不能活」，不是「愿不愿留」。绝对值只当机械下界，");
  console.log("      有效信息是同一策略下两套配置的差值。见 tools/autoplay.ts 顶部。\n");
}

/**
 * 逐局明细。**必须有** —— 汇总数字看不出"分布"其实是同一条数据的重放：
 * 世界种子固定、营地只有五座、模拟层确定，不抖策略的话第 6 局起就是逐字节复制，
 * 而汇总表上那看起来像是一个稳定的分布。明细一列出来立刻就露馅。
 */
function tableRuns(runs: RunResult[]): void {
  console.log("\n表 0  逐局明细");
  console.log("─".repeat(56));
  console.log("  seed camp    时长  结局       装车 击杀 升级");
  for (const r of runs) {
    console.log(
      `  ${String(r.seed).padStart(4)} ${String(r.campId).padStart(4)} ${mmss(r.seconds).padStart(7)}`
      + `  ${String(r.outcome).padEnd(9)} ${String(r.fuelLoaded).padStart(3)}/6 ${String(r.kills).padStart(4)}`
      + `  ${r.upgraded ? "是" : "—"}`,
    );
  }
}

/**
 * 表 4：无聊的量化。
 *
 * 前三张表答的都是"会不会死"。但真正把人赶走的多半不是死 —— 主创看 Playtest
 * 录像的结论是「大部分人没死就走了」，而机器人**只有死这一个出口**，
 * 它永远量不到"走"。这张表是能从模拟层挤出来的、离"无聊"最近的东西。
 *
 * 两个口径：
 *   静默空档   —— 一个事件都没有：在走路，屏幕上什么都没发生
 *   无进展空档 —— 可以一直在挥刀，但局面十秒没动过（见 PROGRESS_EVENTS）
 *
 * 后者才是关键。一个人可以一边不停砍一边觉得无聊，正是因为砍了半天什么都没变。
 */
function tableBoredom(runs: RunResult[]): void {
  const silence = runs.map((r) => r.maxSilence).sort((a, b) => a - b);
  const noProg = runs.map((r) => r.maxNoProgress).sort((a, b) => a - b);
  console.log("\n表 4  空档（离「无聊」最近的可测量）");
  console.log("─".repeat(56));
  console.log(`  最长静默空档    中位 ${median(silence).toFixed(1)}s   最差 ${silence[silence.length - 1].toFixed(1)}s`);
  console.log(`  最长无进展空档  中位 ${median(noProg).toFixed(1)}s   最差 ${noProg[noProg.length - 1].toFixed(1)}s`);
  console.log("");
  console.log("  每分钟进展事件数（-1 = 没活到这一分钟）");
  for (let m = 0; m < 5; m += 1) {
    const vals = runs.map((r) => r.progressPerMinute[m]).filter((v) => v >= 0);
    if (!vals.length) { console.log(`    第 ${m + 1} 分钟   —（无人到达）`); continue; }
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const bar = "▉".repeat(Math.min(30, Math.round(avg)));
    console.log(`    第 ${m + 1} 分钟  ${avg.toFixed(1).padStart(5)}  (n=${String(vals.length).padStart(2)})  ${bar}`);
  }
  console.log("\n注：机器人不会因为无聊退出，所以这张表只给「客观上有没有事发生」，");
  console.log("      给不了「玩家觉不觉得有意思」。要后者只有 Playtest 录像。");
}

describe("autoplay", () => {
  it(`跑 ${RUNS} 局（${DIFFICULTY}）`, () => {
    const runs = runBatch(RUNS, DIFFICULTY);
    tableRuns(runs);
    tableDuration(runs);
    tableDeaths(runs);
    tableSession(runs);
    tableBoredom(runs);
  }, 600_000);
});
