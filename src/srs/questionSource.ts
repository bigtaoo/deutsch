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
//
// 不从词典现查干扰项的释义：那是每张卡三到四次查词、最多四个不同的桶，
// 而 lookup.ts 头部那段专门把桶缓存压到 6 个就是为了不让内存这么涨。

import { normalizeKey } from '@/dict/bucket';
import { buildFormQuestion, buildGlossQuestion, pickQuestionKind } from './choices';
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
