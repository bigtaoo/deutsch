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

import { normalizeKey } from '@/dict/bucket';
import type { DictPos } from '@/dict/types';
import type { FSRSCard } from '@/types/models';

/** 题型。`form` 听音选词形，`gloss` 听音选释义。 */
export type QuestionKind = 'form' | 'gloss';

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

/** 名词加冠词显示 —— 辨形题的选项上也要给性（那是唯一还看得到性的地方之一）。 */
function label(c: CandidateWord): string {
  return c.gender ? `${{ m: 'der', f: 'die', n: 'das' }[c.gender]} ${c.w}` : c.w;
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
  const taken = new Set([normalizeKey(correct.w)]);
  const choices: Choice[] = [{ id: correct.w, text: label(correct), correct: true }];
  for (const c of pool) {
    if (choices.length >= MAX_CHOICES) break;
    const key = normalizeKey(c.w);
    if (taken.has(key)) continue; // 规则 ①：大小写不同的同一个词不能当干扰项
    taken.add(key);
    choices.push({ id: c.w, text: label(c), correct: false });
  }
  return { kind: 'form', choices: shuffle(choices) };
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
  const gloss = (c: CandidateWord) => shortGloss(maskHeadword(c.gloss ?? '', c.w));
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
  return { kind: 'gloss', choices: shuffle(choices) };
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
