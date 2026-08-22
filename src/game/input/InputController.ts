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

/**
 * 一副浮动摇杆。左右两副除了待机位和触发的那半屏，行为逐字相同。
 * pointer 是它当前吃住的那根手指；null = 没人在推。
 */
interface TouchStick {
  readonly base: HTMLElement | null;
  readonly knob: HTMLElement | null;
  pointer: number | null;
  x: number;
  y: number;
}

export class InputController {
  private readonly keys = new Set<string>();
  private readonly callbacks: InputCallbacks;
  private moveTarget: Vec2 | null = null;
  /** 由 main.ts 注入的寻路：从当前位置朝点击目标该走哪。返回 null 表示已到达。 */
  private routeTo: ((target: Vec2) => Vec2 | null) | null = null;
  /** 连续多久没有实质推进；超过阈值就放弃这次点击，免得人一直顶着崖壁。 */
  private stalledFor = 0;
  private lastPosition: Vec2 | null = null;
  private readonly leftStick: TouchStick = {
    base: document.getElementById("joystick"),
    knob: document.querySelector<HTMLElement>("#joystick i"),
    pointer: null,
    x: 0,
    y: 0,
  };
  private readonly rightStick: TouchStick = {
    base: document.getElementById("joystick-right"),
    knob: document.querySelector<HTMLElement>("#joystick-right i"),
    pointer: null,
    x: 0,
    y: 0,
  };
  /** 两副的遍历序。字段声明顺序决定初始化顺序，这一行必须排在上面两个之后。 */
  private readonly sticks: readonly TouchStick[] = [this.leftStick, this.rightStick];

  constructor(callbacks: InputCallbacks) {
    this.callbacks = callbacks;
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clear);
    this.bindButton("action-button", callbacks.onAction);
    this.bindButton("attack-button", callbacks.onAttack);
    this.bindButton("thermal-button", callbacks.onThermal);
  }

  bindCanvas(canvas: HTMLCanvasElement, screenToWorld: (x: number, y: number) => Vec2 | null): void {
    canvas.addEventListener("pointerdown", (event) => {
      /*
       * **画布上的第一次按下就是开局**，不管这一下有没有真的让人动起来。
       *
       * 早先这句挂在两个更靠里的位置：触屏只有落在左半屏（摇杆区）才报，
       * 键鼠只有射线打中地形才报。两个漏口都真实存在 ——
       * 触屏玩家第一下点在右半屏（那边是按钮簇的地盘，空白处什么也不做），
       * 或者键鼠玩家第一下点在天空 / 远处的山脊上，射线打空。
       * 这两种人在平台看来"从没开始玩过"，而他们明明已经在操作了。
       *
       * 教学的第一步就是"走两步"，所以这一下多半正是教学的第一次点击 ——
       * 玩家开始教学的那一刻就该算开局，这也正是 Poki 要的转化点。
       */
      this.callbacks.onGameplayIntent();
      if (event.pointerType === "touch") {
        this.startJoystick(canvas, event);
        return;
      }
      const target = screenToWorld(event.clientX, event.clientY);
      if (target) this.moveTarget = target;
    });
    // 哪根手指对应哪副摇杆由 trackJoystick 自己认，这里不再预筛。
    canvas.addEventListener("pointermove", this.trackJoystick);
    canvas.addEventListener("pointerup", this.releaseJoystick);
    canvas.addEventListener("pointercancel", this.releaseJoystick);
  }

  getMovement(player: PlayerState): Vec2 {
    const horizontal = (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0)
      - (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0);
    const vertical = (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0)
      - (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0);

    let screenX = horizontal;
    let screenY = vertical;
    const stick = this.pushedStick();
    if (stick) {
      screenX = stick.x;
      screenY = stick.y;
      this.moveTarget = null;
    } else if (horizontal !== 0 || vertical !== 0) {
      this.moveTarget = null;
    } else if (this.moveTarget) {
      if (distance(player, this.moveTarget) < 0.65) {
        this.moveTarget = null;
      } else {
        /*
         * 走流场，不走直线。
         *
         * 直线冲实测 400 次随机点击只有 43% 能走到（70 米以上只有 37%），
         * 剩下的全顶在山脊上原地推 —— 而这一支只在 0.65 米内才清目标，
         * 于是玩家一直卡着。routeTo 由 main.ts 接到模拟层的流场上。
         *
         * 再加一道兜底：连续 1.2 秒没挪够距离就放弃这次点击。流场也有画不出路的
         * 时候（目标在不可达的崖上），那时"停下来"比"一直顶着"体面得多。
         */
        this.trackStall(player);
        if (this.stalledFor > 1.2) {
          this.moveTarget = null;
        } else {
          const routed = this.routeTo?.(this.moveTarget)
            ?? normalize({ x: this.moveTarget.x - player.x, z: this.moveTarget.z - player.z });
          if (routed) return routed;
          this.moveTarget = null;
        }
      }
    }
    if (!this.moveTarget) { this.stalledFor = 0; this.lastPosition = null; }

    // Fixed isometric camera: convert screen axes to world axes.
    const factor = Math.SQRT1_2;
    return normalize({
      x: (screenX + screenY) * factor,
      z: (-screenX + screenY) * factor,
    });
  }

  /** 接上模拟层的寻路。没接的话点击移动会退回直线，行为和以前一致。 */
  setRouter(route: (target: Vec2) => Vec2 | null): void {
    this.routeTo = route;
  }

  /** getMovement 每帧调一次；这里只看"两帧之间到底挪了多少"。 */
  private trackStall(player: PlayerState): void {
    if (this.lastPosition) {
      const moved = distance(player, this.lastPosition);
      // 8.2 m/s 的正常步进，一帧至少也有几厘米；0.01 已经是"基本没动"。
      this.stalledFor = moved < 0.01 ? this.stalledFor + 1 / 60 : 0;
    }
    this.lastPosition = { x: player.x, z: player.z };
  }

  cancelMoveTarget(): void {
    this.moveTarget = null;
    this.stalledFor = 0;
    this.lastPosition = null;
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
    for (const stick of this.sticks) this.parkStick(stick);
  };

  private bindButton(id: string, callback: () => void): void {
    document.getElementById(id)?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.callbacks.onGameplayIntent();
      callback();
    });
  }

  /**
   * 浮动摇杆：圆心落在手指按下的位置，而不是屏幕角上那个写死的圈。
   *
   * 固定摇杆逼着左拇指整局外展去够左下角的 104px 圆 —— 那是持续等长收缩，
   * 竖屏久玩手酸的头号来源。落点即圆心之后，手放哪都行。
   *
   * 事件绑在 **canvas** 上而不是摇杆元素上：按钮和状态栏都是盖在 canvas 之上的 DOM，
   * 它们的触摸压根走不到这里，于是"哪里算摇杆区"不需要再和 HUD 抢层叠关系。
   *
   * **两半屏各一副。** 原先只认左半屏，右半屏的空白按下去什么都不发生 ——
   * 对惯用右手推杆的人来说，那等于半块屏幕是哑的。现在按下的位置决定用哪一副：
   * 左半屏给 leftStick，右半屏给 rightStick，两根手指同时推也各归各。
   *
   * 右半屏真正能推的是**按钮簇以外**的地方：`.bottom-right` 自己收触摸事件
   * （styles.css 里 pointer-events: auto），竖屏 375×812 实测它盖住 x163..355 /
   * y596..788。所以右拇指要落在那一片的上沿或左沿，落在四颗键上仍然是按键。
   */
  private startJoystick(canvas: HTMLCanvasElement, event: PointerEvent): void {
    const stick = event.clientX <= window.innerWidth * 0.5 ? this.leftStick : this.rightStick;
    const base = stick.base;
    if (!base || stick.pointer !== null) return;
    // onGameplayIntent 已经在 pointerdown 的入口报过了，这里不重复。
    stick.pointer = event.pointerId;
    base.classList.add("floating");
    base.style.left = `${event.clientX - base.offsetWidth / 2}px`;
    base.style.top = `${event.clientY - base.offsetHeight / 2}px`;
    canvas.setPointerCapture(event.pointerId);
    this.trackJoystick(event);
  }

  private readonly trackJoystick = (event: PointerEvent): void => {
    const stick = this.stickOf(event.pointerId);
    if (!stick || !stick.base || !stick.knob) return;
    // 圆心就是元素中心 —— startJoystick 已经把它摆在了落点上。
    const rect = stick.base.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    let x = (event.clientX - centerX) / (rect.width * 0.34);
    let y = (event.clientY - centerY) / (rect.height * 0.34);
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    stick.x = x;
    stick.y = y;
    stick.knob.style.transform = `translate(${x * rect.width * 0.29}px, ${y * rect.height * 0.29}px)`;
  };

  private readonly releaseJoystick = (event: PointerEvent): void => {
    const stick = this.stickOf(event.pointerId);
    if (stick) this.parkStick(stick);
  };

  private stickOf(pointerId: number): TouchStick | null {
    for (const stick of this.sticks) {
      if (stick.pointer === pointerId) return stick;
    }
    return null;
  }

  /**
   * 此刻真正在下移动指令的那一副。
   *
   * 两副同时被吃住是常见握姿（一根手指搭着不动、另一根在推），所以不能"谁先按谁说了算"
   * —— 取幅度大的那一副。0.08 的死区沿用原来的口径：手指落下但没推开时不算移动，
   * 否则一次纯粹的点击也会让人往那个方向挪半步。
   */
  private pushedStick(): TouchStick | null {
    let best: TouchStick | null = null;
    let bestLength = 0.08;
    for (const stick of this.sticks) {
      if (stick.pointer === null) continue;
      const length = Math.hypot(stick.x, stick.y);
      if (length <= bestLength) continue;
      best = stick;
      bestLength = length;
    }
    return best;
  }

  /** 停推：清零输入，并让摇杆回到 CSS 里那个待机位（左边那副的圈要让新玩家看得见）。 */
  private parkStick(stick: TouchStick): void {
    stick.pointer = null;
    stick.x = 0;
    stick.y = 0;
    if (stick.knob) stick.knob.style.transform = "translate(0, 0)";
    const base = stick.base;
    if (!base) return;
    base.classList.remove("floating");
    base.style.left = "";
    base.style.top = "";
  }
}
