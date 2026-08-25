import { applyStaticText, getLocale, getSupportedLocales, onLocaleChange, setLocale, t } from "../i18n";
import type { Locale } from "../i18n";
import { normalizeDifficulty } from "../game/simulation/difficulty";
import type { Difficulty } from "../game/simulation/difficulty";
import type { SynthAudio } from "../audio/SynthAudio";
import type { GamePlatform } from "../platform/GamePlatform";
import type { HudController } from "./HudController";
import { bumpRunIndex, saveDifficulty } from "./Settings";

/**
 * 游戏**外壳**的接线：重开、暂停、难度、声音、语言。
 *
 * 这些和一局游戏本身没有关系 —— 它们是围在游戏外面那一圈按钮。
 * 原先和组合根、帧循环挤在 main.ts 的同一个 500 行函数里，于是"改一下语言下拉"
 * 和"改一下每帧的事件分发"要在同一个作用域里找位置。
 *
 * main.ts 现在只剩两件事：**把各层拼起来**，和**每帧推一次**。
 *
 * ## 为什么不用 required()
 *
 * 这里一律用 `getElementById(...)?.` 的可选写法，缺了就静默跳过 ——
 * 和 HudController 的 `required()`（缺了就抛）刻意不同。理由是这两类元素的性质不同：
 * HUD 上那 66 个是**游戏跑起来必须有**的，缺一个就该立刻炸；
 * 而外壳这些是按钮，少一个只是少一个功能，不该把整局游戏拦在门外。
 * 两边都被 tests/domContract.test.ts 扫着，写错 id 在 CI 里就会红。
 */
export interface ShellOptions {
  hud: HudController;
  audio: SynthAudio;
  platform: GamePlatform;
  /** 本局用的难度档。用来判断"选的和正在跑的是不是同一档"。 */
  difficulty: Difficulty;
  /** 「再来一局」：软重启，不刷页。实现在 main.ts，因为要换掉 world 和 simulation。 */
  softRestart: (button: HTMLElement | null) => Promise<void>;
}

export function bindShell({ hud, audio, platform, difficulty, softRestart }: ShellOptions): void {
  /*
   * 换难度要整页刷新。
   *
   * 狼的数值是生成时按难度算进去的，而难度在 bootstrap 开头只读一次
   * （见 difficulty.ts 顶部）。这条路很少走，留着最保险的做法。
   *
   * 重开前插一次插屏广告，时机是**点了按钮之后**而不是死亡那一刻 ——
   * 这是平台反复强调的：广告要放在玩家已经表达"我要继续"的自然断点上。
   * 按钮点完立刻置灰，否则连点两下会叠两次广告请求。
   */
  const reloadWithBreak = async (button: HTMLElement | null): Promise<void> => {
    if (button instanceof HTMLButtonElement) button.disabled = true;
    bumpRunIndex();
    await platform.commercialBreak();
    window.location.reload();
  };

  for (const id of ["restart-button", "victory-restart-button"]) {
    const button = document.getElementById(id);
    button?.addEventListener("click", () => { void softRestart(button); });
  }
  // 齿轮即暂停键：底排腾出来只放四个操作键，而暂停控件仍然看得见、点得到。
  document.getElementById("settings-button")?.addEventListener("click", () => hud.togglePause());
  document.getElementById("pause-resume")?.addEventListener("click", () => hud.setPaused(false));

  /*
   * 难度：点一下就存下来（下次自然重开即生效），同时亮出"重开一局"。
   * 不做热切换 —— 狼的数值是生成时算的，跑到一半换档只会让新旧狼混在同一夜里。
   */
  const difficultyRestart = document.getElementById("difficulty-restart");
  for (const option of document.querySelectorAll<HTMLButtonElement>("#difficulty-options [data-difficulty]")) {
    option.addEventListener("click", () => {
      const picked = normalizeDifficulty(option.dataset.difficulty);
      saveDifficulty(picked);
      hud.setDifficultySelection(picked);
      difficultyRestart?.classList.toggle("hidden", picked === difficulty);
    });
  }
  difficultyRestart?.addEventListener("click", () => { void reloadWithBreak(difficultyRestart); });

  /*
   * 声音按钮的文字**不能**交给 applyStaticText 重刷。
   *
   * `#sound-state` 上写的是 data-i18n="sound.on"，而它的真实内容取决于当前开关状态。
   * 切语言时 applyStaticText 会把所有 data-i18n 节点重填一遍 —— 那会把"已关闭"
   * 硬改回"已开启"。所以单独抽出来，切语言时调这个而不是让它走通用路径。
   */
  const syncSoundLabel = (): void => {
    const button = document.getElementById("sound-button");
    const state = document.getElementById("sound-state");
    if (state) state.textContent = t(audio.enabled ? "sound.on" : "sound.off");
    button?.setAttribute("aria-pressed", String(audio.enabled));
  };
  document.getElementById("sound-button")?.addEventListener("click", async () => {
    await audio.unlock().catch(() => { /* 解锁失败不影响游戏，静默忽略。 */ });
    audio.toggle();
    syncSoundLabel();
  });

  /*
   * 设置里的语言选择。
   *
   * 选项文字用各语言自己的写法，不随界面语言变，所以切完不需要重建 select。
   * 切换是异步的（语言表按需下载），失败时 setLocale 返回 false 并保持原语言，
   * 这里把下拉的选中值拨回去，免得显示的和实际用的不一致。
   */
  const languageSelect = document.getElementById("language-select") as HTMLSelectElement | null;
  if (languageSelect) {
    for (const meta of getSupportedLocales()) {
      const option = document.createElement("option");
      option.value = meta.code;
      option.textContent = meta.label;
      languageSelect.append(option);
    }
    languageSelect.value = getLocale();
    languageSelect.addEventListener("change", () => {
      void (async () => {
        // remember=true：设置里选过就存下来，下次开局它压过浏览器语言，见 detectLocale。
        const ok = await setLocale(languageSelect.value as Locale, true);
        if (!ok) languageSelect.value = getLocale();
      })();
    });
  }

  /*
   * 切语言后重刷界面。
   *
   * 目标行、时钟、行动键这些每 80ms 自己重算，不用管；要管的是**只写一次**的那些：
   * 所有 data-i18n 静态节点、声音状态、纪录行。
   */
  onLocaleChange(() => {
    applyStaticText();
    syncSoundLabel();
    hud.refreshRecordsLine();
    // 结算页的死因三段也是只写一次的，同 syncSoundLabel 一个道理。
    hud.refreshGameOverText();
    if (languageSelect) languageSelect.value = getLocale();
  });
}
