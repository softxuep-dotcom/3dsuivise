import { distance } from "../game/simulation/geometry";
import type { GameSimulation } from "../game/simulation/GameSimulation";
import type { FuelBarrelState, Vec2 } from "../game/simulation/types";

/** 玩家已明确走离出生油桶、但第一个白天仍来得及回头的距离。 */
const TRIGGER_DISTANCE = 8;
/** 聚光保持时间；渲染层另外负责淡入淡出。 */
const HOLD_SECONDS = 4;

export interface FirstBarrelHintWorld {
  /** getter 而不是固定值：软重启会替换 simulation。 */
  readonly simulation: GameSimulation;
  spotlight(target: Vec2 | null): void;
}

/**
 * 出生点油桶的低干扰补救提示。
 *
 * 玩家走开仍没拿桶时只点一次场景聚光：不停表、不推镜头、不增加字幕。
 * 它和第一夜教学共用同一盏灯，所以离开第一个白天必须立即收灯。
 */
export class FirstBarrelHint {
  private barrel: FuelBarrelState | null = null;
  private hold = 0;
  private fired = false;
  /** 区分 running=false 的“尚未开始”和“本局已经结束”。 */
  private begun = false;

  constructor(private readonly ctx: FirstBarrelHintWorld) {}

  /** 每局开始与软重启后调用一次，自动认离出生点最近的地面油桶。 */
  reset(): void {
    this.hold = 0;
    this.fired = false;
    this.begun = false;
    this.ctx.spotlight(null);
    const player = this.ctx.simulation.player;
    let nearest: FuelBarrelState | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const barrel of this.ctx.simulation.barrels) {
      if (barrel.placement !== "ground") continue;
      const value = distance(player, barrel);
      if (value >= best) continue;
      nearest = barrel;
      best = value;
    }
    this.barrel = nearest;
  }

  update(delta: number): void {
    const simulation = this.ctx.simulation;
    const barrel = this.barrel;
    if (!barrel) return;

    if (this.hold > 0) {
      this.hold -= delta;
      const taken = barrel.placement !== "ground";
      const leftFirstDay = simulation.day !== 1 || simulation.phase !== "day";
      if (this.hold <= 0 || taken || leftFirstDay) {
        this.hold = 0;
        this.ctx.spotlight(null);
      }
      return;
    }

    if (this.fired) return;

    /* 开场第一帧 simulation 尚未 start；这时只等待，不能误判成一局结束。 */
    if (simulation.running) this.begun = true;
    if (!this.begun) return;

    if (!simulation.running || simulation.day !== 1 || simulation.phase !== "day") {
      this.fired = true;
      return;
    }
    if (barrel.placement !== "ground" || simulation.truck.loaded > 0) {
      this.fired = true;
      return;
    }
    if (distance(simulation.player, barrel) < TRIGGER_DISTANCE) return;

    this.fired = true;
    this.hold = HOLD_SECONDS;
    this.ctx.spotlight(barrel);
  }
}
