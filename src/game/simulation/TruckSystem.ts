import { FUEL_REQUIRED } from "./types";
import type { FuelBarrelState, GameEvent, PlayerState, Vec2, WolfState, WorldDefinition } from "./types";
import { TRUCK_DEPART_MAX_SECONDS, TRUCK_DEPART_SPEED } from "../balance/world";
import { distance, distanceSquared } from "./geometry";
import type { CollisionKernel } from "./movement/CollisionKernel";

/** 卡车此刻的状态。x/z 会在发车动画里被推着走，所以不是 world 里那份定义。 */
export interface TruckState extends Vec2 {
  rotation: number;
  loaded: number;
}

/** 通关进度。目标行、HUD 的边缘指示器和「汽油 n/所需数」都读它。 */
export interface FuelProgress {
  loaded: number;
  required: number;
  carrying: boolean;
  truckDistance: number;
  nearest: { distance: number; bearing: number; guarded: boolean } | null;
}

/**
 * 卡车与油桶 —— **这个游戏唯一的通关条件**。
 *
 * 往车斗里装满所需汽油桶、上车驶出地图边界就赢了。所有和这件事有关的规则都在这里：
 * 手上扛没扛桶、装了几桶、发车之后那几秒结算动画怎么走。
 *
 * 单独成文件的理由不是行数（七十来行），是**它是终局条件**。以后要改通关规则
 * （改桶数、改判定距离、给发车加一段过场），不该再去三千行的模拟层里找位置。
 *
 * ## 发车之后整个模拟停摆
 *
 * `update()` 一看到 {@link departing} 就只跑 {@link updateDeparture} 然后 return ——
 * 不掉水、不掉饿、狗追不上来、摇杆和按键全锁死。让生存轴继续跑的话，
 * 最后这十秒会出现"通关动画里渴死"这种荒唐结局。
 */
export interface TruckOwner {
  /** 装车完成 → 通知三选一。最后一桶不弹的判断在 FuelPerkSystem 里。 */
  notePerkFuelLoaded(loaded: number, required: number): void;
  readonly player: PlayerState;
  readonly world: WorldDefinition;
  readonly barrels: FuelBarrelState[];
  readonly truck: TruckState;
  readonly wolves: WolfState[];
  /** 胜利结算是否已经跑过。跑过就不再受理发车。 */
  readonly victorySent: boolean;
  emit(event: GameEvent): void;
  /** 开出地图边界或结算动画走完：通关。 */
  finishVictory(): void;
  /** 发车瞬间要退出休息状态。 */
  stopResting(): void;
  /**
   * 把某个方向换算成屏幕上的方位角。
   *
   * 留在 GameSimulation 那边是因为它和「北在屏幕上是哪边」绑定，
   * 属于表现约定而不是卡车规则。
   */
  screenBearingTo(target: Vec2): number;
}

export class TruckSystem {
  /** 手上扛着的那一桶。扛桶时移速只剩 0.54 倍、完全不能攻击。 */
  private carried: FuelBarrelState | null = null;
  /** 发车结算动画的剩余秒数。大于 0 表示整个模拟已经停摆。 */
  private departTimer = 0;

  constructor(
    private readonly owner: TruckOwner,
    private readonly collision: CollisionKernel,
  ) {}

  get carriedBarrel(): FuelBarrelState | null {
    return this.carried;
  }

  set carriedBarrel(barrel: FuelBarrelState | null) {
    this.carried = barrel;
  }

  get departing(): boolean {
    return this.departTimer > 0;
  }

  /** 把扛着的那桶装进车斗。装满最后一桶时换一句不同的提示。 */
  loadCarried(): void {
    const barrel = this.carried;
    if (!barrel) return;
    barrel.placement = "loaded";
    this.carried = null;
    this.owner.player.carrying = null;
    this.owner.truck.loaded += 1;
    this.owner.emit({ type: "fuel-loaded", loaded: this.owner.truck.loaded, required: FUEL_REQUIRED });
    /*
     * 三选一接在**装车完成**这一刻，不是拾取那一侧 —— 拿起和放下同一桶可以
     * 反复做，装车不行。奖励是完成一次危险运输之后的结算。
     * 最后一桶不弹（判断在 FuelPerkSystem 里），那时该直接进上车发车。
     */
    this.owner.notePerkFuelLoaded(this.owner.truck.loaded, FUEL_REQUIRED);
    this.owner.emit({
      type: "message",
      key: this.owner.truck.loaded >= FUEL_REQUIRED ? "msg.fuelFull" : "msg.fuelLoaded",
      params: { loaded: this.owner.truck.loaded, required: FUEL_REQUIRED },
    });
  }

  /** 上车发动。之后只剩结算动画。 */
  depart(): void {
    if (this.departTimer > 0 || this.owner.victorySent) return;
    this.departTimer = TRUCK_DEPART_MAX_SECONDS;
    this.owner.stopResting();
    this.owner.player.carrying = null;
    this.carried = null;
    this.owner.emit({ type: "truck-depart" });
    this.owner.emit({ type: "message", key: "msg.truckDepart" });
  }

  /** 结算动画：车沿出口方向开，玩家跟着车走，到边界或超时就通关。 */
  updateDeparture(delta: number): void {
    this.departTimer -= delta;
    const exit = this.owner.world.truck.exit;
    this.owner.truck.x += exit.x * TRUCK_DEPART_SPEED * delta;
    this.owner.truck.z += exit.z * TRUCK_DEPART_SPEED * delta;
    this.owner.player.x = this.owner.truck.x;
    this.owner.player.z = this.owner.truck.z;
    this.owner.player.facing = exit;
    if (this.departTimer <= 0 || this.collision.distanceToWorldEdge(this.owner.truck) <= 1) {
      this.owner.finishVictory();
    }
  }

  /**
   * 通关进度。
   *
   * 「最近那桶有没有狗看着」按**现场还活着的守卫**算，不是按出生时的标记 ——
   * 打完之后这条提示要自己变干净，否则玩家不知道自己已经把路打开了。
   */
  progress(): FuelProgress {
    let nearest: FuelProgress["nearest"] = null;
    if (!this.carried) {
      for (const barrel of this.owner.barrels) {
        if (barrel.placement !== "ground") continue;
        const value = distance(this.owner.player, barrel);
        if (nearest && value >= nearest.distance) continue;
        nearest = {
          distance: value,
          bearing: this.owner.screenBearingTo(barrel),
          guarded: this.owner.wolves.some((wolf) => wolf.role === "guard" && wolf.mode !== "dead"
            && distanceSquared(wolf, barrel) < 14 * 14),
        };
      }
    }
    return {
      loaded: this.owner.truck.loaded,
      required: FUEL_REQUIRED,
      carrying: this.carried !== null,
      truckDistance: distance(this.owner.player, this.owner.truck),
      nearest,
    };
  }
}
