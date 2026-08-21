import { defineConfig } from "vitest/config";

/*
 * 自动机报表专用配置。
 *
 * 单独一份而不是塞进 vitest.config.ts 的 include：报表跑的是整局
 * （最长 900 模拟秒 × 20 步/秒），比单元测试慢一个量级，不该拖慢 `npm test`。
 * 这一版 vitest 的 CLI 没有 --include，所以只能靠 --config 切换。
 *
 * exclude 里的 .claude/ 和主配置同理 —— 那底下是同一个仓库的其它 worktree。
 */
export default defineConfig({
  test: {
    include: ["tools/**/*.report.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-poki/**", ".claude/**"],
    testTimeout: 600_000,
  },
});
