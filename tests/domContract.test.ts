import { describe, expect, it } from "vitest";

/**
 * index.html 与 TypeScript 之间那份 id 契约。
 *
 * ## 它防的是什么
 *
 * HUD 一共有 91 个 id，代码按名字取其中 82 个（光 HudController 就有 67 处
 * `required("...")`）。这份契约今天完全靠字符串对齐，没有任何编译期保障：
 * 在 index.html 里把一个 id 改个名，tsc 一声不吭，测试全绿，**要等到玩家点开游戏、
 * HudController 构造到那一行才抛**。那已经是加载流程的中段，屏幕上只有一个白屏。
 *
 * 这条测试把那一刻提前到 CI。
 *
 * ## 为什么是静态扫描而不是 jsdom
 *
 * 更"真"的做法是装 jsdom、把真实 index.html 灌进 document、构造一次 HudController，
 * 让 66 个 `required()` 自己去抛。没有那么做有两个原因：
 *
 *   一，静态扫描覆盖面**更大**。它同时管住 main.ts、TutorialStage、InputController、
 *       GameRenderer 里的 `getElementById` —— 那些地方大多写成 `?.`，就算元素没了
 *       也不会抛，构造 HudController 根本发现不了。
 *   二，为一条测试引入 jsdom 要在一个只有 5 个生产依赖的仓库里加一坨新依赖，
 *       而它买到的东西比扫描还少。
 *
 * 代价是扫描认的是字面量：`getElementById(someVariable)` 这种取法它看不见。
 * 目前只有 main.ts 里那个重开按钮的数组是这样，下面的软清单会兜住它。
 */

/** 从源码里挖出所有按字面量写死的 DOM id。 */
const ID_PATTERNS: readonly RegExp[] = [
  // HudController 的 required<HTMLElement>("hud")
  /required<[^>]*>\("([A-Za-z0-9_-]+)"\)/g,
  // 各处的 document.getElementById("...")
  /getElementById\("([A-Za-z0-9_-]+)"\)/g,
  // querySelector / querySelectorAll 的 "#id ..." 前缀
  /querySelector(?:All)?(?:<[^>]*>)?\("#([A-Za-z0-9_-]+)/g,
];

function idsIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const pattern of ID_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

/*
 * 用 import.meta.glob 而不是 node:fs 读源码：这个仓库没装 @types/node，
 * 而 Vite 的 ?raw 在 vitest 里本来就通，不用为一条测试多一个依赖。
 */
const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const indexHtml = Object.values(
  import.meta.glob("../index.html", { query: "?raw", import: "default", eager: true }),
)[0] as string;

const htmlIds = new Set([...indexHtml.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

/** index.html 里那段内联启动脚本自己取的 id：进度条、手势解锁、横屏锁。 */
const bootScript = indexHtml.slice(indexHtml.indexOf("<script"), indexHtml.lastIndexOf("</script>"));
const bootIds = idsIn(bootScript);

describe("index.html ↔ TypeScript 的 id 契约", () => {
  it("代码里按 id 取的元素，index.html 里都得有", () => {
    const missing: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      for (const id of idsIn(source)) {
        if (!htmlIds.has(id)) missing.push(`${path.replace("../", "")} → #${id}`);
      }
    }
    // 报出**是哪个文件要哪个 id**，而不是只说"少了一个" —— 这条测试红的时候，
    // 通常是刚在 index.html 里改了名，需要立刻知道去哪里同步。
    expect(missing.sort()).toEqual([]);
  });

  it("html 里有、但没有任何 TS 按 id 取的元素", async () => {
    const referenced = new Set<string>();
    for (const source of Object.values(sources)) for (const id of idsIn(source)) referenced.add(id);

    const orphans = [...htmlIds].filter((id) => !referenced.has(id)).sort();
    const report = [
      "以下 id 出现在 index.html，但没有任何 src/**/*.ts 按名字取它。",
      "这不是错误 —— 它们可能只被 CSS、data-i18n、内联启动脚本或变量取法用到。",
      "这份清单是**软清单**：它变了说明 HUD 的结构变了，请确认那是你想要的。",
      "",
      ...orphans.map((id) => `  #${id}${bootIds.has(id) ? "   ← 内联启动脚本在用" : ""}`),
    ].join("\n");
    await expect(report).toMatchFileSnapshot("./__snapshots__/dom-orphan-ids.txt");
  });
});
