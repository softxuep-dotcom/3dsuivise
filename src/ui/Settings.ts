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
 * 0 = 这台机器上的第一局，必须是设计好的那张图。
 *
 * 和难度、纪录一样静默降级 —— localStorage 在隐私模式和跨域 iframe（Poki）下
 * 会直接抛。存不下的后果只是永远玩首局那张图，不影响可玩性。
 */
const RUN_KEY = "desert-survivor.runs.v1";

export function loadRunIndex(): number {
  try {
    const raw = window.localStorage.getItem(RUN_KEY);
    if (!raw) return 0;
    const runs = (JSON.parse(raw) as { runs?: unknown })?.runs;
    return typeof runs === "number" && Number.isInteger(runs) && runs > 0 ? runs : 0;
  } catch {
    return 0;
  }
}

/** 点了"再来一局"才加一 —— 重开走的是整页刷新，计数得先落盘。 */
export function bumpRunIndex(): void {
  try {
    window.localStorage.setItem(RUN_KEY, JSON.stringify({ runs: loadRunIndex() + 1 }));
  } catch {
    // 同上：存不下就一直是首局那张图。
  }
}
