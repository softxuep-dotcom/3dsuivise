import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";

const STEP = 1 / 60;

/**
 * 鼠标点击移动的不可达终点回归。
 *
 * 空车不能交互，玩家点到车身时，射线最终给输入层的是车底下那块地。那一点在
 * 卡车碰撞圆里，流场会改用最近的开放格。旧实现到达开放格后仍朝格心输出单位
 * 方向，每帧走 0.137m，越过格心后下一帧反向；人物就会无限来回抽动。
 *
 * 五个出生营地的卡车位置都测，因为不同坡面会把替代终点落在不同格子里。
 */
describe("鼠标点击寻路", () => {
  it("点到卡车占据的不可达地面时，在最近可达格停下而不是逐帧往返", () => {
    for (const campId of [0, 1, 2, 3, 4]) {
      const world = createWorld(undefined, campId);
      const sim = new GameSimulation(world);
      sim.start();

      let stopped = false;
      let reversals = 0;
      let previousMove = { x: 0, z: 0 };
      let previousLength = 0;

      for (let frame = 0; frame < 900; frame += 1) {
        const movement = sim.directionToClickTarget(world.truck);
        if (!movement) {
          stopped = true;
          break;
        }

        const before = { x: sim.player.x, z: sim.player.z };
        sim.update(STEP, movement);
        const moved = { x: sim.player.x - before.x, z: sim.player.z - before.z };
        const length = Math.hypot(moved.x, moved.z);
        if (length > 0.0001 && previousLength > 0.0001) {
          const alignment = (moved.x * previousMove.x + moved.z * previousMove.z) / (length * previousLength);
          if (alignment < -0.25) reversals += 1;
        }
        if (length > 0.0001) {
          previousMove = moved;
          previousLength = length;
        }
      }

      expect(stopped, `营地 ${campId} 没有在替代终点停下`).toBe(true);
      expect(reversals, `营地 ${campId} 在终点附近发生了方向反转`).toBe(0);
    }
  });
});
