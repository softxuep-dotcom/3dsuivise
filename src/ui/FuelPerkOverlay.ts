import { t, tx } from "../i18n";
import {
  BLOOD_RUSH_HEALTH,
  EMPTY_RUN_SECONDS,
  FUEL_PERK_BY_ID,
  type FuelPerkId,
} from "../game/balance/fuelPerks";
import type { GameSimulation } from "../game/simulation/GameSimulation";

/**
 * 搬油三选一的弹层。规格见 docs/搬油三选一-开发交接.md §8。
 *
 * ## 它不持有任何奖励状态
 *
 * 每次开弹层都重新问 `simulation.getFuelPerkOffer()`，选择回
 * `simulation.chooseFuelPerk()` 校验。**层数不在这里记** —— 暂停、广告、软重开
 * 各是一条路径，UI 只要自己存一份就迟早漏同步，而那种错的表现是
 * 「卡面写着 Ⅱ，实际效果是 Ⅰ」，几乎不可能从现象反推。
 *
 * ## 不能跳过
 *
 * 没有关闭按钮，ESC 不管用。奖励是这一趟运输的结算，跳过等于白跑一趟。
 * 强制清除只在死亡 / 通关 / 重开时由 {@link close} 发生。
 */

/** 卡面上要填的数字。只有这两张卡逐层不同，其余是平坦值、文案里写死。 */
const PARAMS: Partial<Record<FuelPerkId, (nextStacks: number) => Record<string, number>>> = {
  "empty-run": (n) => ({ seconds: EMPTY_RUN_SECONDS[Math.min(n, EMPTY_RUN_SECONDS.length) - 1] }),
  "blood-rush": (n) => ({ health: BLOOD_RUSH_HEALTH[Math.min(n, BLOOD_RUSH_HEALTH.length) - 1] }),
};

const required = <T extends Element>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as unknown as T;
};

export interface FuelPerkOverlayDeps {
  /** getter：软重启会换掉 simulation。 */
  readonly simulation: GameSimulation;
  /** 弹层一开就把点击移动的目标取消掉，否则选完人物会继续沿旧路线跑。 */
  cancelMoveTarget(): void;
}

export class FuelPerkOverlay {
  private readonly root = required<HTMLElement>("fuel-perk-overlay");
  private readonly choices = required<HTMLElement>("fuel-perk-choices");
  private open = false;
  /** 这次渲染出来的三张，按屏幕顺序。键盘 1/2/3 直接查它。 */
  private shown: FuelPerkId[] = [];

  constructor(private readonly deps: FuelPerkOverlayDeps) {
    /*
     * 键盘 1/2/3。挂在 window 而不是卡片上 —— 卡片是每次现生成的，
     * 而且玩家不会先去点一下卡片再按数字。
     */
    window.addEventListener("keydown", (event) => {
      if (!this.open) return;
      const index = ["Digit1", "Digit2", "Digit3"].indexOf(event.code);
      if (index < 0) return;
      event.preventDefault();
      this.pick(index);
    });
  }

  /** 弹层开着时世界必须冻结；HudController.isGameplayBlocked() 要并进这一条。 */
  isOpen(): boolean {
    return this.open;
  }

  /**
   * 每帧问一次模拟层要不要开。
   *
   * 用轮询而不是听 `fuel-perk-offer` 事件：事件会在暂停、切后台、广告期间
   * 堆在队列里，而"此刻该不该开弹层"是**状态**不是**事件**。
   * 轮询让这两件事天然一致 —— offer 还在就开着，被选掉就关。
   */
  update(): void {
    const offer = this.deps.simulation.getFuelPerkOffer();
    if (offer && !this.open) this.show(offer);
    else if (!offer && this.open) this.close();
  }

  /** 死亡、通关、软重开：强制收掉，别让它盖在结算页上。 */
  close(): void {
    this.open = false;
    this.root.classList.add("hidden");
    this.choices.replaceChildren();
    this.shown = [];
  }

  private show(offer: readonly FuelPerkId[]): void {
    this.open = true;
    this.shown = [...offer];
    this.deps.cancelMoveTarget();
    this.choices.replaceChildren(...this.shown.map((id, index) => this.card(id, index)));
    this.root.classList.remove("hidden");
  }

  private card(id: FuelPerkId, index: number): HTMLButtonElement {
    const def = FUEL_PERK_BY_ID[id];
    const next = this.deps.simulation.fuelPerkStacks(id) + 1;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `fuel-perk-choice line-${def.line}`;
    button.dataset.perk = id;

    const key = document.createElement("kbd");
    key.className = "fuel-perk-key";
    key.setAttribute("aria-hidden", "true");
    key.textContent = String(index + 1);

    const line = document.createElement("span");
    line.className = "fuel-perk-line";
    line.textContent = t(`perk.line.${def.line}`);

    const name = document.createElement("strong");
    name.className = "fuel-perk-name";
    name.textContent = t(`perk.${id}.name`);

    const desc = document.createElement("span");
    desc.className = "fuel-perk-desc";
    desc.textContent = tx({ key: `perk.${id}.desc`, params: PARAMS[id]?.(next) });

    /*
     * 层数写成 `Level 2/3` 而不是只写效果 —— 玩家要看得出这是**叠加**
     * 而不是替换。同一张卡第二次出现时，这一行是唯一的区别。
     */
    const level = document.createElement("span");
    level.className = "fuel-perk-level";
    level.textContent = tx({ key: "perk.level", params: { level: next, max: def.maxStacks } });

    button.append(key, line, name, desc, level);
    button.addEventListener("click", () => this.pick(index));
    return button;
  }

  private pick(index: number): void {
    const id = this.shown[index];
    if (!id) return;
    /*
     * 只认模拟层的返回值。被拒绝（不在 offer 里、已满层）就什么都不做，
     * 弹层继续开着 —— 玩家仍然要选一张，这是不能跳过的。
     */
    if (!this.deps.simulation.chooseFuelPerk(id)) return;
    this.close();
  }
}
