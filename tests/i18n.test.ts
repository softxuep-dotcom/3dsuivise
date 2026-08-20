import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/locales/en";
import { zh } from "../src/i18n/locales/zh";
import { de } from "../src/i18n/locales/de";
import { fr } from "../src/i18n/locales/fr";
import { it as itIT } from "../src/i18n/locales/it";
import { ptBR } from "../src/i18n/locales/pt-BR";

/*
 * 文案的三种坏法，肉眼都很难看出来，而且都是"改一处忘六处"造成的：
 *
 *   1. 某种语言少了一个键 —— 静默回退英文，只有那个语种的玩家会看到夹生页面
 *   2. 占位符对不上 —— 少一个 {metres} 就丢信息，多一个就露出花括号
 *   3. 数值和别的语言不一致 —— 平衡改了只更了 en，其余五种还在说旧数字
 *
 * 第 3 条最阴：装备文案里写死了攻击力、防御、闪避%、反伤%、扫角，
 * 一共几十个数字散在六种语言里。数字是语言无关的，所以可以互相校验。
 */

const LOCALES: Record<string, Record<string, string>> = { zh, fr, de, it: itIT, "pt-BR": ptBR };
const enKeys = Object.keys(en).sort();

describe("多语言 · 结构对齐", () => {
  it.each(Object.keys(LOCALES))("%s 的键集和英文完全一致", (lang) => {
    expect(Object.keys(LOCALES[lang]).sort()).toEqual(enKeys);
  });

  it.each(Object.keys(LOCALES))("%s 的占位符和英文完全一致", (lang) => {
    const table = LOCALES[lang];
    const mismatched = enKeys.filter((key) => {
      const of = (s: string) => (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort().join(",");
      return of(en[key]) !== of(table[key]);
    });
    expect(mismatched, `这些键的占位符对不上：${mismatched.join(", ")}`).toEqual([]);
  });
});

describe("多语言 · 数值一致", () => {
  /**
   * 装备文案（equip.*）里写死的数字必须各语言一致。
   * 罗马数字（Ⅰ/Ⅱ/Ⅲ）和纯格式串不算 —— 前者不是数值，后者没有数字。
   */
  const equipKeys = enKeys.filter((k) => k.startsWith("equip.") && /\d/.test(en[k]));

  it("装备文案至少覆盖到主要档位（否则这条测试等于没测）", () => {
    expect(equipKeys.length).toBeGreaterThan(15);
  });

  it.each(Object.keys(LOCALES))("%s 的装备数值和英文逐个相同", (lang) => {
    const table = LOCALES[lang];
    const nums = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).join(",");
    const bad = equipKeys
      .filter((key) => nums(en[key]) !== nums(table[key]))
      .map((key) => `${key}: en[${nums(en[key])}] ≠ ${lang}[${nums(table[key])}]`);
    expect(bad, `装备数值不一致：\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});
