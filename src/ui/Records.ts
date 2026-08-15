/**
 * 跨局最佳记录。
 *
 * Poki 这类平台的玩家一次玩十几分钟、反复回来，而我们此前**死了全部归零、
 * 每局起点一模一样** —— 没有任何"再来一局"的理由。这是最便宜的一层元进度：
 * 不解锁任何东西，只把上一次的高度留在开场页上。
 *
 * 刻意不做存档续玩：单局 10~16 分钟，中断恢复的复杂度远高于收益。
 *
 * ## 记什么，是跟着通关条件走的
 *
 * 旧的三项是「最好活到第几天 / 单局最多猎杀 / 通关次数」。通关条件换成
 * "加满卡车开出去"之后，前两项**同时失效，而且方向是反的**：
 *
 *   - 活得久不再是好事 —— 打得好的人第 2 天就走了，记录反而比新手低；
 *   - 猎杀数变成纯副产物 —— 绕开狗巢猥琐找油是官方认可的一条通关路线，
 *     那条路线打完全程可能只杀几只，记录板却会告诉他"你打得很差"。
 *
 * 换成两项，一项给赢家、一项给输家：
 *
 *   - **最快脱出**（用时 + 第几天）：只有通关才刷新，越小越好，是回访的钩子；
 *   - **最远进度**（装了几桶）：**没通关的局也刷得动**。新玩家前几局大概率赢不了，
 *     没有这一项他就永远看不到自己在变强 —— 而这正是记录板存在的全部理由。
 */

import { t } from "../i18n";
import type { Difficulty } from "../game/simulation/difficulty";
import { DIFFICULTIES } from "../game/simulation/difficulty";

// v1 存的是 bestDay/bestKills，两项在新目标下都没有意义了，
// 换 key 而不是迁移：旧值翻译不成新值，硬迁只会显示一个假记录。
//
// v2 → v3 同理：加了难度之后，"令人发狂通关"和"简单通关"共用一条最佳记录
// 就没有意义了 —— 一个 4 分钟的简单局会永久压住一个 9 分钟的发狂局。
// v2 的旧值属于哪个难度也已经无从判断（那时只有现在的简单档），
// 硬塞进简单档看似合理，但玩家会看到一条自己没打过的"简单档记录"。照旧换 key。
const STORAGE_KEY = "desert-survivor.records.v3";

export interface Records {
  /** 最快通关用时（秒）；0 表示还没通关过。 */
  bestEscapeSeconds: number;
  /** 最快那一局是第几天走的。 */
  bestEscapeDay: number;
  /** 单局装进车里最多几桶油（含没通关的局）。 */
  bestFuel: number;
  /** 通关次数。 */
  victories: number;
  /** 总共玩过多少局。 */
  runs: number;
}

const EMPTY: Records = { bestEscapeSeconds: 0, bestEscapeDay: 0, bestFuel: 0, victories: 0, runs: 0 };

/** 存储体：一个难度一套记录。 */
type RecordBook = Record<Difficulty, Records>;

function emptyBook(): RecordBook {
  return Object.fromEntries(DIFFICULTIES.map((d) => [d, { ...EMPTY }])) as RecordBook;
}

function sanitize(value: Partial<Records> | undefined): Records {
  return {
    bestEscapeSeconds: Number(value?.bestEscapeSeconds) || 0,
    bestEscapeDay: Number(value?.bestEscapeDay) || 0,
    bestFuel: Number(value?.bestFuel) || 0,
    victories: Number(value?.victories) || 0,
    runs: Number(value?.runs) || 0,
  };
}

/**
 * 隐私模式、被禁用的存储、以及跨域 iframe（Poki 就是 iframe 嵌入）都可能让
 * localStorage 直接抛异常。记录是锦上添花，任何一步失败都必须静默降级，
 * 绝不能把游戏本身带崩。
 */
function read(): RecordBook {
  const book = emptyBook();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return book;
    const parsed = JSON.parse(raw) as Partial<Record<Difficulty, Partial<Records>>>;
    for (const difficulty of DIFFICULTIES) book[difficulty] = sanitize(parsed?.[difficulty]);
    return book;
  } catch {
    return book;
  }
}

function write(book: RecordBook): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(book));
  } catch {
    // 存不下就算了，本局照常显示。
  }
}

export function loadRecords(difficulty: Difficulty): Records {
  return read()[difficulty];
}

/** 把秒数写成 M:SS —— 一局十几分钟，小时位永远用不上。 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export interface RunResult {
  day: number;
  /** 从第一次移动算起的本局时长（秒）。 */
  seconds: number;
  /** 结束时车里装了几桶。 */
  fuel: number;
  won: boolean;
  /** 这一局跑的是哪个难度。记录只和同难度比。 */
  difficulty: Difficulty;
}

/** 结算一局，返回更新后的记录以及这一局刷新了哪几项。 */
export function submitRun(result: RunResult): {
  records: Records;
  brokeEscape: boolean;
  brokeFuel: boolean;
} {
  const book = read();
  const previous = book[result.difficulty];
  // 最快脱出只有通关才算；0 是"还没通关过"的哨兵，所以第一次通关无条件破纪录。
  const brokeEscape = result.won
    && (previous.bestEscapeSeconds <= 0 || result.seconds < previous.bestEscapeSeconds);
  const brokeFuel = result.fuel > previous.bestFuel;
  const records: Records = {
    bestEscapeSeconds: brokeEscape ? result.seconds : previous.bestEscapeSeconds,
    bestEscapeDay: brokeEscape ? result.day : previous.bestEscapeDay,
    bestFuel: Math.max(previous.bestFuel, result.fuel),
    victories: previous.victories + (result.won ? 1 : 0),
    runs: previous.runs + 1,
  };
  book[result.difficulty] = records;
  write(book);
  return { records, brokeEscape, brokeFuel };
}

/** 开场页那一行；从没玩过时返回 null，不占版面。 */
export function describeRecords(records: Records): string | null {
  if (records.runs <= 0) return null;
  const parts: string[] = [];
  if (records.bestEscapeSeconds > 0) {
    parts.push(t("records.bestEscape", {
      time: formatDuration(records.bestEscapeSeconds),
      day: records.bestEscapeDay,
    }));
    if (records.victories > 1) parts.push(t("records.victories", { count: records.victories }));
  } else {
    // 还没赢过：只说进度，一个字都不提"你还没通关"。
    parts.push(t("records.bestFuel", { fuel: records.bestFuel }));
    parts.push(t("records.runs", { count: records.runs }));
  }
  return parts.join(" · ");
}
