import { describe, expect, it } from "vitest";
import { baselineFuelRun, baselineIdleDay, baselineNightPack } from "./helpers/baseline";

/**
 * 行为基线。**这三条用例不检查任何具体数值，只检查"和上次一模一样"。**
 *
 * 它们存在的唯一理由是给重构当验收标准：拆文件、搬常量、抽子系统都不该改变行为，
 * 而快照 diff 为空是唯一能证明这件事的东西。为什么它做得到（模拟层是确定性的）、
 * 三个场景各锁哪些数值，写在 helpers/baseline.ts 顶上。
 *
 * ## 快照红了怎么办
 *
 * **先假定是你改坏了，不要直接 `-u`。** diff 会指出是哪一秒、哪条轴、哪个事件变的，
 * 顺着它回去看那一处改动。只有在你**有意**改了玩法或数值时才更新快照 ——
 * 那时候快照 diff 正好是这次改动的完整影响清单，值得贴进提交信息里。
 *
 * 更新命令：`npx vitest run tests/baseline.test.ts -u`
 */
describe("行为基线", () => {
  it("A：站着不动的一昼夜", async () => {
    await expect(baselineIdleDay()).toMatchFileSnapshot("./__snapshots__/baseline-a-idle.txt");
  });

  it("B：取一桶油装上车", async () => {
    await expect(baselineFuelRun()).toMatchFileSnapshot("./__snapshots__/baseline-b-fuel.txt");
  });

  it("C：守营过一整夜", async () => {
    await expect(baselineNightPack()).toMatchFileSnapshot("./__snapshots__/baseline-c-night.txt");
  });
});
