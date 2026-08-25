import type { InventoryItemKind, LocalizedText } from "./types";

/**
 * 模拟层产出文案的两个共用助手。
 *
 * 模拟层**不产出人话，只产出键**：`{ key, params }` 交给 i18n 层去查表插值。
 * 这条规矩是十三种语言能各自独立按需下载的前提 —— 见 i18n/index.ts 顶上那段。
 */

/** 包一个本地化键；没有参数时不带 params 字段，省得下游到处判空。 */
export const loc = (key: string, params?: LocalizedText["params"]): LocalizedText => (
  params ? { key, params } : { key }
);

/**
 * 把一份造价念成一句话：「兽皮 ×1、枯木 ×2」。
 *
 * 装备和建造共用 —— 两边的 cost 是同一种形状，念法当然也该是同一种。
 * 连接词交给 i18n 的 `sim.costJoin`：中文用顿号、英文用逗号加 and，
 * 那是语言的事，不该在这里拼。
 */
export function describeCost(cost: Array<[InventoryItemKind, number]>): LocalizedText {
  return cost
    .map(([kind, count]) => loc("sim.costPart", { name: loc(`item.${kind}.name`), count }))
    .reduce((left, right) => loc("sim.costJoin", { left, right }));
}
