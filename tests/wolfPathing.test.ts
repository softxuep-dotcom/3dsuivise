import { describe, expect, it } from "vitest";
import {
  CAMP_IDS, STEP, campLabel, distanceTo, heightAt, keepPlayerAlive, livingRaiders, runNight, sharedWorld,
} from "./helpers/simHarness";
import type { Vec2 } from "../src/game/simulation/types";
import { GameSimulation } from "../src/game/simulation/GameSimulation";
import { direction, dot } from "../src/game/simulation/geometry";

/*
 * 这四条断言全部来自真实事故，不是凭空写的验收标准。
 *
 * 2026-08 修的那批 bug 有一个共同的表现：狗跑到营地下面，站着看玩家，不上来咬。
 * 背后是**五个互相独立**的原因（视线当可通行用、坡度判据把实体钉死、流场对角穿墙、
 * 巡逻模式无解卡、碰撞把狗推进地形里）。五个都只能靠跑完一整夜再看统计量才发现，
 * 截图和 typecheck 一个都拦不住。所以它们值得常驻。
 */

describe("狗群寻路 · 不许僵住", () => {
  /**
   * 修复前最长一只连续静止 168 秒（一夜共 180 秒），修复后最长 3.7 秒。
   * 阈值放到 8 秒：留足余量给正常的短暂停顿（拆树桩、绕障碍），
   * 但任何"站到天亮"的回归都会被捞出来。
   */
  const MAX_FROZEN_SECONDS = 8;

  it.each(CAMP_IDS)("营地 %i：没有狗长时间钉在原地", (campId) => {
    const prev = new Map<number, Vec2>();
    const frozenRun = new Map<number, number>();
    let worstId = -1;
    let worst = 0;
    let worstDistance = 0;

    runNight({
      campId,
      onStep: (sim) => {
        for (const w of sim.wolves) {
          if (w.mode === "dead") { prev.delete(w.id); frozenRun.delete(w.id); continue; }
          const before = prev.get(w.id);
          prev.set(w.id, { x: w.x, z: w.z });
          if (!before) continue;
          const moved = distanceTo(w, before);
          const d = distanceTo(w, sim.player);
          // 咬击距离内不动 = 正在咬人；撤退/入场是过场状态。其余都该在动。
          const shouldMove = w.mode !== "retreating" && w.mode !== "entering" && d > 2.5 && d < 30;
          if (shouldMove && moved < 1e-4) {
            const run = (frozenRun.get(w.id) ?? 0) + STEP;
            frozenRun.set(w.id, run);
            if (run > worst) { worst = run; worstId = w.id; worstDistance = d; }
          } else {
            frozenRun.set(w.id, 0);
          }
        }
      },
    });

    expect(
      worst,
      `${campLabel(campId)}：狗 #${worstId} 在离玩家 ${worstDistance.toFixed(1)} 米处连续静止 ${worst.toFixed(1)} 秒`,
    ).toBeLessThan(MAX_FROZEN_SECONDS);
  });
});

describe("营地崖壁 · 必须挡得住", () => {
  /**
   * 营地的防御价值全靠"只能走坡道上来"。解卡机制放宽了坡度限制，
   * 这条就是它的护栏：放宽到能让玩家直接爬上台面，营地就白修了。
   */
  it.each(CAMP_IDS)("营地 %i：玩家从背面直冲 20 秒也上不了台面", (campId) => {
    const camp = sharedWorld.camps[campId];
    const sim = new GameSimulation(sharedWorld);
    const inner = sim as unknown as { clockStarted: boolean; running: boolean };
    inner.clockStarted = true;
    inner.running = true;

    // 从入口的反方向接近 —— 那边是崖壁，不是坡道。
    const back = camp.entranceAngle + Math.PI;
    const from = { x: camp.x + Math.cos(back) * 16, z: camp.z + Math.sin(back) * 16 };
    sim.player.x = from.x;
    sim.player.z = from.z;

    const toward = { x: camp.x - from.x, z: camp.z - from.z };
    const len = Math.hypot(toward.x, toward.z);
    const movement = { x: toward.x / len, z: toward.z / len };
    for (let i = 0; i < Math.round(20 / STEP); i += 1) sim.update(STEP, movement);

    const platform = heightAt(camp);
    const reached = heightAt(sim.player);
    expect(
      platform - reached,
      `${campLabel(campId)}：玩家爬到了 ${reached.toFixed(1)}，台面才 ${platform.toFixed(1)} —— 崖壁失效`,
    ).toBeGreaterThan(1.5);
  });
});

describe("天亮撤退 · 必须清场", () => {
  it("天亮 60 秒后场上没有夜袭犬", () => {
    const sim = runNight({ campId: 4, seconds: 60 });
    const atDawn = livingRaiders(sim).length;
    expect(atDawn, "夜里就没刷出狗，这条测试等于没测").toBeGreaterThan(3);

    // 继续跑到天亮之后；runNight 的夜长是 180 秒，这里补跑到相位切换再 +60 秒。
    for (let i = 0; i < Math.round(180 / STEP); i += 1) {
      keepPlayerAlive(sim);
      sim.update(STEP, { x: 0, z: 0 });
    }
    expect(
      livingRaiders(sim).length,
      "天亮后还有夜袭犬赖在图上 —— 撤退路径被卡住了",
    ).toBe(0);
  });
});

describe("攻营犬 · 必须真的能打到人", () => {
  /**
   * 上一版最隐蔽的一种坏法：狗不再"僵住"了，改成在崖下原地打转 ——
   * 每秒走 2.11 米路程、净位移 0.00 米。任何只看"有没有在动"的断言都抓不到它，
   * 只有直接问"到底有几只摸到了咬击距离"才拦得住。
   *
   * 阈值按"挂了 raider 标记的狗"来定，而这个数会随难度调参浮动
   * （EARLY_NIGHT_WOLF_TARGETS 改过一次，第一夜 40 → 30，攻营犬 8 → 5）。
   * 所以门槛压得很低：只要求"有那么几只真的打到了人"，不锁具体数量，
   * 免得每次调数值这条测试就误报。
   * 岩壁洞窟单独放宽到 1 —— 它设计上就是单一窄入口的最强防守点。
   */
  const MIN_REACHED: Record<number, number> = { 0: 2, 1: 2, 2: 1, 3: 2, 4: 2 };

  it.each(CAMP_IDS)("营地 %i：有足够多的攻营犬摸到咬击距离", (campId) => {
    const reached = new Set<number>();
    runNight({
      campId,
      onStep: (sim) => {
        for (const w of sim.wolves) {
          if (w.mode === "dead" || !w.raider) continue;
          if (distanceTo(w, sim.player) < 1.75) reached.add(w.id);
        }
      },
    });
    expect(
      reached.size,
      `${campLabel(campId)}：整夜只有 ${reached.size} 只攻营犬摸到玩家 —— 它们大概率卡在台地下面了`,
    ).toBeGreaterThanOrEqual(MIN_REACHED[campId]);
  });
});

describe("攻营犬 · 追丢之后必须再来", () => {
  /**
   * 第六种坏法，也是最难看出来的一种：狗**没有**僵住，甚至还在跑，
   * 只是再也不朝玩家跑了。
   *
   * chase 追丢原先一律退回 patrol，而 patrol 只绕自己的锚点转圈，且状态机里
   * **没有任何一条边通回 raid**。于是每只攻营犬一夜只有一次机会：被躲开或被打退
   * 一次，就永久降级成一只在营地外绕圈的观光犬。玩家看到的正是"狼跑过来又跑走"。
   *
   * 这条只问一件事：夜里挂着 raider 标记的狗，有没有在 patrol 上耗时间。
   * 不问它跑得多快、离得多近 —— 那些上面几条已经在管了。
   */
  const MAX_PATROL_SECONDS = 4;

  it.each(CAMP_IDS)("营地 %i：夜里没有攻营犬退回巡逻绕圈", (campId) => {
    const patrolSeconds = new Map<number, number>();
    runNight({
      campId,
      // 站桩量不出来：狗一旦贴上就永远贴着，根本不会追丢。
      // 每 12 秒挪 2 秒位，才是守夜的真实节奏。
      onStep: (sim, step) => {
        for (const w of sim.wolves) {
          // 还排着班、在巢边等着动身的不算 —— 那是设计好的分波，不是"退役"。
          if (w.mode !== "patrol" || !w.raider || w.raidAt > 0) continue;
          patrolSeconds.set(w.id, (patrolSeconds.get(w.id) ?? 0) + STEP);
        }
        void step;
      },
      move: (t) => (t % 12 < 2 ? { x: Math.cos(t * 0.9), z: Math.sin(t * 0.9) } : { x: 0, z: 0 }),
    });

    let worstId = -1;
    let worst = 0;
    for (const [id, seconds] of patrolSeconds) {
      if (seconds > worst) { worst = seconds; worstId = id; }
    }
    expect(
      worst,
      `${campLabel(campId)}：攻营犬 #${worstId} 整夜有 ${worst.toFixed(1)} 秒在巡逻绕圈 —— 它已经不再攻营了`,
    ).toBeLessThan(MAX_PATROL_SECONDS);
  });
});


describe("咬人 · 必须朝着人", () => {
  /**
   * "狗朝另一个方向咬"。1.1.31 实机报的，成因横跨模拟层和表现层两处，
   * 而**任何一处单独看都不像错**：
   *
   *   模拟层  咬击分支是 return 收尾的，够不到 updateWolf 末尾那句
   *           `wolf.facing = steered`。狗进了 1.75 米就不再移动，
   *           于是朝向冻在"冲进射程那一帧"。
   *   表现层  显示朝向只在"这一帧真的位移了"时才更新（那条规矩本身是对的：
   *           寻路会在障碍前左右试探 facing，跟着转会原地甩身）。
   *           而咬人时位移恒为 0，于是它永远不更新。
   *
   * 所以玩家绕到侧面之后，狗照咬不误、脸却还朝着原来那条冲刺线。
   * 站桩测不出来 —— 站着不动时冻住的那个方向恰好就是对的。**必须让玩家动。**
   *
   * 这条只守模拟层那一半（facing 每帧对着人写）。表现层那一半守不到：
   * 它要真的起渲染器。两者的因果写在 WolfState.biting 的注释里。
   */
  /** cos 0.9 ≈ 25°。真值应该贴着 1.0，留这么多余量是给"玩家在狗更新之后又走了一帧"。 */
  const MIN_COS = 0.9;

  it("玩家绕着狗走时，正在咬的狗每一帧都朝着玩家", () => {
    let worst = 1;
    let worstDistance = 0;
    let samples = 0;

    runNight({
      campId: 0,
      /*
       * 停 1.2 秒、走 0.6 秒，每个周期换一个方向。
       *
       * 一直绕圈是不行的：玩家速度比狗快，整夜只咬到 8 帧，样本不够。
       * 而这个占空比正好造出要测的那个局面 —— 停的时候狗贴上来开咬（朝向这时是对的），
       * 走的时候人横着挪开，逼它每一帧重新对准。旧代码正是在这半秒里露馅。
       */
      move: (elapsed) => {
        const cycle = elapsed % 1.8;
        if (cycle < 1.2) return { x: 0, z: 0 };
        const angle = Math.floor(elapsed / 1.8) * 1.1;
        return { x: Math.cos(angle), z: Math.sin(angle) };
      },
      onStep: (sim) => {
        for (const w of sim.wolves) {
          if (!w.biting || w.mode === "dead") continue;
          // 完全重合时 direction() 返回 {0,0}（见 geometry.normalize），量不出角度。
          const d = distanceTo(w, sim.player);
          if (d < 0.05) continue;
          samples += 1;
          const cos = dot(w.facing, direction(w, sim.player));
          if (cos < worst) { worst = cos; worstDistance = d; }
        }
      },
    });

    expect(samples, "整夜一帧都没咬到人 —— 这条测试等于没测").toBeGreaterThan(20);
    const degrees = (Math.acos(Math.min(1, Math.max(-1, worst))) * 180) / Math.PI;
    expect(
      worst,
      `有狗在离玩家 ${worstDistance.toFixed(2)} 米处咬人，脸却偏了 ${degrees.toFixed(0)}°`,
    ).toBeGreaterThan(MIN_COS);
  });
});
