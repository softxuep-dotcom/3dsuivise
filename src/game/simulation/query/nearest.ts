/**
 * 「离玩家最近的那个」——全局唯一的一份实现。
 *
 * GameSimulation 里原先有九个 `findNearestX(maxDistance)`：营地、地上的物件、仙人掌、
 * 树、铁矿、井、油桶、火塘、木桩。九段循环逐字一样，只差**在哪个集合里找**和
 * **哪些不算数**（砍空的树桩不算、提干的井不算、已装车的桶不算）。一百一十行里
 * 有一百行是同一段代码抄了九遍。
 *
 * 抄九遍的代价不是行数，是**改动要改九处**：给"最近"加一条规则（比如加上视线判定）
 * 必须记得九个地方都改，漏一个就是一处只在某类物件上出现的怪 bug。
 *
 * ## 两个不能动的细节
 *
 * 一，比较用的是**距离的平方**，不开根号。九段原文都是这么写的，开根号会让
 *     浮点尾数变化，行为基线立刻能看出来 —— 而这次重构的前提是行为一个字不变。
 *
 * 二，严格小于（`<`）。等距时保留**先遍历到的那个**，和九段原文一致。
 *     换成 `<=` 会让等距的两件东西谁被选中取决于遍历顺序，那是一个看不见的行为改动。
 */
import { distanceSquared } from "../geometry";
import type { Vec2 } from "../types";

interface NearestOptions<T> {
  /** 哪些不算数。省略表示全都算。 */
  accept?: (item: T) => boolean;
  /**
   * 这个元素的位置在哪。省略表示元素自己就是 Vec2。
   *
   * 井需要它：WellState 上只有 id 和存量，坐标在 `world.wells[id]` 里。
   */
  positionOf?: (item: T) => Vec2;
}

/** 在 maxDistance 米内离 from 最近的那个；一个都没有返回 null。 */
export function nearest<T extends object>(
  items: Iterable<T>,
  from: Vec2,
  maxDistance: number,
  options: NearestOptions<T> = {},
): T | null {
  const { accept, positionOf } = options;
  let best: T | null = null;
  let bestValue = maxDistance * maxDistance;
  for (const item of items) {
    if (accept && !accept(item)) continue;
    const value = distanceSquared(from, positionOf ? positionOf(item) : (item as unknown as Vec2));
    if (value >= bestValue) continue;
    best = item;
    bestValue = value;
  }
  return best;
}
