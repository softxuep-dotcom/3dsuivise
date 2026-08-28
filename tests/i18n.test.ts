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
import { id } from "../src/i18n/locales/id";

/*
 * 文案的三种坏法，肉眼都很难看出来，而且都是“改一处忘多处”造成的：
 *
 *   1. 某种语言少了一个键 —— 静默回退英文，只有那个语种的玩家会看到夹生页面
 *   2. 占位符对不上 —— 少一个 {metres} 就丢信息，多一个就露出花括号
 *   3. 数值和别的语言不一致 —— 平衡改了只更了 en，其余十二种还在说旧数字
 *
 * 第 3 条最阴：装备文案里写死了攻击力、防御、闪避%、反伤%、扫角，
 * 一共几十个数字散在十三种语言里。数字是语言无关的，所以可以互相校验。
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
  id,
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

describe("多语言 · 广告复活不限次数", () => {
  it.each(Object.entries(ALL_LOCALES))("%s 的广告复活按钮不再显示剩余次数", (_lang, table) => {
    expect(table["revive.offer"]).not.toMatch(/\{count\}/);
    expect(table["revive.offer"].length).toBeGreaterThan(0);
  });
});

describe("多语言 · 品牌与核心目标用词", () => {
  const hardLabels: Record<string, string> = {
    en: "Hard",
    zh: "困难",
    fr: "Difficile",
    de: "Schwer",
    it: "Difficile",
    "pt-BR": "Difícil",
    es: "Difícil",
    tr: "Zor",
    ja: "ハード",
    ru: "Сложно",
    ko: "어려움",
    vi: "Khó",
    id: "Sulit",
  };

  const loadedTerms: Record<string, RegExp> = {
    en: /\bloaded\b/i,
    zh: /装车/,
    fr: /charg/,
    de: /verladen/i,
    it: /caricat/i,
    "pt-BR": /carregad/i,
    es: /cargad/i,
    tr: /yüklendi/i,
    ja: /積/,
    ru: /загружен/i,
    ko: /실었|적재|싣고/,
    vi: /chất/i,
    id: /dimuat/i,
  };

  it.each(Object.entries(ALL_LOCALES))("%s 保留统一的英文游戏标题", (_lang, table) => {
    expect(table["intro.title"]).toBe("Last Truck Out");
  });

  it.each(Object.entries(ALL_LOCALES))("%s 的最高难度使用标准“困难”名称", (lang, table) => {
    expect(table["difficulty.insane"]).toBe(hardLabels[lang]);
  });

  it.each(Object.entries(ALL_LOCALES))("%s 始终把六桶油描述为装车", (lang, table) => {
    const term = loadedTerms[lang];
    for (const key of ["msg.fuelFull", "sim.fuelReady", "toast.truckDepart"]) {
      expect(table[key], key).toMatch(term);
    }
  });
});

/*
 * 中文分开说的两件事，译文不许合成一个词。
 *
 * 这条守的是一类**结构检查抓不到的翻译缺陷**：键不缺、占位符对得上、也不是把英文
 * 原文留在那儿，但两个不同的行动被译成了同一个词，按钮于是不再区分它们。
 *
 * 实际抓到过四种语言同时犯：`action.cactus`（割仙人掌取汁）和 `action.chop`
 * （砍下枯枝入包）在 fr 都是 "Couper"、it 都是 "Taglia"、pt-BR 都是 "Cortar"、
 * id 都是 "Potong" —— 一个取水一个取柴，而这游戏教玩家的方式就是**按钮在用得上
 * 的那一刻自己说出来**。中文玩家看到「取汁 / 砍柴」立刻分得清，那四种语言的玩家
 * 两次看到同一个词。
 *
 * 判据挂在**中文**上而不是英文：中文是源语言，它分开写就说明这是两件事
 * （英文自己也可能把两件事合成一个词，那时它不能当基准）。
 */
describe("多语言 · 中文区分的键，译文不许撞词", () => {
  const family = (key: string) => key.split(".")[0];
  const families = [...new Set(enKeys.map(family))].filter(
    (f) => enKeys.filter((k) => family(k) === f).length > 1,
  );

  it.each(Object.entries(ALL_LOCALES))("%s 没有把中文分开的两个键译成同一个词", (lang, table) => {
    const clashes: string[] = [];
    for (const f of families) {
      const keys = enKeys.filter((k) => family(k) === f);
      const byValue = new Map<string, string[]>();
      for (const key of keys) {
        const value = table[key];
        if (!value || value.length < 2) continue;
        byValue.set(value, [...(byValue.get(value) ?? []), key]);
      }
      for (const [value, dup] of byValue) {
        if (dup.length < 2) continue;
        // 中文自己也写成同一句的，本来就该一样 —— 不是译文丢了区分。
        if (new Set(dup.map((k) => zh[k])).size === 1) continue;
        clashes.push(`${dup.join(" 与 ")} 都是 "${value}"（中文分别是 ${dup.map((k) => zh[k]).join(" / ")}）`);
      }
    }
    expect(clashes, `${lang} 撞词：\n  ${clashes.join("\n  ")}`).toEqual([]);
  });
});

/*
 * 开场第一句必须说"装"，不许说"灌满"。
 *
 * sim.7 是 !clockStarted 时的目标行 —— 从游戏加载完到玩家迈出第一步为止都是它，
 * 全游戏最多人看到的一句话（见 ObjectiveNarrator.getObjective 里那段注释：
 * 「Poki 那批会话中位数只有 52 秒，绝大多数人从头到尾没被告知过目标是什么」）。
 *
 * 而这游戏**没有任何加油动作** —— 油桶是整桶搬起来、走过去、放进车斗的。
 * 中文原文曾经写作「加满 N 桶油」，六种欧洲语言照着直译成 füllen / Llena /
 * Remplissez / Riempi / Encha / doldur，于是每种语言的开场白都和它自己
 * hint.loadFuel 里的动词（Charger / Carica / Carregue / Kasaya yükle）打架。
 *
 * 上面那条 loadedTerms 管不到它：那些正则匹配的是**完成态**（loaded / 装车 /
 * verladen），而这里是祈使句。所以按词干再钉一遍，并且明确禁掉"灌满"系动词。
 */
describe("多语言 · 开场第一句说装载而不是灌满", () => {
  const loadStem: Record<string, RegExp> = {
    en: /load/i, zh: /装/, fr: /charg/i, de: /laden/i, it: /caric/i,
    "pt-BR": /carreg/i, es: /carg/i, tr: /yükle/i, ja: /積/,
    ru: /загруз/i, ko: /싣|적재/, vi: /chất/i, id: /muat/i,
  };
  const fillVerb: Record<string, RegExp> = {
    en: /\bfill/i, zh: /加满|灌/, fr: /rempli/i, de: /füll/i, it: /riempi/i,
    "pt-BR": /\bench/i, es: /llena|rellena/i, tr: /doldur/i, ja: /満た/,
    ru: /наполн/i, ko: /채우|가득/, vi: /đổ đầy|làm đầy/i, id: /isi penuh|penuhi/i,
  };

  it.each(Object.entries(ALL_LOCALES))("%s 的 sim.7 用装载动词", (lang, table) => {
    expect(table["sim.7"], `${lang} sim.7 没用装载动词：${table["sim.7"]}`).toMatch(loadStem[lang]);
  });

  it.each(Object.entries(ALL_LOCALES))("%s 的 sim.7 不说灌满", (lang, table) => {
    expect(table["sim.7"], `${lang} sim.7 说了灌满：${table["sim.7"]}`).not.toMatch(fillVerb[lang]);
  });
});

/*
 * 代码里引用的每个键，语言表里都得有。
 *
 * 这条是补一个真踩过的坑：删 sim.32 时先把十三个语言文件里的键删了，
 * 却漏了 ObjectiveNarrator 里那处 `loc("sim.32", …)`。t() 找不到键会**把键名
 * 原样吐到屏幕上**（见 i18n/index.ts 的注释：「界面上出现 msg.foo.bar 很丑，
 * 但比空白好定位」），而当时 315 个测试全绿 —— 没有任何一条在管这件事。
 *
 * 反过来的方向（表里有、代码不用）不查：那是死键，不影响玩家，
 * 而且 index.html 的 data-i18n 和动态拼出来的键都会造成假阳性。
 */
describe("多语言 · 代码引用的键必须存在", () => {
  // 用 import.meta.glob 读源码，理由和 moduleGraph.test.ts 一样：
  // 这个仓库没装 @types/node，而 Vite 的 ?raw 在 vitest 里本来就通。
  const sources = import.meta.glob("../src/**/*.ts", {
    query: "?raw", import: "default", eager: true,
  }) as Record<string, string>;

  it("扫到的源文件足够多（否则这条测试等于没测）", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it("loc() / t() 里写死的键在英文表里都有", () => {
    const missing: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (path.includes("/i18n/locales/")) continue;
      for (const m of src.matchAll(/\b(?:loc|t|tx)\(\s*"([a-z][\w.-]*\.[\w.-]+)"/gi)) {
        // 复数变体（key_one / key_other）由 t() 自己回退，只查基名。
        if (en[m[1]] === undefined) missing.push(`${path.replace(/^\.\.\//, "")}: ${m[1]}`);
      }
    }
    expect(missing, `这些键代码在用但英文表里没有：\n  ${missing.join("\n  ")}`).toEqual([]);
  });
});
