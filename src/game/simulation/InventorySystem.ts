import { INVENTORY_STACK_LIMITS } from "./types";
import type { InventoryItemKind, PlayerState } from "./types";

/**
 * 背包格子的增删查 —— **只管格子，不管东西是什么**。
 *
 * 这五个方法是全局唯一改动 `player.inventory` 的地方：挖矿、剥皮、捡掉落、
 * 开局口粮、装备造价与退款、吃喝，全部收口到这里。抽出来之后，
 * "满包了会怎样""退款塞不下会怎样"这类问题有了单一的答案处，
 * 而不必在六个调用点各读一遍。
 *
 * 它**不知道**熟肉能回多少血、铁矿能造什么 —— 那些是 balance/ 和各系统的事。
 * 端口只有两个成员，这是有意的：见 movement/CollisionKernel.ts 顶上那段
 * 「端口宽了，抽出去的东西就还是没独立」。
 */
export interface InventoryOwner {
  readonly player: PlayerState;
  /**
   * 有东西**确定要进包**了（已过容量检查、即将落格）。
   *
   * 存在这个钩子只为一件事：装备制作的解锁判定挂在这里。那条规则本身属于装备，
   * 但它要观察的时刻在背包这边 —— 而"物品进背包"的唯一收口就是 {@link InventorySystem.add}，
   * 不必在挖矿、剥皮、捡掉落各处重复判断。调用点和判定挪走之前**一模一样**。
   */
  onItemAcquired(kind: InventoryItemKind): void;
}

export class InventorySystem {
  constructor(private readonly owner: InventoryOwner) {}

  /** 包里一共有多少个这种东西。 */
  count(kind: InventoryItemKind): number {
    return this.owner.player.inventory.reduce(
      (total, stack) => total + (stack?.kind === kind ? stack.count : 0), 0);
  }

  /** 还塞得下多少个这种东西：空格按满堆算，同类格按剩余算。 */
  space(kind: InventoryItemKind): number {
    const limit = INVENTORY_STACK_LIMITS[kind];
    let space = 0;
    for (const stack of this.owner.player.inventory) {
      if (!stack) space += limit;
      else if (stack.kind === kind) space += Math.max(0, limit - stack.count);
    }
    return space;
  }

  /** 塞进包里；塞不下返回 false 且**一个都不塞**（不做部分入包）。 */
  add(kind: InventoryItemKind, count: number): boolean {
    if (count <= 0) return true;
    if (this.space(kind) < count) return false;
    // 过了容量检查就必然入包，所以解锁钩子放在这里 —— 这是物品进背包的唯一收口
    // （挖矿、剥皮、捡掉落、开局口粮全走它），不必在各个调用点重复判断。
    this.owner.onItemAcquired(kind);
    let remaining = count;
    const limit = INVENTORY_STACK_LIMITS[kind];
    for (const stack of this.owner.player.inventory) {
      if (!stack || stack.kind !== kind || stack.count >= limit) continue;
      const amount = Math.min(remaining, limit - stack.count);
      stack.count += amount;
      remaining -= amount;
      if (remaining === 0) return true;
    }
    for (let index = 0; index < this.owner.player.inventory.length; index += 1) {
      if (this.owner.player.inventory[index]) continue;
      const amount = Math.min(remaining, limit);
      this.owner.player.inventory[index] = { kind, count: amount };
      remaining -= amount;
      if (remaining === 0) return true;
    }
    return false;
  }

  /** 从包里拿走这么多个。**从后往前拿** —— 先掏零头格，别把整堆拆散。 */
  remove(kind: InventoryItemKind, count: number): void {
    let remaining = count;
    for (let index = this.owner.player.inventory.length - 1; index >= 0; index -= 1) {
      const stack = this.owner.player.inventory[index];
      if (!stack || stack.kind !== kind) continue;
      const amount = Math.min(remaining, stack.count);
      this.removeFromSlot(index, amount);
      remaining -= amount;
      if (remaining === 0) return;
    }
  }

  /** 从指定格里拿走这么多个；拿空了这一格变回 null。 */
  removeFromSlot(index: number, count: number): void {
    const stack = this.owner.player.inventory[index];
    if (!stack) return;
    stack.count -= count;
    if (stack.count <= 0) this.owner.player.inventory[index] = null;
  }
}
