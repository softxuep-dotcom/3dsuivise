import { defineConfig } from "vitest/config";

/**
 * 探针的运行配置：`npm run probe`。
 *
 * 和 vitest.config.ts 是两套 include，互不相交 ——
 * `npm test` 只跑 `tests/**` 里带断言的回归测试，探针一个都不跑。
 * 这条分界是有意的：探针没有断言，它们永远不会红，混在测试里只会让
 * "测试全绿"这句话失去意义。为什么要分开，harness.ts 顶上写着。
 *
 * 仍然借 vitest 当运行器（而不是 node 直跑）有两个原因：
 * 探针的 import 是无扩展名路径，得有 Vite 来解析；而 `describe`/`it`
 * 正好当现成的分节手段，输出里每支探针自带标题。
 */
export default defineConfig({
  test: {
    include: ["tools/probes/**/*.probe.ts"],
    // 探针里有整局推演，比回归测试还慢；沿用同一个宽限。
    testTimeout: 20000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-poki/**", ".claude/**"],
  },
});
