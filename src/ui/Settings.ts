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
