import type { LocalizedText } from "../game/simulation/types";
import { en } from "./locales/en";
import { de, fr, it, ptBR } from "./locales/western";
import { zh } from "./locales/zh";

/**
 * 多语言内核。
 *
 * 没有引第三方库：需要的只有查表、插值、语言检测、回退四件事，
 * 而 i18next 是 40KB 而主包已经 900KB+。唯一真正用得上的高级特性是**英文复数**
 * （"1 wolf" / "3 wolves"），交给浏览器原生的 Intl.PluralRules，零体积。
 *
 * 键名一律用**语义**而不是英文原文 —— 拿原文当键的话，改一次文案就等于改一次键，
 * 所有语言文件跟着失效。
 */

export type Locale = "en" | "zh" | "fr" | "de" | "it" | "pt-BR";

export const SUPPORTED_LOCALES: Locale[] = ["en", "zh", "fr", "de", "it", "pt-BR"];

/** 语言自选菜单用的原生名称（永远用该语言自己的写法，不翻译）。 */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  zh: "中文",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  "pt-BR": "Português (Brasil)",
};

const FALLBACK: Locale = "en";
const STORAGE_KEY = "desert-survivor.locale";

const TABLES: Record<Locale, Record<string, string>> = { en, zh, fr, de, it, "pt-BR": ptBR };

let current: Locale = FALLBACK;
let pluralRules = new Intl.PluralRules("en");

/**
 * 检测顺序：`?lang=` > 浏览器 > 旧版 localStorage > 英文。
 *
 * URL 参数排第一是为了能直接分享/测试某一门语言，不用改浏览器设置；
 * 当前版本没有语言选择器，旧版本留下的 localStorage 不能压过浏览器语言 ——
 * 否则中文浏览器会被一次过期的英语选择永久锁成英文。
 */
export function detectLocale(): Locale {
  const fromQuery = new URLSearchParams(window.location.search).get("lang");
  const queryMatch = matchLocale(fromQuery);
  if (queryMatch) return queryMatch;

  // navigator.languages 是按偏好排序的，逐个规范化后取第一个我们支持的。
  for (const tag of navigator.languages ?? [navigator.language]) {
    const match = matchLocale(tag);
    if (match) return match;
  }

  // 只在浏览器没有任何受支持语言时兼容旧版手动选择。
  try {
    const stored = matchLocale(window.localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // 隐私模式 / 跨域 iframe 下 localStorage 会直接抛，静默降级。
  }
  return FALLBACK;
}

/** 地区变体落到已有翻译；葡语当前采用巴西版本。 */
function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const normalized = tag.trim().toLowerCase().replace("_", "-");
  const base = normalized.split("-")[0];
  if (base === "pt") return "pt-BR";
  return SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === base) ?? null;
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale, remember = false): void {
  current = SUPPORTED_LOCALES.includes(locale) ? locale : FALLBACK;
  pluralRules = new Intl.PluralRules(current);
  // 影响浏览器的断词、默认字体与屏幕朗读，必须跟着走。
  document.documentElement.lang = current === "zh" ? "zh-CN" : current;
  if (remember) {
    try {
      window.localStorage.setItem(STORAGE_KEY, current);
    } catch { /* 存不下就算了，不影响本局 */ }
  }
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
  const table = TABLES[current];
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
