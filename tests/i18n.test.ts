import { describe, expect, it } from "vitest";
import html from "../index.html?raw";
import { SUPPORTED_LOCALES } from "../src/i18n";
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
 * 文案的三种坏法，肉眼都很难看出来，而且都是“改一处忘多处”造成的：
 *
 *   1. 某种语言少了一个键 —— 静默回退英文，只有那个语种的玩家会看到夹生页面
 *   2. 占位符对不上 —— 少一个 {metres} 就丢信息，多一个就露出花括号
 *   3. 数值和别的语言不一致 —— 平衡改了只更了 en，其余十一种还在说旧数字
 *
 * 第 3 条最阴：装备文案里写死了攻击力、防御、闪避%、反伤%、扫角，
 * 一共几十个数字散在十二种语言里。数字是语言无关的，所以可以互相校验。
 *
 * **新增语言必须同时加进 LOCALES**，否则这三条测试对它等于不存在 ——
 * es / tr / ja 就这么漏了一整轮。
 */

const LOCALES: Record<string, Record<string, string>> = {
  zh,
  fr,
  de,
  it: itIT,
  "pt-BR": ptBR,
  es,
  tr,
  ja,
  ru,
  ko,
  vi,
};
const ALL_LOCALES: Record<string, Record<string, string>> = { en, ...LOCALES };
const enKeys = Object.keys(en).sort();

/**
 * 主包下载前，index.html 会先用一小份内联文案画开场页。它必须和完整语言表一致，
 * 否则慢网络下会先显示一种说法，语言 chunk 到达后再突然跳成另一种。
 */
const initialCopySource = html.match(/var initialCopy = (\{[\s\S]*?\r?\n\s*\});\r?\n\s*var activeInitialCopy/);
if (!initialCopySource) throw new Error("index.html 里找不到 initialCopy");
const initialCopy = Function(`"use strict"; return (${initialCopySource[1]});`)() as Record<
  string,
  Record<string, string>
>;
const INITIAL_KEYS = [
  "intro.title",
  "intro.tagline",
  "intro.phase.day",
  "intro.verb1",
  "intro.phase.night",
  "intro.verb2",
  "intro.verbs.aria",
  "boot.landscapeHint",
] as const;

describe("多语言 · 结构对齐", () => {
  it("语言注册表、完整表与启动页内联表覆盖同一组语言", () => {
    const registered = SUPPORTED_LOCALES.map((entry) => entry.code).sort();
    expect(Object.keys(ALL_LOCALES).sort()).toEqual(registered);
    expect(Object.keys(initialCopy).sort()).toEqual(registered);
  });

  it.each(SUPPORTED_LOCALES)("$code 的启动页文案与完整语言表一致", ({ code }) => {
    for (const key of INITIAL_KEYS) expect(initialCopy[code][key], key).toBe(ALL_LOCALES[code][key]);
    expect(initialCopy[code].boot.length).toBeGreaterThan(0);
  });

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

describe("多语言 · 不显示劳力消耗数值", () => {
  const forbiddenPlaceholders: Record<string, RegExp> = {
    "build.button": /\{stamina\}/,
    "msg.5": /\{v[01]\}/,
    "sim.26": /\{v0\}/,
    "hint.cactus": /\{cost\}/,
    "hint.chop": /\{cost\}/,
    "hint.mine": /\{cost\}/,
    "hint.takeWood": /\{cost\}/,
    "hint.urgentCactus": /\{cost\}/,
    "hint.urgentWell": /\{cost\}/,
    "hint.well": /\{cost\}/,
  };

  it.each(Object.entries(ALL_LOCALES))("%s 不再把具体劳力成本写进界面", (_lang, table) => {
    for (const [key, pattern] of Object.entries(forbiddenPlaceholders)) {
      expect(table[key], key).not.toMatch(pattern);
    }
  });
});
