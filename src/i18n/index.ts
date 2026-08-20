import type { LocalizedText } from "../game/simulation/types";
import { en } from "./locales/en";

/**
 * 多语言内核。
 *
 * 没有引第三方库：需要的只有查表、插值、语言检测、回退四件事，
 * 而 i18next 是 40KB 而主包已经 900KB+。唯一真正用得上的高级特性是**英文复数**
 * （"1 wolf" / "3 wolves"），交给浏览器原生的 Intl.PluralRules，零体积。
 *
 * 键名一律用**语义**而不是英文原文 —— 拿原文当键的话，改一次文案就等于改一次键，
 * 所有语言文件跟着失效。
 *
 * ## 为什么除英文外都是动态 import
 *
 * 原先六种语言全是静态 import，于是**西班牙玩家要下载德语、意语、葡语、中文的
 * 全部文案**。实测语言表占整包 gzip 的 11%（37 KB / 336 KB），再补西/土/日/韩/俄
 * 会翻倍到 ~70 KB —— 而任何一个玩家用得上的只有其中一份。
 *
 * 改成 `() => import()` 之后 Vite 会把每种语言切成独立 chunk，按需取。
 * **英文是唯一的例外，必须常驻主包** —— 它是逐键回退表（见 t()），
 * 任何语言缺一个键都要立刻拿它顶上，不能是个 Promise。
 */

/**
 * 语言注册表。**加一种语言只需要在这里加一行 + 放一个 locales/xx.ts**。
 *
 * 之前 Locale 类型、SUPPORTED_LOCALES、LOCALE_NAMES、TABLES 是四份手工同步的
 * 平行结构，加语言要同时改四处、漏一处就是运行时崩。现在类型从这个数组推导出来，
 * 漏了编译不过。
 *
 * `htmlLang` 单独存是因为它和 code 不总是一致（zh → zh-CN），
 * 而它影响浏览器断词、默认字体和屏幕朗读。
 * `label` 永远用该语言自己的写法，不翻译 —— 找自己母语的人不认识 "German"。
 */
export const SUPPORTED_LOCALES = [
  { code: "en", htmlLang: "en", label: "English" },
  { code: "zh", htmlLang: "zh-CN", label: "中文" },
  { code: "fr", htmlLang: "fr", label: "Français" },
  { code: "de", htmlLang: "de", label: "Deutsch" },
  { code: "it", htmlLang: "it", label: "Italiano" },
  { code: "pt-BR", htmlLang: "pt-BR", label: "Português (Brasil)" },
  { code: "es", htmlLang: "es", label: "Español" },
  { code: "tr", htmlLang: "tr", label: "Türkçe" },
  { code: "ja", htmlLang: "ja", label: "日本語" },
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number]["code"];
export type LocaleMeta = (typeof SUPPORTED_LOCALES)[number];

type Table = Record<string, string>;

/** 每种语言怎么取。英文直接给现成的表，其余按需下载。 */
const LOADERS: Record<Locale, () => Promise<Table>> = {
  en: () => Promise.resolve(en),
  zh: () => import("./locales/zh").then((m) => m.zh),
  fr: () => import("./locales/fr").then((m) => m.fr),
  de: () => import("./locales/de").then((m) => m.de),
  it: () => import("./locales/it").then((m) => m.it),
  "pt-BR": () => import("./locales/pt-BR").then((m) => m.ptBR),
  es: () => import("./locales/es").then((m) => m.es),
  tr: () => import("./locales/tr").then((m) => m.tr),
  ja: () => import("./locales/ja").then((m) => m.ja),
};

const FALLBACK: Locale = "en";
const STORAGE_KEY = "desert-survivor.locale";

/** 下过的语言留着，来回切不重复下载。 */
const loaded = new Map<Locale, Table>([["en", en]]);
const listeners = new Set<(locale: Locale) => void>();

let current: Locale = FALLBACK;
let table: Table = en;
let pluralRules = new Intl.PluralRules("en");

function metaOf(locale: Locale): LocaleMeta {
  return SUPPORTED_LOCALES.find((entry) => entry.code === locale) ?? SUPPORTED_LOCALES[0];
}

/**
 * 检测顺序：`?lang=` > **玩家在设置里选过的** > 浏览器 > 英文。
 *
 * 存储那一档从最后挪到了第二 —— 以前没有语言选择器，存储里只可能是旧版本留下的
 * 陈年选择，让它压过浏览器语言会把中文浏览器永久锁成英文。现在设置里有了选择器，
 * 存的是玩家刚刚做的明确决定，**它就该赢过浏览器的猜测**。
 */
export function detectLocale(): Locale {
  const fromQuery = matchLocale(new URLSearchParams(window.location.search).get("lang"));
  if (fromQuery) return fromQuery;

  try {
    const stored = matchLocale(window.localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // 隐私模式 / 跨域 iframe 下 localStorage 会直接抛，静默降级。
  }

  // navigator.languages 是按偏好排序的，逐个规范化后取第一个我们支持的。
  for (const tag of navigator.languages ?? [navigator.language]) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return FALLBACK;
}

/** 地区变体落到已有翻译；葡语当前采用巴西版本。 */
function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const normalized = tag.trim().toLowerCase().replace("_", "-");
  const base = normalized.split("-")[0];
  if (base === "pt") return "pt-BR";
  return SUPPORTED_LOCALES.find((entry) => entry.code.toLowerCase() === base)?.code ?? null;
}

export function getLocale(): Locale {
  return current;
}

/** 给设置里的语言下拉用。 */
export function getSupportedLocales(): readonly LocaleMeta[] {
  return SUPPORTED_LOCALES;
}

/**
 * 切语言。**异步**，因为语言表是按需下载的。
 *
 * 下载失败（离线、chunk 404）时保持原语言不动并返回 false ——
 * 半途把 current 改掉但表没到，界面会整片回退成英文，比不切更糟。
 */
export async function setLocale(locale: Locale, remember = false): Promise<boolean> {
  const target = SUPPORTED_LOCALES.some((entry) => entry.code === locale) ? locale : FALLBACK;
  if (!loaded.has(target)) {
    try {
      loaded.set(target, await LOADERS[target]());
    } catch {
      return false;
    }
  }
  current = target;
  table = loaded.get(target) ?? en;
  pluralRules = new Intl.PluralRules(target);
  document.documentElement.lang = metaOf(target).htmlLang;
  if (remember) {
    try {
      window.localStorage.setItem(STORAGE_KEY, target);
    } catch { /* 存不下就算了，不影响本局 */ }
  }
  for (const listener of listeners) listener(target);
  return true;
}

/** 语言变化时重刷界面用。返回退订函数。 */
export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * 取一条文案。
 *
 * - `params` 里的值按 `{name}` 占位替换。
 * - 传了 `count` 时先试复数变体（`key_one` / `key_other`），没有再退回 `key`。
 *   中文没有复数变体，自然就走回退，不用为它写两份。
 * - 当前语言缺键时回退到英文；英文也没有就把键本身吐出来 ——
 *   界面上出现 `msg.foo.bar` 很丑，但比空白好定位。
 */
export function t(key: string, params?: LocalizedText["params"]): string {
  let template: string | undefined;

  if (params && typeof params.count === "number") {
    const variant = `${key}_${pluralRules.select(params.count)}`;
    template = table[variant] ?? en[variant];
  }
  template ??= table[key] ?? en[key];
  if (template === undefined) return key;
  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    // 参数本身也可能是一条待渲染文案（"获得铁矿 · {下一阶提示}"），递归展开。
    if (typeof value === "object" && value !== null && "key" in value) return tx(value as LocalizedText);
    return String(value);
  });
}

/** 渲染模拟层产出的一条 `{ key, params }`。 */
export function tx(text: LocalizedText): string {
  return t(text.key, text.params as Record<string, string | number> | undefined);
}

/**
 * 把 DOM 里所有 `data-i18n` 填上文案。
 *
 *   data-i18n="key"            → textContent
 *   data-i18n-html="key"       → innerHTML（只用于文案里本来就带 <br> 的那几条）
 *   data-i18n-attr="aria-label:key,title:key2"
 *
 * 开场页的静态文案走这条路：主包到达前它们是 index.html 里写死的英文，
 * 主包一到就按检测到的语言重填。
 */
export function applyStaticText(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
    const key = node.dataset.i18nHtml;
    if (key) node.innerHTML = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-attr]")) {
    for (const pair of (node.dataset.i18nAttr ?? "").split(",")) {
      const [attribute, key] = pair.split(":").map((part) => part.trim());
      if (attribute && key) node.setAttribute(attribute, t(key));
    }
  }
}
