/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 构建产物面向哪个游戏平台。空或 "none" 表示不接任何平台 SDK
   * （本地开发、GitHub Pages、itch.io 都是这一档）。
   *
   *   VITE_PLATFORM=poki npm run build
   */
  readonly VITE_PLATFORM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
