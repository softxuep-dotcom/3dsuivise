import { describe, expect, it } from "vitest";
import { createWorld } from "../src/game/content/createWorld";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import { FUEL_REQUIRED } from "../src/game/simulation/types";
import type { Vec2 } from "../src/game/simulation/types";

/**
 * 左击选中：点在东西上要选中它，点在空地上要什么也不选。
 *
 * 这条守的是键鼠玩家的一个新动作 —— 点一下远处的树，人走过去、自动砍一刀。
 * 判定必须和行动键（E）用同一套规则，否则会出现"点得中却做不了"
 * 或者反过来"走到了却做了另一件事"。
 *
 * **不测手机端**：触屏的 pointerdown 在取世界坐标之前就 return 进摇杆了
 * （InputController.bindCanvas），这套东西按定义跑不到触屏上。
 */
function build(): GameSimulation {
  const sim = new GameSimulation(createWorld());
  sim.enableCritters();
  sim.enableWolves();
  sim.start();
  sim.clockStarted = true;
  return sim;
}

/**
 * 一条朝 +x 的视线。
 *
 * pickAt 现在要沿视线分解「命中点 → 实体」的向量（为什么，见 query/pickAt.ts）。
 * 用例里都直接拿实体自己的坐标当命中点，此时那个向量是零向量，
 * 沿视线和垂距都是 0，任何方向都一样 —— 给一个固定方向就够，读起来也干净。
 */
const LOOK: Vec2 = { x: 1, z: 0 };

/** 把玩家挪到某处，省得每条用例都为"够不够得着"操心。 */
function placePlayer(sim: GameSimulation, at: Vec2): void {
  sim.player.x = at.x;
  sim.player.z = at.z;
}

describe("左击选中", () => {
  it("点在树上选中那棵树，射程用树的 3.2 米", () => {
    const sim = build();
    const tree = sim.trees.find((candidate) => candidate.wood > 0)!;
    const pick = sim.pickAt({ x: tree.x + 0.4, z: tree.z - 0.3 }, LOOK);

    expect(pick).not.toBeNull();
    expect(pick!.intent).toBe("interact");
    expect(pick!.reach).toBeCloseTo(3.2, 5);
    // 返回的是实体本身，不是点击点 —— 走的目标该是那棵树。
    expect(pick!.target.x).toBeCloseTo(tree.x, 5);
    expect(pick!.target.z).toBeCloseTo(tree.z, 5);
  });

  it("点在空地上什么也不选中，调用方退回纯移动", () => {
    const sim = build();
    /*
     * 地图 220×220，中心一带按蓝图是空的。为了不依赖"某一处一定空"，
     * 这里主动找一个方圆 6 米内确实没有任何可选中物的点。
     */
    const arrays: ReadonlyArray<ReadonlyArray<Vec2>> = [
      sim.trees, sim.cacti, sim.ironNodes, sim.items, sim.barrels, sim.critters, sim.wolves,
      sim.wells.map((well) => sim.world.wells[well.id]),
    ];
    let empty: Vec2 | null = null;
    for (let x = -90; x <= 90 && !empty; x += 7) {
      for (let z = -90; z <= 90 && !empty; z += 7) {
        const spot = { x, z };
        const clear = arrays.every((arr) => arr.every((e) => Math.hypot(e.x - x, e.z - z) > 6))
          && Math.hypot(sim.truck.x - x, sim.truck.z - z) > 8;
        if (clear) empty = spot;
      }
    }
    expect(empty).not.toBeNull();
    expect(sim.pickAt(empty!, LOOK)).toBeNull();
  });

  it("点在活狼上是攻击意图，射程用当前武器的攻击距离", () => {
    const sim = build();
    const wolf = sim.wolves.find((candidate) => candidate.mode !== "dead");
    if (!wolf) return; // 白天不一定有狼在场；有才测。
    const pick = sim.pickAt({ x: wolf.x + 0.5, z: wolf.z }, LOOK);

    expect(pick).not.toBeNull();
    expect(pick!.intent).toBe("attack");
    // 初始匕首 3.1 米。攻击射程随武器走，所以只断言它落在武器表的区间里。
    expect(pick!.reach).toBeGreaterThanOrEqual(3.1);
    expect(pick!.reach).toBeLessThanOrEqual(3.8);
  });

  it("死掉的猎物不再能被点中", () => {
    const sim = build();
    const critter = sim.critters.find((candidate) => candidate.mode !== "dead")!;
    const at = { x: critter.x, z: critter.z };
    expect(sim.pickAt(at, LOOK)).not.toBeNull();

    // critterDirector 是私有的；这里要的是"让它死",走内部方法最直接。
    (sim as unknown as { critterDirector: { kill(c: typeof critter): void } }).critterDirector.kill(critter);
    const after = sim.pickAt(at, LOOK);
    // 尸体本身选不中了；同一个点上可能还压着别的东西，但绝不该再是"打它"。
    expect(after?.intent).not.toBe("attack");
  });

  it("扛着油桶时只认卡车，别的一律不选中", () => {
    const sim = build();
    // 出生点那桶就在脚边，一次交互就扛起来了。
    sim.requestInteraction();
    sim.drainEvents();
    expect(sim.getFuelProgress().carrying).toBe(true);

    const tree = sim.trees.find((candidate) => candidate.wood > 0)!;
    expect(sim.pickAt({ x: tree.x, z: tree.z }, LOOK)).toBeNull();

    const onTruck = sim.pickAt({ x: sim.truck.x, z: sim.truck.z }, LOOK);
    expect(onTruck).not.toBeNull();
    expect(onTruck!.intent).toBe("interact");
    expect(onTruck!.reach).toBeCloseTo(5.5, 5);
  });

  it("油装满之后卡车变成「上车」，射程收到 4.5 米", () => {
    const sim = build();
    sim.truck.loaded = FUEL_REQUIRED;
    const pick = sim.pickAt({ x: sim.truck.x, z: sim.truck.z }, LOOK);

    expect(pick).not.toBeNull();
    expect(pick!.reach).toBeCloseTo(4.5, 5);
  });

  /**
   * 点中的东西，和走到那儿之后行动键实际会做的事，**大部分时候**一致。
   *
   * 不是全部：`requestInteraction` 走的是一张"此地最该做的事"的优先级表，
   * 而地面物（枯木、石头）排在采集类前面。于是树旁边正好躺着一根柴时，
   * 玩家点树、走过去、捡起了那根柴 —— 点中的和做到的不是一件事。
   *
   * 这是**有意不修**的：那张优先级表是按玩法调过的（火塘只在比脚边的东西更近时
   * 才占住 E，等等），为了点击去重排它是本末倒置；而"想砍树却捡了根柴"
   * 的代价只是一次点击，柴本身也是玩家要的东西。
   *
   * 真要修得干净，得让 requestInteraction 接受一个指定目标 —— 那是改动那张
   * 一百三十行的表，值得单独做一次。
   *
   * 这里锁的是**比例**：实测 77 个可交互物里有 4 个对不上（5.2%）。
   * 留 10% 的余量，谁把优先级表改得更糟，这条会红。
   */
  it("点中的东西和到位后 E 会做的事，至少九成一致", () => {
    const sim = build();
    let total = 0;
    let agreed = 0;
    const check = (list: ReadonlyArray<Vec2>, want: string): void => {
      for (const entity of list) {
        const pick = sim.pickAt({ x: entity.x, z: entity.z }, LOOK);
        if (!pick || pick.intent !== "interact") continue;
        // 站在射程边缘 —— 这正是 InputController 判定"到了"的那一刻。
        placePlayer(sim, { x: pick.target.x + pick.reach - 0.05, z: pick.target.z });
        total += 1;
        if (sim.getInteractionHint().action === want) agreed += 1;
      }
    };
    check(sim.trees.filter((tree) => tree.wood > 0), "chop");
    check(sim.cacti.filter((patch) => patch.juice > 0), "cactus");
    check(sim.ironNodes.filter((node) => node.ore > 0), "mine");
    check(sim.wells.filter((well) => well.charges > 0).map((well) => sim.world.wells[well.id]), "well");

    expect(total).toBeGreaterThan(60);
    expect(agreed / total).toBeGreaterThanOrEqual(0.9);
  });

  it("提干的井不再能被点中", () => {
    const sim = build();
    const well = sim.wells.find((candidate) => candidate.charges > 0)!;
    const at = sim.world.wells[well.id];
    expect(sim.pickAt({ x: at.x, z: at.z }, LOOK)?.intent).toBe("interact");

    well.charges = 0;
    const after = sim.pickAt({ x: at.x, z: at.z }, LOOK);
    // 井空了就不该再被选中；那个点上如果没有别的东西，结果就是 null。
    if (after) {
      expect(Math.hypot(after.target.x - at.x, after.target.z - at.z)).toBeGreaterThan(0.01);
    }
  });
});
