// 给一张卡组题时，**候选词从哪来**（FR-10.10）。
//
// choices.ts 是纯的、只管规则；这一层负责把候选取到手。分开是因为取候选这件事
// 有三个便宜/贵差得很远的来源，而选错来源不会报错，只会让每张卡多摸几个 105KB 的桶：
//
//   ① **辨形题的干扰项**：牌组文件里预存好的 IPA 近邻（FR-16.8）。
//      牌组是 `loadDeck` 缓存过的，所以第二张卡起零成本。
//   ② **辨义题的干扰项**：**用户自己生词本里别的词**的释义。零请求 ——
//      释义在建卡时就拷进 VocabEntry 了。而且这些词他也在学，干扰强度正好。
//   ③ 课程卡（不是预置卡）没有牌组可查，干扰项退到生词本里别的词的词形。
//   ④ **读卡（FR-21）的 `read-form` / `cloze` 干扰项**：牌组里**词频名次相邻**的词，
//      或生词本里同词性的词。**不能用 ① 那份 IPA 近邻** —— 那是给辨音题造的，
//      `heulen` 填进 `teilen` 的空里一眼就假，那道题不用读懂句子就能做对。
//
// 不从词典现查干扰项的释义：那是每张卡三到四次查词、最多四个不同的桶，
// 而 lookup.ts 头部那段专门把桶缓存压到 6 个就是为了不让内存这么涨。

import { normalizeKey } from '@/dict/bucket';
import {
  buildClozeQuestion,
  buildFormQuestion,
  buildGlossQuestion,
  buildReadFormQuestion,
  buildReadGlossQuestion,
  maskInSentence,
  pickQuestionKind,
  pickReadKind,
} from './choices';
import type { CandidateWord, Question, Shuffle } from './choices';
import type { DictDeck } from '@/dict/types';
import type { VocabEntry } from '@/types/models';

/** 组一道题至少要三个干扰项才有意思；不够就换题型（见 buildQuestion）。 */
const MIN_DISTRACTORS = 3;
/** 交给 choices.ts 的候选上限。它自己会按规则筛，这里只是别把整本生词本传进去。 */
const POOL_SIZE = 16;

function toCandidate(entry: VocabEntry): CandidateWord {
  return {
    w: entry.surface,
    gender: entry.gender,
    // VocabEntry 上没有词性字段。**有性就当名词**是个够用的近似：
    // 辨义题只用它做「同词性优先」的排序，猜错了顶多是干扰项挑得不够好，
    // 不会出现错的选项。为此单独加一个字段要动数据模型和备份格式，不值得。
    pos: entry.gender ? 'noun' : undefined,
    gloss: entry.meaning,
  };
}

function sample<T>(items: readonly T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  }
  return out;
}

/** 生词本里除自己以外、有释义的词 —— 辨义题的干扰项来源。 */
export function glossPool(entry: VocabEntry, all: readonly VocabEntry[]): CandidateWord[] {
  const others = all.filter((e) => e.id !== entry.id && e.meaning && e.surface);
  return sample(others, POOL_SIZE).map(toCandidate);
}

/**
 * 辨形题的干扰项：先用牌组里预存的 IPA 近邻，不够再拿同档随机词补。
 *
 * 补齐这一步是必要的：实测 19% 的词凑不到三个近邻（FR-16.8）。
 * 随机补出来的那几个不音近，但**位置在近邻后面** —— choices.ts 按顺序消费，
 * 所以真正音近的那些一定会先进选项。
 */
export async function formPool(
  entry: VocabEntry,
  all: readonly VocabEntry[],
  loadDeck: (band: number) => Promise<DictDeck | null>,
): Promise<CandidateWord[]> {
  const key = normalizeKey(entry.lemma ?? entry.surface);
  const deck = entry.preset ? await loadDeck(entry.preset.band) : null;
  if (deck) {
    const me = deck.words.find((x) => normalizeKey(x.w) === key);
    const near = (me?.d ?? []).map((w) => ({ w }));
    if (near.length >= MIN_DISTRACTORS) return near;
    const taken = new Set([key, ...near.map((c) => normalizeKey(c.w))]);
    const filler = sample(
      deck.words.filter((x) => !taken.has(normalizeKey(x.w))),
      POOL_SIZE,
    ).map((x) => ({ w: x.w }));
    return [...near, ...filler];
  }
  // 课程卡：没有牌组。用生词本里别的词的词形 —— 至少它们都是真词。
  return sample(
    all.filter((e) => e.id !== entry.id && normalizeKey(e.lemma ?? e.surface) !== key),
    POOL_SIZE,
  ).map(toCandidate);
}

/**
 * 给一张卡组一道题。
 *
 * **辨义题会退回辨形题**，有两种情况：卡自己没有释义（词典没查到、或者用户清空了），
 * 或者生词本里凑不出三个有释义的别的词（刚开始用的时候）。
 * 反过来不做降级：辨形题的候选总能补齐（同档随机词兜底），凑不出选项的只有
 * 「生词本里就这一张卡」那种情形，那时给一个单选项也照样能过 —— 见 choices.ts 规则 ⑥。
 */
export async function buildQuestion(
  entry: VocabEntry,
  all: readonly VocabEntry[],
  loadDeck: (band: number) => Promise<DictDeck | null>,
  shuffle?: Shuffle,
): Promise<Question> {
  if (pickQuestionKind(entry.fsrs) === 'gloss' && entry.meaning) {
    const pool = glossPool(entry, all);
    if (pool.filter((c) => c.gloss).length >= MIN_DISTRACTORS) {
      return buildGlossQuestion(toCandidate(entry), pool, shuffle);
    }
  }
  return buildFormQuestion(toCandidate(entry), await formPool(entry, all, loadDeck), shuffle);
}

/**
 * FR-21.7：`read-form` / `cloze` 的干扰项。
 *
 * **预置卡**取牌组里**词频名次相邻**的词：名次相邻意味着这些词一样常见，
 * 于是「这个词我没见过、所以不是答案」那条排除法用不上。在最近的一批里再随机抽，
 * 而不是直接取最近的四个 —— 否则同一张卡每次出题的选项一模一样，
 * 几轮之后记住的是选项的位置，不是词。
 *
 * **课程卡 / 查词卡**没有名次，退到生词本里**同词性**的词（`gender` 有无当名词的近似，
 * 与 toCandidate 同一个妥协）。同词性不够三个就放开 —— 见 choices.ts 规则 ⑥。
 *
 * 与 formPool 的区别就是这一条：那边要**音近**，这边要**语义上讲得通**。
 */
const NEAR_RANK_WINDOW = 40;

export async function wordPool(
  entry: VocabEntry,
  all: readonly VocabEntry[],
  loadDeck: (band: number) => Promise<DictDeck | null>,
): Promise<CandidateWord[]> {
  const key = normalizeKey(entry.lemma ?? entry.surface);
  const deck = entry.preset ? await loadDeck(entry.preset.band) : null;
  if (deck && entry.preset) {
    const myRank = entry.preset.rank;
    const near = deck.words
      .filter((x) => normalizeKey(x.w) !== key)
      .sort((a, b) => Math.abs(a.r - myRank) - Math.abs(b.r - myRank))
      .slice(0, NEAR_RANK_WINDOW);
    return sample(near, POOL_SIZE).map((x) => ({ w: x.w }));
  }
  const others = all.filter(
    (e) => e.id !== entry.id && normalizeKey(e.lemma ?? e.surface) !== key,
  );
  const isNoun = Boolean(entry.gender);
  const samePos = others.filter((e) => Boolean(e.gender) === isNoun);
  return sample(samePos.length >= MIN_DISTRACTORS ? samePos : others, POOL_SIZE).map(toCandidate);
}

/**
 * FR-21.6：挑一条能出 cloze 的句子，挖好空。挖不动就返回 null。
 *
 * 句子从 `entry.examples` 来 —— 开读卡时就拷进卡里了，这里**不查词典**：
 * 复习过的卡不能变（§2.3），而词典是可重建的缓存层。
 *
 * 先拿 `surface` 试再拿 `lemma` 试：课程卡的原句里出现的正是 surface
 * （它就是从那句里选出来的），而词典例句里出现的往往是词头的屈折形式，
 * 那一种由 maskInSentence 的词干匹配去接。
 */
export function pickCloze(entry: VocabEntry): string | null {
  for (const sentence of entry.examples ?? []) {
    for (const word of [entry.surface, entry.lemma].filter(Boolean) as string[]) {
      const masked = maskInSentence(sentence, word);
      if (masked) return masked;
    }
  }
  return null;
}

/**
 * 给一张**读卡**组一道题（FR-21.4）。
 *
 * 题型由卡龄决定，但每一种都有降级出口 —— 组不出来时换一种，绝不抛异常
 * （choices.ts 规则 ⑥）。降级链是**往回退**的：
 *
 *   cloze（没有可挖的句子）→ read-form（凑不到词形干扰项）→ read-gloss
 *   read-form（凑不到）→ read-gloss
 *   read-gloss（凑不到有释义的干扰项）→ read-form
 *
 * `read-gloss` 是最后的兜底：它只要求这张卡自己有释义，而那是开读卡的门槛
 * （FR-21.2 第 ② 条），所以一定过得去。真到了「生词本里就这一张卡」的地步，
 * 它会给一个只有正确项的题 —— 题变简单，但流程不会停在这张卡上。
 */
export async function buildReadQuestion(
  entry: VocabEntry,
  all: readonly VocabEntry[],
  loadDeck: (band: number) => Promise<DictDeck | null>,
  shuffle?: Shuffle,
): Promise<Question> {
  const me = toCandidate(entry);
  const kind = entry.fsrsRead ? pickReadKind(entry.fsrsRead) : 'read-gloss';

  const words = kind === 'read-gloss' ? [] : await wordPool(entry, all, loadDeck);

  if (kind === 'cloze') {
    const masked = pickCloze(entry);
    if (masked && words.length >= MIN_DISTRACTORS) {
      return buildClozeQuestion(me, words, masked, shuffle);
    }
  }
  if (kind !== 'read-gloss' && words.length >= MIN_DISTRACTORS) {
    return buildReadFormQuestion(me, words, shuffle);
  }

  const glosses = glossPool(entry, all);
  if (glosses.filter((c) => c.gloss).length >= MIN_DISTRACTORS) {
    return buildReadGlossQuestion(me, glosses, shuffle);
  }
  // read-gloss 也凑不出干扰项：词形那条路要求低得多（干扰项不需要有释义）
  const fallback = kind === 'read-gloss' ? await wordPool(entry, all, loadDeck) : words;
  if (fallback.length >= MIN_DISTRACTORS) return buildReadFormQuestion(me, fallback, shuffle);
  return buildReadGlossQuestion(me, glosses, shuffle);
}
