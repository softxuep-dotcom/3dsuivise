/**
 * 探针共用的小工具。
 *
 * 这几支探针原先叫 `tests/zz_first60_probe*.test.ts`，跟真正的回归测试混在一起 ——
 * 但它们一个 `expect` 都没有，只有七十多行 `console.log`：它们量的是"开局六十秒
 * 玩家看到什么"，答案要人去读，不是机器去断言。放在 tests/ 下有两个害处：
 * 每次 `npm test` 都白跑一遍，而且"测试全绿"这句话被稀释了 —— 绿的那部分里有五个文件
 * 从来不会红。
 *
 * 现在它们在 `tools/probes/` 下，用 `npm run probe` 单独跑（配置见 vitest.probes.config.ts）。
 * 仍然借 vitest 当运行器：探针的 import 写的是无扩展名路径，得有 Vite 来解析，
 * 而 `describe`/`it` 正好是现成的分节手段。**不要给它们加断言** ——
 * 想锁住的行为应该进 tests/，探针只负责把数字打出来。
 *
 * 五份文件原先各自抄了一遍 STEP / d / render / push，其中 render 还抄出了两个写法
 * （输出一样，格式不同）。这里合成一份。
 */
import { GameSimulation } from "../../src/game/simulation/GameSimulation";
import { en } from "../../src/i18n/locales/en";

/** 探针一律按 20 步/秒推进，和 tests/helpers/simHarness.ts 保持一致。 */
export const STEP = 1 / 20;

/** 平面距离。探针里到处都在量"离那个东西还有多远"。 */
export const d = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z);

/**
 * 把 LocalizedText 渲染成人能读的一行，前面带上键名。
 *
 * 键名要留着：探针的用途之一就是看目标行在哪一秒换了 key，而英文原文会改、键不会。
 */
export function render(text: unknown): string {
  if (typeof text === "string") return text;
  const node = text as { key: string; params?: Record<string, unknown> };
  const table = en as Record<string, string>;
  let out = table[node.key] ?? `??${node.key}`;
  for (const [name, value] of Object.entries(node.params ?? {})) {
    const nested = value as { key?: string } | null;
    const rendered = typeof value === "object" && nested && "key" in nested
      ? (table[nested.key as string] ?? String(nested.key))
      : String(value);
    out = out.replaceAll(`{${name}}`, rendered);
  }
  return `[${node.key}] ${out}`;
}

/**
 * 朝目标直线走，直到进到 stopAt 米以内或者耗光 budget 秒。
 *
 * `stall` 是必需的：这张图有山脊，直线撞上不可走的坡时玩家会原地贴着障碍，
 * 距离一动不动 —— 没有这个出口，探针会把整个预算空转完才返回。
 */
export function push(
  sim: GameSimulation,
  target: { x: number; z: number },
  stopAt: number,
  budget: number,
): { ok: boolean; secs: number } {
  let secs = 0;
  let last = 1e9;
  let stall = 0;
  for (let i = 0; i < budget * 20; i += 1) {
    if (d(sim.player, target) <= stopAt) return { ok: true, secs };
    const dx = target.x - sim.player.x;
    const dz = target.z - sim.player.z;
    const len = Math.hypot(dx, dz) || 1;
    sim.update(STEP, { x: dx / len, z: dz / len });
    secs += STEP;
    sim.drainEvents();
    const now = d(sim.player, target);
    stall = Math.abs(now - last) < 1e-7 ? stall + 1 : 0;
    last = now;
    if (stall > 30) return { ok: false, secs };
  }
  return { ok: false, secs };
}
