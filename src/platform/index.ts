import { NullPlatform, type GamePlatform, type PlatformHooks } from "./GamePlatform";

export type { GamePlatform, PlatformHooks } from "./GamePlatform";
export { NullPlatform } from "./GamePlatform";

/**
 * 建平台并完成握手。**永远 resolve**，SDK 拉不到就退回 {@link NullPlatform} ——
 * 游戏能不能开，不该取决于第三方 CDN 通不通。
 */
export async function createPlatform(hooks: PlatformHooks): Promise<GamePlatform> {
  /*
   * 这个判断**故意不调用 resolvePlatformId()**，而是把两个构建期常量直接摊在这里。
   *
   * 打包器只有看见 `import.meta.env.VITE_PLATFORM === "poki"` 和 `import.meta.env.DEV`
   * 这两个字面量替换后的结果，才能把整支判成死代码、连带摇掉下面那个动态 import。
   * 藏进函数调用里它就推不出来了 —— 实测：包在函数里时，none 构建照样会吐出一个
   * PokiPlatform 分块（1.12 KB，虽然永远不会被请求）。
   */
  const wantsPoki = import.meta.env.VITE_PLATFORM === "poki"
    || (import.meta.env.DEV && new URLSearchParams(window.location.search).get("platform") === "poki");
  if (!wantsPoki) return new NullPlatform();

  try {
    const { PokiPlatform } = await import("./PokiPlatform");
    const platform = new PokiPlatform(hooks, import.meta.env.DEV);
    await platform.init();
    return platform;
  } catch (error) {
    console.warn("[platform] init failed; falling back to none", error);
    return new NullPlatform();
  }
}
