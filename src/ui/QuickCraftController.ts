import armorIconUrl from "../assets/quick-craft-armor.webp";
import type { EquipTier } from "../game/balance/equipment";
import type { GameSimulation } from "../game/simulation/GameSimulation";
import { t } from "../i18n";

type EquipmentSlot = "weapon" | "armor";

interface QuickCraftControllerOptions {
  host: HTMLElement;
  backpackButton: HTMLButtonElement;
  getSimulation: () => GameSimulation;
  isBlocked: () => boolean;
}

const LINE_COLORS: Record<string, string> = {
  saber: "#6f9fc7",
  sword: "#e0ad49",
  scale: "#a5b2bc",
  hide: "#cf925a",
};

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const tierName = (tier: EquipTier): string => t(`equip.${tier.id}.name`);

/** 武器沿用现有动作图集；护甲使用专门生成的透明位图资产。 */
const equipmentIcon = (slot: EquipmentSlot): string => slot === "weapon"
  ? '<i class="quick-craft-icon hud-sprite" data-icon="attack" aria-hidden="true"></i>'
  : `<img class="quick-craft-icon" src="${armorIconUrl}" alt="" aria-hidden="true">`;

/**
 * HUD 里的条件式装备制作区。
 *
 * 它只消费模拟层给出的“此刻真的能造”候选，不自己复制材料、火源或路线规则。
 * 两个槽位各占一条固定轨道；同槽双分支同时可造时向左排开，点的仍是具体装备，
 * 所以不会为了省一次点击替玩家做路线选择。
 */
export class QuickCraftController {
  private readonly host: HTMLElement;
  private readonly backpackButton: HTMLButtonElement;
  private readonly getSimulation: () => GameSimulation;
  private readonly isBlocked: () => boolean;
  private signature = "";
  private receivePulse = 0;

  constructor(options: QuickCraftControllerOptions) {
    this.host = options.host;
    this.backpackButton = options.backpackButton;
    this.getSimulation = options.getSimulation;
    this.isBlocked = options.isBlocked;
  }

  update(): void {
    const blocked = this.isBlocked();
    const simulation = this.getSimulation();
    const weapon = blocked ? [] : simulation.getCraftableUpgrades("weapon");
    const armor = blocked ? [] : simulation.getCraftableUpgrades("armor");
    const nextSignature = `${blocked ? "blocked" : "ready"}|w:${weapon.map((tier) => tier.id).join(",")}|a:${armor.map((tier) => tier.id).join(",")}`;
    if (nextSignature === this.signature) return;
    this.signature = nextSignature;

    const anyReady = weapon.length + armor.length > 0;
    this.host.classList.toggle("hidden", !anyReady);
    this.host.innerHTML = anyReady
      ? `${this.renderRow("weapon", weapon)}${this.renderRow("armor", armor)}`
      : "";

    this.host.querySelectorAll<HTMLButtonElement>("button[data-craft]").forEach((button) => {
      button.addEventListener("click", () => this.craft(button));
    });
  }

  private renderRow(slot: EquipmentSlot, tiers: EquipTier[]): string {
    const buttons = tiers.map((tier) => {
      const name = tierName(tier);
      const action = t("upgrade.craft", { name });
      const color = LINE_COLORS[tier.line] ?? "#dfad5f";
      return `<button class="quick-craft-button" type="button" data-slot="${slot}" data-craft="${tier.id}" style="--craft-line:${color}" aria-label="${escapeHtml(action)}" title="${escapeHtml(action)}">
        ${equipmentIcon(slot)}
        <span>${escapeHtml(name)}</span>
        <b aria-hidden="true">+</b>
      </button>`;
    }).join("");
    return `<div class="quick-craft-row ${slot}${tiers.length === 0 ? " empty" : ""}" data-slot="${slot}">${buttons}</div>`;
  }

  private craft(button: HTMLButtonElement): void {
    const slot = button.dataset.slot as EquipmentSlot | undefined;
    const id = button.dataset.craft;
    if (!slot || !id || this.isBlocked()) return;

    const simulation = this.getSimulation();
    const tier = simulation.getCraftableUpgrades(slot).find((candidate) => candidate.id === id);
    if (!tier) {
      this.fail(button);
      return;
    }

    button.disabled = true;
    const source = button.getBoundingClientRect();
    if (!simulation.craftEquip(slot, id)) {
      this.fail(button);
      return;
    }

    this.flyToBackpack(source, slot, tier.line);
    this.signature = "";
    this.update();
  }

  private fail(button: HTMLButtonElement): void {
    button.disabled = false;
    button.classList.remove("failed");
    void button.offsetWidth;
    button.classList.add("failed");
    window.setTimeout(() => button.classList.remove("failed"), 260);
    this.signature = "";
  }

  private flyToBackpack(source: DOMRect, slot: EquipmentSlot, line: string): void {
    const target = this.backpackButton.getBoundingClientRect();
    if (source.width === 0 || target.width === 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.pulseBackpack();
      return;
    }

    const size = 52;
    const startX = source.left + source.width / 2;
    const startY = source.top + source.height / 2;
    const endX = target.left + target.width / 2;
    const endY = target.top + target.height / 2;
    const dx = endX - startX;
    const dy = endY - startY;
    const lift = Math.min(74, 34 + Math.abs(dx) * .14);
    const flight = document.createElement("div");
    flight.className = `quick-craft-flight ${slot}`;
    flight.style.setProperty("--craft-line", LINE_COLORS[line] ?? "#dfad5f");
    flight.style.left = `${startX - size / 2}px`;
    flight.style.top = `${startY - size / 2}px`;
    flight.innerHTML = equipmentIcon(slot);
    document.body.append(flight);

    const finish = (): void => {
      flight.remove();
      this.pulseBackpack();
    };
    const animation = flight.animate([
      { opacity: 0, transform: "translate3d(0, 0, 0) scale(.62) rotate(-5deg)" },
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1.08) rotate(0deg)", offset: .16 },
      { opacity: .92, transform: `translate3d(${dx * .56}px, ${dy * .32 - lift}px, 0) scale(.9) rotate(8deg)`, offset: .58 },
      { opacity: 0, transform: `translate3d(${dx}px, ${dy}px, 0) scale(.18) rotate(18deg)` },
    ], { duration: 560, easing: "cubic-bezier(.2,.72,.25,1)", fill: "forwards" });
    void animation.finished.then(finish, finish);
  }

  private pulseBackpack(): void {
    const token = ++this.receivePulse;
    this.backpackButton.classList.remove("craft-received");
    void this.backpackButton.offsetWidth;
    this.backpackButton.classList.add("craft-received");
    window.setTimeout(() => {
      if (token === this.receivePulse) this.backpackButton.classList.remove("craft-received");
    }, 430);
  }
}
