import inventoryAtlasUrl from "../assets/ui/inventory-items-atlas.png";
import type { InventoryItemKind } from "../game/simulation/types";

/**
 * 背包里的物品图标：ImageGen 一次生成的 3×3 位图图集。
 *
 * ## 走到这一版之前试过什么
 *
 * **一、每种语言一套文字缩写**（`item.*.glyph`，8 物品 × 6 语言 = 48 条串）。
 * 缩到 2~4 字之后它们不再是词：熟肉在英文里是 `Ckd`、葡语是 `Assd`，
 * 犬牙在德语里是 `Zhn`。格子里字号只有 24px，那个尺寸下几个拉丁字母比一个形状更难认。
 *
 * **二、手绘内联 SVG**（每个两三百字节，纯色块，配色取自 GameRenderer 的材质）。
 * 体积无可挑剔，但**在真实尺寸上没做到该做的事** —— 把它渲到 30px 就会看到：
 * 生肉和熟肉双双糊成一个红球（那对图标本来刻意共用轮廓，好表达"同一样东西的两个状态"，
 * 结果共用得太彻底），兽皮读起来像一枚盾牌纹章。而生肉/熟肉在玩法上差得最远
 * —— 生肉只顶饿，熟肉是唯一能大量回体力的东西 —— 恰恰是最不能混的一对。
 *
 * 这一版靠**颜色 + 形状双重区分**（红生排 / 焦褐带火），30px 下反而比共用轮廓更清楚。
 * emoji 从来不在候选里：安卓、iOS、Windows 三套画风，而且"兽皮""犬牙"没有对应字符。
 *
 * ## 尺寸：为什么是 270 而不是母版的 1254
 *
 * 图标在界面上只有 30×30（矮屏 24×24）。母版每格 418px 是 14 倍过采样，
 * 整张 1.5MB —— 主包本来就 900KB+，而这游戏要上 Poki / CrazyGames。
 * 每格 90px 已经是 3 倍 DPI，盖过 iPhone Pro 那一档；压完与母版分别渲到 30px
 * 逐像素比对，平均差 1.42/255，肉眼无法分辨。
 *
 * 母版留在 `authoring/assets/ui/`，运行时这份由 `authoring/assets/pack_inventory_atlas.mjs`
 * 生成 —— 改了母版就重跑那个脚本，别手动导出。
 *
 * ## 排布
 *
 *   木材       生肉         烤肉
 *   水         仙人掌汁     兽皮
 *   铁矿       犬牙         预留空格
 *
 * 用 SVG 视窗裁切同一张位图：既保留 `.item-icon` 现有的尺寸规则，
 * 也让浏览器只下载、解码一份图集。
 */
const ATLAS_SIZE = 270;
const CELL_SIZE = 90;

const ATLAS_CELLS: Record<InventoryItemKind, readonly [column: number, row: number]> = {
  wood: [0, 0],
  "raw-meat": [1, 0],
  "cooked-meat": [2, 0],
  water: [0, 1],
  "cactus-juice": [1, 1],
  hide: [2, 1],
  "iron-ore": [0, 2],
  "wolf-fang": [1, 2],
};

/** 背包格里的物品图标。返回裁切到对应图集单元的一段内联 SVG。 */
export function itemIcon(kind: InventoryItemKind): string {
  const [column, row] = ATLAS_CELLS[kind];
  const x = -column * CELL_SIZE;
  const y = -row * CELL_SIZE;

  return `<svg class="item-icon" viewBox="0 0 ${CELL_SIZE} ${CELL_SIZE}" aria-hidden="true" focusable="false"><image href="${inventoryAtlasUrl}" x="${x}" y="${y}" width="${ATLAS_SIZE}" height="${ATLAS_SIZE}"/></svg>`;
}
