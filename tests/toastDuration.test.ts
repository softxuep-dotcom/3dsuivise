import { describe, expect, it } from "vitest";
import { readingSeconds, toastSeconds } from "../src/ui/ToastDuration";
import { en } from "../src/i18n/locales/en";
import { zh } from "../src/i18n/locales/zh";
import { de } from "../src/i18n/locales/de";
import { fr } from "../src/i18n/locales/fr";
import { it as itIT } from "../src/i18n/locales/it";
import { ptBR } from "../src/i18n/locales/pt-BR";
import { es } from "../src/i18n/locales/es";
import { tr } from "../src/i18n/locales/tr";
import { ja } from "../src/i18n/locales/ja";
import { ru } from "../src/i18n/locales/ru";
import { ko } from "../src/i18n/locales/ko";
import { vi } from "../src/i18n/locales/vi";

/*
 * 这组测试守的不是算术，是**那个 bug 不会再回来**：
 * 六处调用点的常数是对着中文调的，而中文是这十二种语言里最短的一种。
 *
 * 所以两头都要钉住：
 *   - 长语言（法德俄韩日）在固定 3.1 秒下读不完的那一批，现在必须读得完；
 *   - 中文（源语言）的观感不能被顺带改掉 —— 它的常用短句时长必须逐条不变。
 *
 * 只钉 toastSeconds 的输出，不碰 HudController 的队列 —— 那套顶替/作废逻辑
 * 与本次改动无关，它从 showToast 拿到的只是一个更大的数。
 */

const LOCALES: Record<string, Record<string, string>> = {
  zh, en, de, fr, it: itIT, "pt-BR": ptBR, es, tr, ja, ru, ko, vi,
};

/** 模拟层 message 的时长下限，见 HudController 的 event.type === "message" 分支。 */
const MESSAGE_NOMINAL = 3.1;

/** 注意到一条字幕冒出来的固定开销，与 ToastDuration 的 NOTICE_SECONDS 同值。 */
const NOTICE = 1.2;
/**
 * 阅读时长上限，与 ToastDuration 的 MAX_READING_SECONDS 同值。
 *
 * 注意它现在**分两档**：这一档（6 秒）只在后面还有字幕在排队时生效，
 * 独占时放宽到 8 秒。下面这一组用例走的全是默认的 `crowded = true`，
 * 所以读的都是 6 秒这一档；放宽那一档另有一组，见文件末尾。
 */
const CAP = 6;

/**
 * 一条字幕"读得完"的判据。
 *
 * 封顶那一档算通过：超过 6 秒阅读量的文案本来就不该走字幕（实测撞上限的六条
 * 全是帮助页、结算页和目标行，不是 toast），给它们无限时长只会饿死后面排队的指令。
 */
function readable(text: string): boolean {
  return toastSeconds(text, MESSAGE_NOMINAL) >= Math.min(NOTICE + readingSeconds(text), CAP) - 1e-9;
}

describe("字幕时长按实际字数折算", () => {
  /*
   * 中文 13 字以内的句子时长逐条不变（1.2 + 13/7 = 3.06 < 3.1），而这一档
   * 覆盖了源语言的绝大多数文案 —— 也就是说这次改动对中文玩家几乎不可见。
   *
   * 但更长的中文句子**也会**拿到更多时间，这是对的：中文自己在 3.1 秒下
   * 同样有约两成读不完，只是没有德法俄韩日那么糟。不要把这条测试收紧成
   * "中文一律不变"，那会把一个真实的缺陷钉成规范。
   */
  it("中文 13 字以内逐条不变 —— 源语言的观感几乎不受影响", () => {
    const short = Object.values(zh).filter((s) => s.length <= 13 && s.length > 1);
    expect(short.length).toBeGreaterThan(100);
    for (const text of short) {
      expect(toastSeconds(text, MESSAGE_NOMINAL)).toBe(MESSAGE_NOMINAL);
    }
  });

  it("长语言的长句拿到更多时间，中文同长度的句子不会被顶上去", () => {
    // 同一句话的两种语言：法文字符多，所以该多挂；中文短，维持下限。
    const frLong = "Montez dans le camion et quittez ces terres desolees avant la nuit";
    const zhLong = "上车驶离荒原";
    expect(toastSeconds(frLong, MESSAGE_NOMINAL)).toBeGreaterThan(MESSAGE_NOMINAL);
    expect(toastSeconds(zhLong, MESSAGE_NOMINAL)).toBe(MESSAGE_NOMINAL);
  });

  it("nominal 是下限不是时长：发车那条 5 秒不会被短文案缩回去", () => {
    expect(toastSeconds("Go", 5)).toBe(5);
    expect(toastSeconds("发车", 5)).toBe(5);
  });

  // 这条走默认的 crowded = true —— 也就是"后面有东西排队"那一档。
  it("排队时阅读时长封顶 6 秒，但封不掉调用点自己要的更长时间", () => {
    const wall = "x".repeat(4000);
    expect(toastSeconds(wall, MESSAGE_NOMINAL)).toBe(6);
    expect(toastSeconds(wall, 8)).toBe(8);
  });

  it("CJK 与拉丁分开计速：同字符数的中文该比拉丁挂得久", () => {
    expect(readingSeconds("荒原沙海狼群")).toBeGreaterThan(readingSeconds("abcdef"));
  });

  it("十二种语言在旧口径下都有读不完的条目，新口径下一条不剩", () => {
    const before: Record<string, number> = {};
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const texts = Object.values(dict).filter((s) => s.length > 1);
      // 旧口径：所有语言一律 3.1 秒。
      before[locale] = texts.filter((s) => 1.2 + readingSeconds(s) > MESSAGE_NOMINAL).length;
      // 新口径：除了长到封顶的，全部读得完。
      const stillShort = texts.filter((s) => !readable(s));
      expect(stillShort, `${locale} 仍有读不完的条目`).toEqual([]);
    }
    // 旧口径下每种语言都有相当一批读不完 —— 这条钉住"问题当初是真的"。
    for (const [locale, count] of Object.entries(before)) {
      expect(count, `${locale} 在旧口径下本该有读不完的条目`).toBeGreaterThan(20);
    }
    // 而且长语言比源语言更糟：法德俄的受害条数必须多于中文。
    for (const locale of ["fr", "de", "ru"]) {
      expect(before[locale], `${locale} 应比 zh 更受 3.1 秒之害`).toBeGreaterThan(before.zh);
    }
  });
});

/**
 * 独占那一档。
 *
 * 6 秒上限的职责只有一个：别让长文案饿死后面排队的指令（见 HudController 的
 * TOAST_STALE_SECONDS）。所以它只在**确实有东西在排队**时才该收 ——
 * 而 `msg.1`（玩家看到的第一句话）在 t=0 出现时队列是空的，它谁也没饿着。
 *
 * 那 6 秒收掉的东西不小：msg.1 塞了两条指令（「首次移动后开始计时」+
 * 「天黑前添柴并封住入口」），中文 22 个字装得下，德文要 106 个字符。
 * 十二种语言里**八种读不完**，而读得完的四种恰好是 ja / tr / ko / zh ——
 * 这条上限一直在按语言分配"看不看得懂第一夜怎么玩"。
 */
describe("独占时放宽到 8 秒", () => {
  const fill = (raw: string): string => raw.replace(/\{[^}]+\}/g, "12");
  const need = (text: string): number => NOTICE + readingSeconds(text);

  it("十二种语言的开场第一句，独占时都读得完", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const text = fill(dict["msg.1"]);
      expect(
        toastSeconds(text, MESSAGE_NOMINAL, false),
        `${locale} 的 msg.1 独占时应当读得完（需 ${need(text).toFixed(1)}s）`,
      ).toBeGreaterThanOrEqual(need(text) - 1e-9);
    }
  });

  it("最长的那句（德文 msg.1）独占时超过 6 秒，但仍然收得住", () => {
    const text = fill(de["msg.1"]);
    expect(need(text)).toBeGreaterThan(CAP);          // 前提：它确实读不完
    expect(toastSeconds(text, MESSAGE_NOMINAL, false)).toBeGreaterThan(CAP);
    expect(toastSeconds(text, MESSAGE_NOMINAL, false)).toBeLessThanOrEqual(8);
  });

  it("后面有东西排队时，照旧收在 6 秒", () => {
    const text = fill(de["msg.1"]);
    expect(toastSeconds(text, MESSAGE_NOMINAL, true)).toBeCloseTo(CAP, 9);
  });

  it("默认收着 —— 漏传参数不该悄悄放宽", () => {
    const text = fill(de["msg.1"]);
    expect(toastSeconds(text, MESSAGE_NOMINAL)).toBe(toastSeconds(text, MESSAGE_NOMINAL, true));
  });

  it("放宽的是上限不是下限：短句仍然按 nominal 挂", () => {
    expect(toastSeconds("发车", 5, false)).toBe(5);
    expect(toastSeconds(fill(zh["msg.2"]), MESSAGE_NOMINAL, false)).toBeGreaterThanOrEqual(MESSAGE_NOMINAL);
  });

  it("天花板没有被整个拆掉：一堵墙那么长的文案仍然收在 8 秒", () => {
    expect(toastSeconds("x".repeat(4000), MESSAGE_NOMINAL, false)).toBe(8);
  });
});

