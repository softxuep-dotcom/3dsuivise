import { distance } from "../game/simulation/geometry";
import type { GameSimulation } from "../game/simulation/GameSimulation";
import type { FuelBarrelState, Vec2 } from "../game/simulation/types";

/**
 * 出生点脚边那桶油：走开了还没碰，就给它点一盏灯。
 *
 * ## 它补的是哪个洞
 *
 * 教学桶在出生点 **2.2 米**（createWorld 的 TUTORIAL_BARREL_RADIUS），而
 * FUEL_PICKUP_REACH 只有 2.6 —— 也就是「能捡」的窗口只有玩家迈出半步之前
 * 那一瞬间，一动就出圈、行动键立刻改讲别的。
 *
 * 而那一瞬间所有东西都在把他往前拉：正前方 ±38° 有三只会动的猎物，
 * 目标行在报卡车的方位，而桶在他侧后方 **126°**（那个角不是随手摆的，
 * 是被营地 3 逼出来的：那里卡车离出生点只有 5.0 米，桶要留住"扛一段路"
 * 这一课就必须绕到背后，偏角小于约 100° 时它会掉进 TRUCK_LOAD_REACH 的圈里）。
 *
 * 更要命的是桶身上**一个视觉标记都没有**：HUD 那支箭头（syncTruckPointer）
 * 永远指卡车，而且"卡车在屏幕上就隐藏" —— 卡车离出生点只有 5.0~13.6 米，
 * 开局必定在屏幕上，所以那支箭头开局根本不出现。
 *
 * ## 为什么是一盏灯，不是一段演出
 *
 * 提过一个方案：凝固时间 + 镜头推到桶上 + 箭头变色 + 再推回来。**否掉了**，
 * 因为那正是被平台数据杀掉过的那一版的形状 —— 见 main.ts 里那段注释：
 * 四步门禁式教学（停表 + 幕布 + 字幕 + 逐步放行），11 场里 4 场活不过 6 秒，
 * 那些人一个超时都没碰到，是被"开局先看一段演出"劝走的。
 *
 * 而且录像显示 **75% 的人本来就会拿桶**，剩下那 25% 就算全救回来，
 * 对平均时长的贡献也不到 20 秒 —— 而 Fit Test 的分辨率是 40~60 秒。
 * 这是个抛光项，不是杠杆，所以它必须便宜：不停表、不夺镜头、不加一个字
 * （12 个 locale 一个都不用动），玩家一边走一边就看见了。
 *
 * 用聚光灯而不是 DOM 幕布，理由和第一夜教学同一条（见 TutorialStage 顶部）：
 * 平台的会话录像抓画布、不抓覆盖层，幕布在回放里根本不存在。
 */

/**
 * 走出这么远还没碰桶就点灯。
 *
 * 8 米是"他已经明确走开了"——出生点到桶才 2.2 米，随手转身都不止这个数——
 * 但还在第一个白天（40 秒）里来得及回头的距离。
 */
const TRIGGER_DISTANCE = 8;

/**
 * 亮多久。渲染层自己带 0.45 秒亮起 / 0.7 秒退场的过渡，这里只管中间那段。
 *
 * 4 秒：够他扫一眼、认出那是什么，又不至于在一个 40 秒的白天里一直挂着。
 * 扛起来的那一刻会提前收灯，不用等满。
 */
const HOLD_SECONDS = 4;

export interface FirstBarrelHintWorld {
  /** getter 而不是值：软重启会换掉 simulation。 */
  readonly simulation: GameSimulation;
  spotlight(target: Vec2 | null): void;
}

export class FirstBarrelHint {
  private barrel: FuelBarrelState | null = null;
  private hold = 0;
  /** 这一局点过了没有。一局最多一次 —— 它是提醒，不是催促。 */
  private fired = false;

  constructor(private readonly ctx: FirstBarrelHintWorld) {}

  /**
   * 每局开头调一次。
   *
   * 这一刻玩家还站在出生点没动，所以**离他最近的那桶地面油就是教学桶** ——
   * 不用去认 id。createWorld 里那一桶是最后 push 的、id 恒为 9，但把那个 9
   * 抄到 UI 层就等于让同一个约定有两处来源，改一处忘一处时没有任何东西会报错。
   */
  reset(): void {
    this.hold = 0;
    this.fired = false;
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
    const sim = this.ctx.simulation;
    const barrel = this.barrel;
    if (!barrel) return;

    if (this.hold > 0) {
      this.hold -= delta;
      // 扛起来了当场收灯；入夜也收 —— 那之后这盏灯归第一夜教学用。
      const taken = barrel.placement !== "ground";
      const leftFirstDay = sim.day !== 1 || sim.phase !== "day";
      if (this.hold <= 0 || taken || leftFirstDay) {
        this.hold = 0;
        this.ctx.spotlight(null);
      }
      return;
    }

    if (this.fired) return;
    /*
     * 只在第一个白天点。入夜之后 NightIntro 也会写 spotlightOn，
     * 两边同时写会互相打架 —— 而这盏灯只有一个目标位。
     */
    if (!sim.running || sim.day !== 1 || sim.phase !== "day") {
      this.fired = true;
      return;
    }
    // 已经扛过桶、或者已经装上车 —— 这一课他自己学会了，别再教。
    if (barrel.placement !== "ground" || sim.truck.loaded > 0) {
      this.fired = true;
      return;
    }
    if (distance(sim.player, barrel) < TRIGGER_DISTANCE) return;

    this.fired = true;
    this.hold = HOLD_SECONDS;
    this.ctx.spotlight(barrel);
  }
}
