import { describe, expect, it } from "vitest";

/**
 * 模块图的两道护栏：**不许出现循环 import**，**大文件只许变小**。
 *
 * ## 为什么不是 ESLint
 *
 * 原计划这一步是接 ESLint，开 `import/no-cycle` 和 `max-lines` 两条规则。装不上：
 *
 *     peer typescript@">=4.8.4 <6.1.0" from typescript-eslint@8.68.0
 *     Found: typescript@7.0.2
 *
 * `typescript-eslint` 还不支持 TypeScript 7，而这个仓库用的正是 7.0.2。
 * 用 `--force` 硬装等于让一个为 TS ≤6 写的解析器去解析 TS 7 的语法 —— 那是埋雷，
 * 不是省事。等 typescript-eslint 支持 TS 7 之后可以把这两条换回真 ESLint，
 * 到那时这个文件就可以删掉。
 *
 * 在此之前用这两条测试顶上。它们其实更贴合这个仓库：跟着 `npm test` 跑，
 * 不引入任何依赖，而且第二条能当重构进度的**记分牌**用。
 */

/*
 * 用 import.meta.glob 读源码，理由和 domContract.test.ts 一样：这个仓库没装
 * @types/node，而 Vite 的 ?raw 在 vitest 里本来就通。
 */
const rawSources = import.meta.glob("../src/**/*.{ts,css}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** glob 的键是 "../src/xxx"，统一成仓库相对路径 "src/xxx"。 */
const sources = new Map<string, string>(
  Object.entries(rawSources).map(([key, value]) => [key.replace(/^\.\.\//, ""), value]),
);

/*
 * 只用 glob 的键建立资源清单，不加载二进制内容。CSS 拆目录时 `url(./...)`
 * 最容易悄悄指向旧位置；开发服缓存可能掩盖问题，生产包才会变成空图标。
 */
const assetModules = import.meta.glob("../src/**/*.{png,jpg,jpeg,webp,svg}", {
  query: "?url",
  import: "default",
});
const assets = new Set(Object.keys(assetModules).map((key) => key.replace(/^\.\.\//, "")));

function resolveRelativePath(importer: string, specifier: string): string {
  const parts = importer.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * 把一条 import 说明符解析成仓库里的文件路径；不是本地相对导入就返回 null。
 *
 * 三种写法都要认：`./geometry`（同目录）、`../terrain/TerrainModel`（跨目录）、
 * `./platform`（目录，实际指向 platform/index.ts）。
 */
function resolveSpecifier(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const parts = importer.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === ".") continue;
    else if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const base = parts.join("/");
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
    if (sources.has(candidate)) return candidate;
  }
  return null;
}

/**
 * 一个文件静态 import 了哪些本地模块。
 *
 * 刻意**排除两类**：
 *   `import type ... from`  —— 编译后整行消失，构不成运行时循环。不排掉的话
 *                              types.ts 会和几乎每个文件成环，这道护栏就永远是红的。
 *   `import("...")`         —— 动态导入是按需加载，不参与模块初始化顺序。
 *                              i18n 的十三种语言全靠它，那是有意的设计。
 */
function staticImports(importer: string, source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/^import\s+(?!type\s)[\s\S]*?from\s+"([^"]+)"/gm)) {
    const resolved = resolveSpecifier(importer, match[1]);
    if (resolved) found.push(resolved);
  }
  return found;
}

describe("模块图", () => {
  it("src 里没有循环 import", () => {
    const graph = new Map<string, string[]>();
    for (const [path, source] of sources) {
      if (!path.endsWith(".ts")) continue;
      graph.set(path, staticImports(path, source));
    }

    // 标准的三色 DFS。找到环时把整条路径打出来 —— 只说"有环"的报错等于没报。
    const cycles: string[] = [];
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];
    const walk = (node: string): void => {
      if (state.get(node) === "done") return;
      if (state.get(node) === "visiting") {
        cycles.push([...stack.slice(stack.indexOf(node)), node].join(" → "));
        return;
      }
      state.set(node, "visiting");
      stack.push(node);
      for (const next of graph.get(node) ?? []) walk(next);
      stack.pop();
      state.set(node, "done");
    };
    for (const node of graph.keys()) walk(node);

    expect(cycles.sort()).toEqual([]);
  });

  it("CSS 的本地图片路径都指向现存资源", () => {
    const missing: string[] = [];
    for (const [path, source] of sources) {
      if (!path.endsWith(".css")) continue;
      for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        const specifier = match[1];
        if (/^(?:data:|https?:|\/)/.test(specifier)) continue;
        const resolved = resolveRelativePath(path, specifier);
        if (!assets.has(resolved)) missing.push(`${path}: ${specifier} → ${resolved}`);
      }
    }
    expect(missing.sort()).toEqual([]);
  });

  /**
   * 大文件的天花板，**只许降不许升**。
   *
   * 这张表是重构的记分牌：拆完一块就把对应的数字改小，它就再也回不去了。
   * 表里没有的文件一律吃 {@link DEFAULT_MAX} —— 也就是说**新建的文件不许超过 600 行**，
   * 这条比给存量设上限更重要：存量是历史，新文件是选择。
   *
   * 数字来自 2026-08-25 的现状（lastcar @ d8bbd25），随重构逐步下调。
   */
  it("大文件只许变小", () => {
    const DEFAULT_MAX = 600;
    const CEILINGS: Record<string, number> = {
      // 阶段 1 把 646 行平衡常量搬去 balance/：3518 → 3052。
      // 阶段 2 抽走八个子系统：3052 → 1853。下一个目标是 update() 编排 + 状态容器，
      // 也就是 600 行以内 —— 到那时这一行就该从表里删掉。
      // 1901 → 1935：接入左击选中（pickAt）。判定本体在 query/pickAt.ts，
      // 这里只有一个显式构造上下文再转发的方法 —— 之所以不能写 `{ ...this }`，
      // 那 34 行的注释里说了：wolves 和 critters 是原型上的 getter，展开不会带上。
      // 1939 → 1954：noteWoodIntake（柴进包的唯一汇合点）。它挂在 addInventory 上
      // 而不是那两处 pickup 事件旁边，注释解释了为什么 —— 调用点会长第三处，
      // 漏挂不报错，只会让目标行悄悄停在上一阶。
      "src/game/simulation/GameSimulation.ts": 1954,
      // 阶段 3 抽走视觉常量与三个动态实体池：2938 → 2274。
      // 剩下的 build*（开局建一次）和 sync*（每帧）还混在一起，是下一刀。
      // 2274 → 2298：screenToWorld 拆成 screenToGround，多交出一个"射线在地面上
      // 朝哪走"。这个方向不是可有可无的：玩家点的是物体画出来的像素（离地一两米），
      // 射线打在物体身后 0.8~13.4 米，判定必须沿视线分解才不会落空。
      // 2298 → 2319：六个 builder 各加一句 mergeStaticMeshes（含解释为什么安全的注释）。
      // 换来的是绘制调用 299 → 143，见 visuals/mergeStatic.ts。
      // 2319 → 2363：地面枯木从"横躺"改成"立起来"，以及那段解释 —— 可捡的柴和
      // 装饰用的 deadwood 地标原本是同一个剪影（都是 rotation.z = π/2 的褐色圆柱），
      // 实测第一个白天只有 9.6% 的人捡到过柴。为什么必须写下来：三个月后看见
      // 两套几何只差一个 placed 分支，最省事的"化简"就是把它合回去。
      "src/render/GameRenderer.ts": 2363,
      // 1171 → 1172：EquipTier 跟着数值搬去了 balance/equipment，
      // 于是这里从两行 import 变成三行。这是全程唯一一处上调，且只此一行。
      "src/ui/HudController.ts": 1172,
      // styles.css 阶段 3 拆成六段，自己只剩 @import；六段各自都在 600 行以内。
      // 下面三处 +438/+1124/+670 是同一次改动（修"狗朝另一个方向咬"）的三半：
      // 咬击分支 return 收尾，够不到函数末尾那句 wolf.facing = steered，于是朝向
      // 冻在冲进射程那一帧。三个文件各加一段注释解释这个非局部的因果 ——
      // 三处代码分开看每一处都"没写错"，不写下来下一个人一定会再踩一次。
      "src/render/entities/CreatureViews.ts": 438,
      "src/game/simulation/WolfDirector.ts": 1124,
      "src/game/content/createWorld.ts": 706,
      "src/game/simulation/types.ts": 670,
    };

    const over: string[] = [];
    for (const [path, source] of sources) {
      // 末尾换行不算一行，跟 `wc -l` 和编辑器的行号对齐 ——
      // 上限表里的数字是人照着编辑器填的，两边的算法必须是同一套。
      const lines = source.replace(/\n$/, "").split("\n").length;
      const ceiling = CEILINGS[path] ?? DEFAULT_MAX;
      if (lines > ceiling) over.push(`${path}: ${lines} 行 > 上限 ${ceiling}`);
    }
    /*
     * 红了怎么办：
     *   拆分之后变小了 → 把 CEILINGS 里的数字改成新值，锁住这次收益。
     *   新文件超了     → 那说明它一出生就该拆，先拆再提交。
     *   确实必须变大   → 改上限，但要在提交信息里写清为什么。
     */
    expect(over.sort()).toEqual([]);
  });
});
