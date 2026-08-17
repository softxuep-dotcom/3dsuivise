import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /*
     * 必须排掉 .claude/ —— 那底下是**同一个仓库的其它 git worktree**，
     * 每个都有一份完整的源码和一份同名的 tests/。不排除的话 vitest 会把它们
     * 一起收进来：同一套测试跑好几遍，而且每遍跑的是**不同分支**的源码，
     * 于是同一个用例一会儿过一会儿挂，查起来极其费劲（实测 16 个用例变成 32 个）。
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-poki/**", ".claude/**"],
  },
});
