import { defineConfig } from "vite";

/**
 * `mode` 就是平台开关，不再走 `.env.*` 文件。
 *
 * 本来是 `.env.poki` + `VITE_PLATFORM=poki`，但仓库的 .gitignore 里有 `.env.*` ——
 * 那个文件永远进不了版本库，别人 clone 下来跑 `npm run build:poki` 会**静默**
 * 产出一个不含平台代码的普通版，而且构建成功、毫无提示。
 * 把开关放进 config 就没有这个洞：模式名自己就是唯一的真相。
 */
export default defineConfig(({ mode }) => ({
  base: "./",
  define: {
    "import.meta.env.VITE_PLATFORM": JSON.stringify(mode === "poki" ? "poki" : ""),
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
}));
