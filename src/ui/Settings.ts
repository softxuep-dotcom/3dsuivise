import type { Difficulty } from "../game/simulation/difficulty";
import { DEFAULT_DIFFICULTY, normalizeDifficulty } from "../game/simulation/difficulty";

/**
 * 玩家设置。目前只有难度一项。
 *
 * 和 Records 一样：localStorage 在隐私模式、被禁用的存储、跨域 iframe
 * （Poki 就是 iframe 嵌入）下都可能直接抛异常。任何一步失败都静默降级到默认档，
 * 绝不能把游戏带崩 —— 玩不了远比"设置没记住"严重。
 *
 * `?difficulty=` 优先于存储，方便直接分享/测试某一档，不用去点菜单。
 */
const STORAGE_KEY = "desert-survivor.settings.v1";

export function loadDifficulty(): Difficulty {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("difficulty");
    if (fromQuery) return normalizeDifficulty(fromQuery);
  } catch { /* URL 拿不到就走存储 */ }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DIFFICULTY;
    return normalizeDifficulty((JSON.parse(raw) as { difficulty?: unknown })?.difficulty);
  } catch {
    return DEFAULT_DIFFICULTY;
  }
}

export function saveDifficulty(difficulty: Difficulty): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ difficulty: normalizeDifficulty(difficulty) }));
  } catch {
    // 存不下就算了：本局照常按选中的档跑，只是下次打开回到默认。
  }
}

/*
 * 开局计数。只用来决定这一局落在哪座营地（见 createWorld.pickStartCamp）：
 * 0 = 第一局，必须是设计好的那张图。
 *
 * **内存里那份才是准绳，localStorage 只是尽力而为的缓存。**
 *
 * 一开始写成"写进存储、再读回来"，那是错的：Poki 把游戏嵌在**跨域 iframe** 里，
 * 第三方存储被拦时 localStorage 直接抛异常。两个函数都静默降级的话，
 * loadRunIndex() 永远返回 0、pickStartCamp(0) 永远是蓝图那座营地 ——
 * **每次重开都回到同一张图**，而且不报错，只表现为"重开还在老地方"。
 *
 * 软重启不刷页面了，所以模块级变量在整个会话里活着，存储能不能用都不影响轮换。
 * 存储只多做一件事：玩家关掉页面明天再来，接着上次的位置继续转。
 */
const RUN_KEY = "desert-survivor.runs.v1";

/** 本次会话的开局序号。null = 还没从存储里取过初值。 */
let runIndex: number | null = null;

export function loadRunIndex(): number {
  if (runIndex !== null) return runIndex;
  try {
    const raw = window.localStorage.getItem(RUN_KEY);
    const runs = raw === null ? 0 : (JSON.parse(raw) as { runs?: unknown })?.runs;
    runIndex = typeof runs === "number" && Number.isInteger(runs) && runs > 0 ? runs : 0;
  } catch {
    runIndex = 0;
  }
  return runIndex;
}

/** 点了"再来一局"才加一。返回新的序号，调用方不必再 load 一次。 */
export function bumpRunIndex(): number {
  const next = loadRunIndex() + 1;
  runIndex = next;
  try {
    window.localStorage.setItem(RUN_KEY, JSON.stringify({ runs: next }));
  } catch {
    // 存不下不影响本次会话：轮换读的是上面那个内存变量。
  }
  return next;
}
