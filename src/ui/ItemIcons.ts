import type { InventoryItemKind } from "../game/simulation/types";

/**
 * 背包里的物品图标。
 *
 * ## 为什么不是字
 *
 * 原先每个物品在每种语言里各有一个 2~4 字的缩写（`item.*.glyph`），
 * 8 种物品 × 6 种语言 = 48 条串。问题是缩到那个长度之后它们**不再是词**：
 * 熟肉在英文里是 `Ckd`、葡语是 `Assd`，犬牙在德语里是 `Zhn`。
 * 而格子里字号只有 24px（矮屏 19px），那个尺寸下几个拉丁字母比一个形状更难认。
 *
 * 最要命的是**生肉 / 熟肉**这一对 —— 它俩在玩法上差别极大（生肉只顶饿，
 * 熟肉是唯一能大量回体力的东西），却被 `Raw` / `Ckd` 这种缩写区分。
 * 所以这两个图标**故意共用同一个轮廓**，差异只在底下那簇火：
 * 一眼就知道它俩是同一样东西的两个状态，而不是两种无关的食材。
 *
 * ## 为什么是内联 SVG
 *
 * emoji 在安卓 / iOS / Windows 上是三套完全不同的画风，而且"兽皮""犬牙"
 * 根本没有对应的 emoji；雪碧图要多一次请求、任意尺寸下不够锐。
 * 内联 SVG 各处一致、每个两三百字节、零额外请求。
 *
 * ## 配色
 *
 * 颜色直接取自世界里同一件东西的材质（见 GameRenderer），
 * 这样"地上那块红色的肉"和"背包里那个红色的图标"是同一个东西 ——
 * 图标不是重新发明一套符号，是把世界里的东西缩小放进格子。
 */

/** 与 GameRenderer 里同名物体的材质色一一对应。 */
const COLORS = {
  wood: "#7a4931",
  meat: "#9e3f3d",
  meatDark: "#7d2f2e",
  bone: "#d7c8ad",
  flame: "#ffb35c",
  water: "#5f8ea0",
  cactus: "#4f7a48",
  hide: "#c49a5f",
  iron: "#8d938c",
  ironDark: "#5e554a",
} as const;

/**
 * 24×24 视野，统一留 2px 边距。
 * 全部用实心块 + 少量描边，和游戏的低多边形观感一致；不用渐变，小尺寸下看不出来还占体积。
 */
const ICONS: Record<InventoryItemKind, string> = {
  // 两根交叠的木棍。
  wood: `<path d="M4 17.5 19 6" stroke="${COLORS.wood}" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M6 7 20 17" stroke="${COLORS.wood}" stroke-width="3" stroke-linecap="round" opacity=".78"/>`,

  // 带骨的一块肉：骨头从一端露出来。生肉与熟肉共用这个轮廓。
  "raw-meat": `<path d="M7.5 6.5c5-1.6 9 1.2 9 5.6 0 4.2-3.4 6.6-7.4 6.1-3.4-.4-5.3-2.8-5-6 .2-2.7 1.4-4.9 3.4-5.7Z" fill="${COLORS.meat}"/>
    <path d="M15.6 5.2c1.6-.9 3.2-.2 3.4 1.3.2 1.5-1.1 2.4-2.5 2.1" stroke="${COLORS.bone}" stroke-width="2.2" stroke-linecap="round" fill="none"/>`,

  // 同一块肉 + 底下三簇火苗，颜色也压深一档（烤过了）。
  "cooked-meat": `<path d="M7.5 4.5c5-1.6 9 1.2 9 5.6 0 4.2-3.4 6.6-7.4 6.1-3.4-.4-5.3-2.8-5-6 .2-2.7 1.4-4.9 3.4-5.7Z" fill="${COLORS.meatDark}"/>
    <path d="M15.6 3.2c1.6-.9 3.2-.2 3.4 1.3.2 1.5-1.1 2.4-2.5 2.1" stroke="${COLORS.bone}" stroke-width="2.2" stroke-linecap="round" fill="none"/>
    <path d="M6 21c-.9-1.5-.3-2.7.7-3.6.1 1 .6 1.5 1.2 1.8-.3-1.9.5-3.2 1.6-4-.2 2 .8 2.6 1.4 3.4.7-.7.8-1.6.7-2.4 1.3 1 1.9 2.6 1 4.8Z" fill="${COLORS.flame}"/>
    <path d="M14.4 21c-.6-1-.2-1.9.5-2.5.1.7.4 1 .8 1.2-.2-1.3.4-2.2 1.1-2.8-.1 1.4.6 1.8 1 2.4.5-.5.6-1.1.5-1.7.9.7 1.3 1.8.7 3.4Z" fill="${COLORS.flame}" opacity=".8"/>`,

  // 水滴。
  water: `<path d="M12 3.2c3.4 4.2 6.2 7.3 6.2 10.6A6.2 6.2 0 0 1 5.8 13.8C5.8 10.5 8.6 7.4 12 3.2Z" fill="${COLORS.water}"/>
    <path d="M9.2 14.2c0 1.7 1.2 2.9 2.6 3.1" stroke="#cfe6ee" stroke-width="1.5" stroke-linecap="round" fill="none" opacity=".75"/>`,

  // 水滴 + 两根仙人掌的刺：和水共用轮廓，靠颜色与刺区分。
  "cactus-juice": `<path d="M12 3.2c3.4 4.2 6.2 7.3 6.2 10.6A6.2 6.2 0 0 1 5.8 13.8C5.8 10.5 8.6 7.4 12 3.2Z" fill="${COLORS.cactus}"/>
    <path d="M12 9.5v7.5M8.8 12.4l-1.9-1.5M15.2 12.4l1.9-1.5" stroke="#dff0d0" stroke-width="1.5" stroke-linecap="round" opacity=".8"/>`,

  // 一张摊开的四角兽皮。
  hide: `<path d="M6.4 4.6c1.9.9 3.2 1.3 5.6 1.3s3.7-.4 5.6-1.3c.7 2.2.2 3.6-.9 4.7 1.3 1.2 1.8 2.7 1.2 4.6-.7 2.4-2.9 5.5-5.9 5.5s-5.2-3.1-5.9-5.5c-.6-1.9-.1-3.4 1.2-4.6-1.1-1.1-1.6-2.5-.9-4.7Z" fill="${COLORS.hide}"/>
    <path d="M12 8.6v7.2" stroke="#8f6a38" stroke-width="1.3" stroke-linecap="round" opacity=".6"/>`,

  // 一块带三个晶面的矿石。
  "iron-ore": `<path d="M11.8 3.8 19 8.4l-1.7 8.2-7 3.4-6.6-4.2.8-8.3Z" fill="${COLORS.iron}"/>
    <path d="M11.8 3.8 10.3 11l7 5.6M10.3 11 3.7 7.5M10.3 11l-.6 9" stroke="${COLORS.ironDark}" stroke-width="1.4" stroke-linejoin="round" fill="none"/>`,

  // 一颗弯的尖牙。
  "wolf-fang": `<path d="M8.6 3.6c3.4-.5 6.2.4 6.9 2.2.9 2.3-.5 5.3-2 8.3-1.2 2.4-2.2 5-3.4 6.3-.9-1.9-.6-4.4-.9-7-.3-2.9-1.6-5.4-1.5-7.4 0-1.2.3-2 .9-2.4Z" fill="${COLORS.bone}"/>
    <path d="M10.2 6.4c1.5-.3 2.7 0 3.2.9" stroke="#9d8f74" stroke-width="1.2" stroke-linecap="round" fill="none" opacity=".7"/>`,
};

/** 背包格里的物品图标。返回一段内联 SVG，跟着格子的字号缩放。 */
export function itemIcon(kind: InventoryItemKind): string {
  return `<svg class="item-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[kind]}</svg>`;
}
