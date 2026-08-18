import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /*
     * 20 秒，不是 vitest 默认的 5 秒。
     *
     * 这套测试每条都要把一整夜（180 模拟秒 × 20 步/秒 = 3600 帧，几十只狗全量寻路）
     * 跑完再看统计量 —— 单条本来就在 3.5~4 秒，默认 5 秒等于把余量压到零，
     * 随便加点东西就集体超时，而且超时报出来是 "Test timed out"，
     * 看着像死循环，实际只是慢了 20%。这类模拟测试不该按单元测试的尺子量。
     */
    testTimeout: 20000,
    /*
     * 必须排掉 .claude/ —— 那底下是**同一个仓库的其它 git worktree**，
     * 每个都有一份完整的源码和一份同名的 tests/。不排除的话 vitest 会把它们
     * 一起收进来：同一套测试跑好几遍，而且每遍跑的是**不同分支**的源码，
     * 于是同一个用例一会儿过一会儿挂，查起来极其费劲（实测 16 个用例变成 32 个）。
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-poki/**", ".claude/**"],
  },
});
