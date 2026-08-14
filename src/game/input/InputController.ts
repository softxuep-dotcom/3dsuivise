import { distance, normalize } from "../simulation/geometry";
import type { PlayerState, Vec2 } from "../simulation/types";

/**
 * 吃喝没有热键，也没有 HUD 快捷键 —— 一律回背包里点物品格。
 * 开背包会暂停游戏，所以不存在"打斗中来不及"；而三颗常驻的快捷键既和背包重复，
 * 又把最不该占地方的右上角占满了。
 */
interface InputCallbacks {
  /** Poki 要求 gameplayStart 必须发生在真正开始游玩的首次输入里。 */
  onGameplayIntent: () => void;
  onAction: () => void;
  onAttack: () => void;
  onThermal: () => void;
  onInventory: () => void;
  onPause: () => void;
}

export class InputController {
  private readonly keys = new Set<string>();
  private readonly callbacks: InputCallbacks;
  private joystick = { x: 0, y: 0 };
  private moveTarget: Vec2 | null = null;

  constructor(callbacks: InputCallbacks) {
    this.callbacks = callbacks;
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clear);
    this.bindButton("action-button", callbacks.onAction);
    this.bindButton("attack-button", callbacks.onAttack);
    this.bindButton("thermal-button", callbacks.onThermal);
    this.bindJoystick();
  }

  bindCanvas(canvas: HTMLCanvasElement, screenToWorld: (x: number, y: number) => Vec2 | null): void {
    canvas.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") return;
      const target = screenToWorld(event.clientX, event.clientY);
      if (target) {
        this.callbacks.onGameplayIntent();
        this.moveTarget = target;
      }
    });
  }

  getMovement(player: PlayerState): Vec2 {
    const horizontal = (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0)
      - (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0);
    const vertical = (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0)
      - (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0);

    let screenX = horizontal;
    let screenY = vertical;
    if (Math.abs(this.joystick.x) > 0.08 || Math.abs(this.joystick.y) > 0.08) {
      screenX = this.joystick.x;
      screenY = this.joystick.y;
      this.moveTarget = null;
    } else if (horizontal !== 0 || vertical !== 0) {
      this.moveTarget = null;
    } else if (this.moveTarget) {
      if (distance(player, this.moveTarget) < 0.65) this.moveTarget = null;
      else return normalize({ x: this.moveTarget.x - player.x, z: this.moveTarget.z - player.z });
    }

    // Fixed isometric camera: convert screen axes to world axes.
    const factor = Math.SQRT1_2;
    return normalize({
      x: (screenX + screenY) * factor,
      z: (-screenX + screenY) * factor,
    });
  }

  cancelMoveTarget(): void {
    this.moveTarget = null;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Escape 不进这张表：浏览器的全屏退出等原生行为要留给它，我们只是**顺带**监听。
    const gameKeys = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyE", "KeyQ", "KeyB", "Tab", "Space"];
    const gameplayKeys = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyE", "KeyQ", "Space"];
    if (gameKeys.includes(event.code)) event.preventDefault();
    if (event.repeat) {
      this.keys.add(event.code);
      return;
    }
    if (gameplayKeys.includes(event.code)) this.callbacks.onGameplayIntent();
    this.keys.add(event.code);
    if (event.code === "KeyE") this.callbacks.onAction();
    if (event.code === "Space") this.callbacks.onAttack();
    if (event.code === "KeyQ") this.callbacks.onThermal();
    if (event.code === "KeyB" || event.code === "Tab") this.callbacks.onInventory();
    // Poki Requirements 第 15 条：键盘游戏要有 ESC 或空格暂停。
    // 空格已经是攻击，所以只能是 ESC。
    if (event.code === "Escape") this.callbacks.onPause();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly clear = (): void => {
    this.keys.clear();
    this.joystick = { x: 0, y: 0 };
  };

  private bindButton(id: string, callback: () => void): void {
    document.getElementById(id)?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.callbacks.onGameplayIntent();
      callback();
    });
  }

  private bindJoystick(): void {
    const base = document.getElementById("joystick");
    const knob = base?.querySelector("i") as HTMLElement | null;
    if (!base || !knob) return;
    let activePointer: number | null = null;

    const update = (event: PointerEvent): void => {
      const rect = base.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      let x = (event.clientX - centerX) / (rect.width * 0.34);
      let y = (event.clientY - centerY) / (rect.height * 0.34);
      const length = Math.hypot(x, y);
      if (length > 1) {
        x /= length;
        y /= length;
      }
      this.joystick = { x, y };
      knob.style.transform = `translate(${x * rect.width * 0.29}px, ${y * rect.height * 0.29}px)`;
    };

    const release = (event: PointerEvent): void => {
      if (activePointer !== event.pointerId) return;
      activePointer = null;
      this.joystick = { x: 0, y: 0 };
      knob.style.transform = "translate(0, 0)";
      base.releasePointerCapture(event.pointerId);
    };

    base.addEventListener("pointerdown", (event) => {
      this.callbacks.onGameplayIntent();
      activePointer = event.pointerId;
      base.setPointerCapture(event.pointerId);
      update(event);
    });
    base.addEventListener("pointermove", (event) => {
      if (activePointer === event.pointerId) update(event);
    });
    base.addEventListener("pointerup", release);
    base.addEventListener("pointercancel", release);
  }
}
