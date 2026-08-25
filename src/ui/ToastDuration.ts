/**
 * 字幕挂多久：按这一句**实际要读多少字**算，不是所有语言共用一个常数。
 *
 * ## 为什么改
 *
 * HudController 里六处调用点各挂一个数（模拟层 message 3.1 秒、昼夜切换 3.4、
 * 拾取 1.4、猎杀 1.8、发车 5、缺省 2.3）。这些数字全是对着**中文**调出来的 ——
 * 中文是这个项目的源语言，其余十一种都是它的译文，而译文比原文长得多：
 *
 *     zh  5102 字    ja  6067    ko  7601    tr 11944    en 12148
 *     vi 12705       ru 13508    pt 13602    es 13612    it 13781
 *     de 13728       fr 14179                        （各 402 个键合计）
 *
 * 法文是中文的 **2.78 倍**。按各语种实际阅读速率折算，3.1 秒里读不完的比例：
 *
 *     en 18.1%   zh 19.9%   de/fr 25.1%   ko 29.1%   ja 31.0%
 *
 * 注意**中文自己也有两成读不完** —— 这不是"给外语补贴"，是 3.1 秒对谁都不够。
 * 字数少 2.8 倍、单字读得慢 2.4 倍，两边基本抵消（跨语言的信息传输率大致恒定），
 * 所以真正的差距只有五个百分点，而 3.1 秒这条线是全体都踩的。
 *
 * 而它正好压在开局那 40 秒上 —— 那段时间每一句都是指令，不是气氛。
 *
 * ## 怎么算
 *
 * **分脚本数**，各按各的速率。一个汉字顶三四个拉丁字符，但也读得更慢，
 * 混在一起按字符数算就会把 CJK 判得过短、把拉丁判得过长。谚文单独一档：
 * 音节块比拉丁密，比汉字疏。
 *
 * 速率取得偏宽松（宁可多挂 0.3 秒，不可切在半句上）—— 字幕早消失是净损失，
 * 晚消失只是占着屏幕一会儿，而屏幕上那块地方本来也没别的用。
 */

/** 每秒读得完多少个字 / 字符。 */
const HAN_PER_SECOND = 7;      // 汉字与假名
const HANGUL_PER_SECOND = 9;   // 谚文音节块
const LATIN_PER_SECOND = 16;   // 拉丁、西里尔、数字、标点、空格

/**
 * 从"这条冒出来了"到"眼睛落上去"的固定开销。
 *
 * 字幕不在视线焦点上（玩家正盯着人物和狗），所以每一条都要先付一次"注意到"的钱，
 * 这笔钱和句子长短无关。没有它的话，两三个字的短句会被算成 0.4 秒。
 */
const NOTICE_SECONDS = 1.2;

/**
 * 阅读时间的上限，**分两档**。
 *
 * 这个上限的职责只有一个：别让一条长文案把后面排队的指令饿死
 * （见 HudController 的 TOAST_STALE_SECONDS —— 排过 6 秒的普通提示直接作废）。
 * 所以它只在**后面确实有东西排队**时才该生效。
 *
 * 一刀切成 6 秒的代价，在开局那一句上尤其贵：`msg.1` 是玩家看到的第一句话，
 * 而它塞了两条指令（「首次移动后开始计时」+「天黑前添柴并封住入口」）。
 * 中文 22 个字装得下，德文要 106 个字符：
 *
 *     de 7.8s  pt 7.1s  es/fr 7.0s  it 6.7s  vi 6.4s  en 6.3s  ru 6.1s   ← 读不完
 *     ja 5.7s  tr 5.6s  ko 5.4s  zh 4.1s                                 ← 读得完
 *
 * **十二种里八种读不完开场那句**，源语言英文自己也读不完。而 msg.1 在 t=0
 * 出现时队列是空的 —— 它谁也没饿着，那 6 秒纯粹是白收的。
 *
 * SOLO 档取 8 秒而不是无限：全部 1224 条（12 语种 × 会走字幕的键）实测
 * 中位 3.8s、p90 5.6s、**最长 8.1s**（fr 的 sim.33），超过 9 秒的一条都没有。
 * 8 秒因此覆盖了除那一条以外的全部文案，同时把「万一将来有人写一段长的」
 * 压在 TOAST_STALE_SECONDS 之上不超过 2 秒 —— 那是队列能吸收的量。
 *
 * 注意这只封"读字换来的时长"，调用点自己传的 nominal 更大时以 nominal 为准。
 */
const MAX_READING_SECONDS = 6;
const SOLO_MAX_READING_SECONDS = 8;

/** 汉字与假名：平/片假名、CJK 统一表意文字（含扩展 A）、兼容表意文字。 */
function isHanOrKana(code: number): boolean {
  return (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff);
}

/** 谚文音节块。 */
function isHangul(code: number): boolean {
  return code >= 0xac00 && code <= 0xd7a3;
}

/** 读完这一句大约要多少秒。不含"注意到"的开销。 */
export function readingSeconds(text: string): number {
  let han = 0;
  let hangul = 0;
  let rest = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isHanOrKana(code)) han += 1;
    else if (isHangul(code)) hangul += 1;
    else rest += 1;
  }
  return han / HAN_PER_SECOND + hangul / HANGUL_PER_SECOND + rest / LATIN_PER_SECOND;
}

/**
 * 这一条字幕该挂多久。
 *
 * `crowded` = 此刻是否还有别的字幕在放或在排队。为真时用 6 秒上限（保护队列），
 * 为假时放宽到 8 秒 —— 独自出现的那一条谁也没饿着，见上面两个常量的注释。
 *
 * `nominal` 是调用点原本那个常数，语义从"挂这么久"变成**"至少挂这么久"** ——
 * 中文短句算出来普遍就在 3 秒附近，所以源语言的观感逐帧不变，
 * 变的是长语言：法文 p90 从被切断变成 5.6 秒读得完。
 */
export function toastSeconds(text: string, nominal: number, crowded = true): number {
  const needed = NOTICE_SECONDS + readingSeconds(text);
  const cap = crowded ? MAX_READING_SECONDS : SOLO_MAX_READING_SECONDS;
  return Math.max(nominal, Math.min(needed, cap));
}
