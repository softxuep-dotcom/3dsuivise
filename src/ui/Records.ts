/**
 * 跨局最佳记录。
 *
 * Poki 这类平台的玩家一次玩十几分钟、反复回来，而我们此前**死了全部归零、
 * 每局起点一模一样** —— 没有任何"再来一局"的理由。这是最便宜的一层元进度：
 * 不解锁任何东西，只把上一次的高度留在开场页上。
 *
 * 刻意不做存档续玩：单局 10~16 分钟，中断恢复的复杂度远高于收益，
 * 而"记录"只需要三个整数。
 */

import { t } from "../i18n";

const STORAGE_KEY = "desert-survivor.records.v1";

export interface Records {
  /** 活到的最高天数。 */
  bestDay: number;
  /** 单局最多猎杀。 */
  bestKills: number;
  /** 通关次数。 */
  victories: number;
  /** 总共玩过多少局。 */
  runs: number;
}

const EMPTY: Records = { bestDay: 0, bestKills: 0, victories: 0, runs: 0 };

/**
 * 隐私模式、被禁用的存储、以及跨域 iframe（Poki 就是 iframe 嵌入）都可能让
 * localStorage 直接抛异常。记录是锦上添花，任何一步失败都必须静默降级，
 * 绝不能把游戏本身带崩。
 */
function read(): Records {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<Records>;
    return {
      bestDay: Number(parsed.bestDay) || 0,
      bestKills: Number(parsed.bestKills) || 0,
      victories: Number(parsed.victories) || 0,
      runs: Number(parsed.runs) || 0,
    };
  } catch {
    return { ...EMPTY };
  }
}

function write(records: Records): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // 存不下就算了，本局照常显示。
  }
}

export function loadRecords(): Records {
  return read();
}

export interface RunResult {
  day: number;
  kills: number;
  won: boolean;
}

/** 结算一局，返回更新后的记录以及这一局刷新了哪几项。 */
export function submitRun(result: RunResult): { records: Records; brokeDay: boolean; brokeKills: boolean } {
  const previous = read();
  const brokeDay = result.day > previous.bestDay;
  const brokeKills = result.kills > previous.bestKills;
  const records: Records = {
    bestDay: Math.max(previous.bestDay, result.day),
    bestKills: Math.max(previous.bestKills, result.kills),
    victories: previous.victories + (result.won ? 1 : 0),
    runs: previous.runs + 1,
  };
  write(records);
  return { records, brokeDay, brokeKills };
}

/** 开场页那一行；从没玩过时返回 null，不占版面。 */
export function describeRecords(records: Records): string | null {
  if (records.runs <= 0) return null;
  const parts = [t("records.bestDay", { day: records.bestDay }), t("records.bestKills", { kills: records.bestKills })];
  if (records.victories > 0) parts.push(t("records.victories", { count: records.victories }));
  return parts.join(" · ");
}
