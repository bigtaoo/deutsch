// FR-10.8 / 10.9 / 10.10：组一道四选一。
//
// 这个文件是**纯的** —— 候选词由调用方取好传进来（和 dict/preset.ts 把 `loadBand`
// 当参数传进来是同一个理由：要测的是组题规则，不是取文件）。
// 规则有六条，每一条都能把这道题悄悄毁掉而界面上看不出来：
//
//   ① 正确项必须**恰好出现一次**。词典里 `Laufen`/`laufen` 归一化同键，
//      干扰项里混进一个只有大小写不同的词，就会出现两个都对的选项。
//   ② 辨形题的干扰项**必须音近**。随机四个不相干的词等于送分（FR-10.10）。
//   ③ 辨义题的干扰项要**同词性**优先。听到一个动词、四个选项里三个是名词释义，
//      靠语法就能排除，考的不再是听力。
//   ④ 释义**要截断**。词典里的德语释义是 Wiktionary 式完整定义
//      （中位 60 字符、p90 126、最长 862），原样塞进 2×2 网格会爆屏。
//   ⑤ 释义里的**词头要遮掉**。`Fernbedienung` 的释义里写着 Fernbedienung，
//      那道题不用听就能做对。而且必须**四个选项一起遮** —— 只遮正确项的话，
//      带「…」的那个就是答案。
//   ⑥ 候选不够时**给三个甚至两个选项，不要崩**。选项少一点只是题变简单，
//      抛异常是整个复习流程停在这张卡上。
//
// ── FR-21：读卡的三种题型 ──
// 听卡的正面只有声音，所以上面六条只管选项。读卡的正面是**文字**（`Question.prompt`），
// 于是多出两条同样能悄悄毁掉一道题的规则：
//
//   ⑦ **题面和选项不能是同一样东西。** `read-gloss` 的题面是词形、选项是释义；
//      `read-form` 反过来。两边都放词形的话，那道题在问「哪个词等于它自己」。
//   ⑧ **`cloze` 的句子里必须遮干净。** 目标词在例句里出现两次是常事
//      （Wiktionary 的例句常复述词头），遮一次等于把答案印在题面上。
//      遮不干净就**不出这道题**，降级到 `read-form` —— 见 maskInSentence。

import { normalizeKey } from '@/dict/bucket';
import { stripDiacritics } from '@/lib/german';
import type { DictPos } from '@/dict/types';
import type { FSRSCard } from '@/types/models';

/**
 * 题型。前两种是**听卡**（FR-10，正面只有声音），后三种是**读卡**（FR-21，正面是文字）。
 *
 * `form`       听音选词形     | `gloss`     听音选释义
 * `read-gloss` 看词形选释义   | `read-form` 看释义选词形   | `cloze` 看挖空句选词
 */
export type QuestionKind = 'form' | 'gloss' | 'read-gloss' | 'read-form' | 'cloze';

/** 读卡那三种（FR-21.4）。 */
export type ReadQuestionKind = Extract<QuestionKind, 'read-gloss' | 'read-form' | 'cloze'>;

/** 选项是词形（短）还是释义（长）—— 界面按这个决定列数（§12.13）。 */
export function choicesAreWords(kind: QuestionKind): boolean {
  return kind === 'form' || kind === 'read-form' || kind === 'cloze';
}

/** 一个候选词。正确项和干扰项用同一个形状 —— 组题时它们只差一个 `correct` 标记。 */
export interface CandidateWord {
  w: string;
  gender?: 'm' | 'f' | 'n';
  pos?: DictPos;
  /** **未截断**的德语释义。截断在这里做（见 shortGloss），因为它属于组题。 */
  gloss?: string;
}

export interface Choice {
  /** 选项的稳定标识：辨形题是词形，辨义题是词形（不是释义 —— 释义可能重复）。 */
  id: string;
  /** 屏幕上显示的文本。 */
  text: string;
  correct: boolean;
}

export interface Question {
  kind: QuestionKind;
  choices: Choice[];
  /**
   * 题面（只有读卡有）。`read-gloss` 是词形，`read-form` 是释义，
   * `cloze` 是挖好空的句子。听卡的题面是声音，所以这里是 undefined ——
   * 而不是空字符串：界面要能区分「这张卡没有题面」和「题面还没取到」。
   */
  prompt?: string;
}

export const MAX_CHOICES = 4;
/** 释义选项的字符上限。超过就截。2×2 网格里一格大约放得下这么多。 */
export const GLOSS_MAX = 80;

/**
 * FR-10.9：题型按卡龄渐进。
 *
 * 新卡 / 学习中 / 重学中（state 0 / 1 / 3）考**辨形**，进入 Review（state 2）
 * 之后才考**辨义**。音都还没认住时问意思，等于一道题同时考两件事 ——
 * 答错了既说不清是没听出来还是没记住意思，FSRS 收到的也是一个混合信号。
 */
export function pickQuestionKind(card: FSRSCard): QuestionKind {
  return card.state === 2 ? 'gloss' : 'form';
}

/**
 * FR-21.4：读卡的题型阶梯，与上面那条同构 —— 先认出来，再想起来。
 *
 * 新卡 / 学习中 / 重学中 → `read-gloss`（看词形选释义）。
 * 进 Review 之后在 `read-form`（看释义选词形）与 `cloze`（看挖空句选词）之间
 * **按 reps 奇偶交替**。
 *
 * 两个「不这么做」值得记：
 *   · **不随机挑。** 一共就两种题，随机会连着出五张同一种。
 *   · **不是「有句子就出 cloze」。** 那样 `read-form` 成了降级项，
 *     而它考的东西（**无语境地**想起词形）本身值得单独练 —— 语境是拐杖。
 *     真正凑不出 cloze 时的降级在 questionSource.ts 里做，不在这里。
 */
export function pickReadKind(card: FSRSCard): ReadQuestionKind {
  if (card.state !== 2) return 'read-gloss';
  return card.reps % 2 === 1 ? 'read-form' : 'cloze';
}

/**
 * 释义截断（FR-10.10）。
 *
 * 三条规则，按顺序试：
 *   1. **分号优先**。Wiktionary 的释义常写成「短说法; 长说法」
 *      （`einer für den andern; in einem kooperativen, wohlwollenden Verhältnis zueinander`）——
 *      分号前那半通常正好是个理想的短释义。
 *   2. 本来就不长（≤ GLOSS_MAX）就原样留着。
 *   3. 否则在词边界上截，补一个省略号。**不在逗号上截** ——
 *      `ein oder mehrere, gegebenenfalls zusammengenähte, Bahnen aus Textil…`
 *      截到第一个逗号只剩「ein oder mehrere」，那不是释义，是废话。
 *
 * 领域标签（`Theater:` / `Biologie:`）**保留**：它是释义的一部分，
 * 而且恰好是最有信息量的那部分。
 */
export function shortGloss(gloss: string, max = GLOSS_MAX): string {
  const s = gloss.replace(/\s+/g, ' ').trim();
  const semi = s.indexOf(';');
  // 分号太靠前（如 `vgl.;`）截出来是碎片，太靠后就没起到截断作用
  if (semi >= 15 && semi <= max + 20) return s.slice(0, semi).trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(' ', max - 1);
  return `${s.slice(0, cut > max * 0.5 ? cut : max - 1).trimEnd()}…`;
}

/**
 * 把释义里的词头遮掉（规则 ⑤）。
 *
 * 按**词干**匹配而不是全词：德语释义里出现的往往是屈折形式
 * （`Fernbedienung` 的释义里就是 `Fernbedienung`，但 `heilen` 的释义里是 `heilt` / `geheilt`）。
 * 词干的取法是剥掉动词/弱变化的词尾 `-en / -e / -n`，剥完还有 4 个字符才算数
 * —— **不按固定长度截**：截 5 个字符时 `heilen` 得到 `heile`，配不上 `heilt`，
 * 而截 4 个字符又会让 `Tor` 这类三四字母的词打掉 `Torte`、`total`。
 * 所以短词（剥完不足 4 个字符）**一律不遮**：漏遮一个词只是那道题偏简单，
 * 误遮会把别的选项也打出「…」，而遮痕本身就是线索。
 */
export function maskHeadword(gloss: string, word: string): string {
  const base = word.replace(/(?:en|e|n)$/u, '');
  const stem = base.length >= 4 ? base : word;
  if (stem.length < 4) return gloss;
  return gloss.replace(new RegExp(`\\p{L}*${escapeRe(stem)}\\p{L}*`, 'giu'), '…');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 选项上显示的文本。**辨形题不带冠词**，只给裸词形。
 *
 * 两个理由，第二个是硬的：
 *   ① 冠词会变成线索。名词的正确项标着 `der`、三个动词干扰项没有冠词的话，
 *      不用听就能排除三个 —— 而干扰项是按**音近**挑的，词性天然是混的。
 *   ② 干扰项的性要现查词典。四个选项 = 四次查词 = 最多四个 105KB 的桶，
 *      每张卡都这样，一次会话能摸到上百个桶（lookup.ts 头部那段正是为此把桶缓存
 *      压到 6 个）。而性并没有因此丢掉：它在答对时那 600ms 的确认里给（FR-10.11），
 *      答错时在卡背上给。
 */
function label(c: CandidateWord): string {
  return c.w;
}

/**
 * 组一道辨形题：正确项 + 音近干扰项，全部显示为词形。
 *
 * `pool` 按调用方给的顺序消费（那是 IPA 近邻按距离排好的顺序），
 * 不在这里重排 —— 「谁最像」是词典层的判断，不是组题层的。
 */
export function buildFormQuestion(
  correct: CandidateWord,
  pool: readonly CandidateWord[],
  shuffle: Shuffle = defaultShuffle,
): Question {
  return { kind: 'form', choices: shuffle(wordChoices(correct, pool)) };
}

/** 四个词形当选项。`form` / `read-form` / `cloze` 三种题共用 —— 差别只在题面。 */
function wordChoices(correct: CandidateWord, pool: readonly CandidateWord[]): Choice[] {
  const taken = new Set([normalizeKey(correct.w)]);
  const choices: Choice[] = [{ id: correct.w, text: label(correct), correct: true }];
  for (const c of pool) {
    if (choices.length >= MAX_CHOICES) break;
    const key = normalizeKey(c.w);
    if (taken.has(key)) continue; // 规则 ①：大小写不同的同一个词不能当干扰项
    taken.add(key);
    choices.push({ id: c.w, text: label(c), correct: false });
  }
  return choices;
}

/**
 * FR-21.4 `read-form`：**题面是释义，选项是词形** —— 听卡辨形题的镜像。
 *
 * 题面那份释义与 `read-gloss` 的正确项用的是同一个函数（截断 + 遮词头）：
 * 遮词头在这里同样不能省，虽然理由反过来 —— 那边是「释义里写着答案」，
 * 这边是「题面里写着答案」，同一句话两种毁法。
 */
export function buildReadFormQuestion(
  correct: CandidateWord,
  pool: readonly CandidateWord[],
  shuffle: Shuffle = defaultShuffle,
): Question {
  return {
    kind: 'read-form',
    prompt: glossText(correct),
    choices: shuffle(wordChoices(correct, pool)),
  };
}

/** cloze 的空位。**宽度固定**（FR-21.8）：跟着词长走等于把词长泄给四个选项。 */
export const CLOZE_BLANK = '_____';

/**
 * FR-21.8：把句子里的目标词遮成一个定宽的空。遮不干净就返回 `null`。
 *
 * 三条，每一条都是「这道题白送」或「这道题做不了」之一：
 *   ① **同一句里所有的出现都要遮。** Wiktionary 的例句常复述词头
 *      （`Der Vorhang fiel. Ein Vorhang aus Samt.`），遮一次剩一次就是答案。
 *   ② **长词按词干遮**（与 maskHeadword 同一套：剥掉 `-en/-e/-n`，剩 ≥4 字符），
 *      因为句子里出现的往往是屈折形式（`heilte`）；比较前还要**折掉变音符**，
 *      否则 `Vorhang` 在 `Vorhänge` 上遮不掉 —— 而德语名词的复数带变音是常态，
 *      漏遮一个就是把答案印在题面上。短词（剥完不足 4 个字符）退回**整词匹配**：
 *      词干包含匹配会让 `Tor` 把 `Torte`、`total` 一起挖掉。
 *   ③ **多词搭配不出这道题。** `hing … ab` 在句子里是分开的两处，
 *      遮成两个空的话题面在问「哪两个词」，而选项只有一个位置。
 *      返回 null 让调用方降级到 `read-form`，比硬出一道歧义题好。
 *
 * 一处都没遮到也返回 null：那说明这条例句根本不含这个词（词典里有这种脏数据），
 * 出出来就是一道无解的题。
 */
export function maskInSentence(sentence: string, word: string): string | null {
  const w = word.trim();
  if (!w || /\s/u.test(w)) return null; // ③ 多词搭配
  const base = w.replace(/(?:en|e|n)$/u, '');
  const useStem = base.length >= 4;
  const target = fold(useStem ? base : w);

  let hit = false;
  // 逐词扫描而不是一条正则打天下：要比的是**折叠变音之后**的形状，
  // 那件事正则做不了。顺便也绕开了 lookbehind（Safari 16.4 之前不支持，
  // 而这里跑在 WKWebView 上）。
  const masked = sentence.replace(/\p{L}+/gu, (token) => {
    const t = fold(token);
    if (useStem ? !t.includes(target) : t !== target) return token;
    hit = true;
    return CLOZE_BLANK;
  });
  return hit ? masked : null;
}

/** 比较用的形状：折掉变音符再小写。`Vorhänge` 与 `Vorhang` 要认成同一个词。 */
function fold(text: string): string {
  return stripDiacritics(text).toLowerCase();
}

/**
 * FR-21.4 `cloze`：题面是挖好空的句子，选项是词形。
 *
 * 句子由调用方挖好传进来（`maskInSentence` 的结果），**不在这里挖** ——
 * 挖不动是要降级到别的题型的，而这个函数已经没法回头了。
 */
export function buildClozeQuestion(
  correct: CandidateWord,
  pool: readonly CandidateWord[],
  maskedSentence: string,
  shuffle: Shuffle = defaultShuffle,
): Question {
  return { kind: 'cloze', prompt: maskedSentence, choices: shuffle(wordChoices(correct, pool)) };
}

/**
 * 组一道辨义题：正确项的释义 + 同词性优先的干扰释义。
 *
 * 没有释义的候选直接跳过（不是建一个空选项）。正确项自己没有释义时
 * 由调用方退回辨形题 —— 这个函数不做那个降级，因为它拿不到辨形题需要的音近词。
 */
export function buildGlossQuestion(
  correct: CandidateWord,
  pool: readonly CandidateWord[],
  shuffle: Shuffle = defaultShuffle,
): Question {
  return { kind: 'gloss', choices: shuffle(glossChoices(correct, pool)) };
}

/**
 * FR-21.4 `read-gloss`：**题面是词形，选项是释义**。读卡的第一关。
 *
 * 题面给裸词形、不带冠词，理由与选项标签那条（见 label）第一点相同：
 * 冠词在这里会顺手把性教掉，而性该在答对的那 600ms 和卡背上给（FR-10.11）——
 * 题面里带着它，`read-form` 的反向题就再也考不到它了。
 */
export function buildReadGlossQuestion(
  correct: CandidateWord,
  pool: readonly CandidateWord[],
  shuffle: Shuffle = defaultShuffle,
): Question {
  return { kind: 'read-gloss', prompt: correct.w, choices: shuffle(glossChoices(correct, pool)) };
}

/** 一条释义的显示文本：遮掉词头（规则 ⑤）再截断（规则 ④）。 */
function glossText(c: CandidateWord): string {
  return shortGloss(maskHeadword(c.gloss ?? '', c.w));
}

/** 四条释义当选项。`gloss` 与 `read-gloss` 共用。 */
function glossChoices(correct: CandidateWord, pool: readonly CandidateWord[]): Choice[] {
  const gloss = glossText;
  const correctText = gloss(correct);
  const takenWords = new Set([normalizeKey(correct.w)]);
  const takenTexts = new Set([correctText]);
  const choices: Choice[] = [{ id: correct.w, text: correctText, correct: true }];

  // 规则 ③：同词性的先来。稳定排序 —— 同词性内部保持调用方给的顺序。
  const sorted = [...pool].sort(
    (a, b) => Number(b.pos === correct.pos) - Number(a.pos === correct.pos),
  );
  for (const c of sorted) {
    if (choices.length >= MAX_CHOICES) break;
    if (!c.gloss) continue;
    const key = normalizeKey(c.w);
    if (takenWords.has(key)) continue;
    const text = gloss(c);
    // 释义撞车（同义词、或都被遮成「…」）会造出两个都对的选项
    if (!text || takenTexts.has(text)) continue;
    takenWords.add(key);
    takenTexts.add(text);
    choices.push({ id: c.w, text, correct: false });
  }
  return choices;
}

export type Shuffle = (choices: Choice[]) => Choice[];

/**
 * Fisher–Yates。**注入而不是内建**，是为了让单测能断言「正确项恰好一个」
 * 这类性质而不受随机顺序干扰 —— 组题的正确性与顺序无关，
 * 但顺序的正确性（正确项不能总在第一个）要单独测。
 */
export const defaultShuffle: Shuffle = (choices) => {
  const out = [...choices];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
