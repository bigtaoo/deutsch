// FR-1.4 / FR-2.3：句子列表的结构编辑 —— 合并、拆分、排除。
//
// 关于 `Sentence.index` 的一个实现期决策（原规格 FR-1.4 只写了「被排除的句子不参与索引编号」）：
// index 一律是**数组下标**，排除不重排号。理由是 `VocabEntry.sentenceIndex` 与
// `GlossaryCandidate.sentenceIndex` 都指向它 —— 如果排除也重排，那么勾一下「非朗读内容」
// 就会让后面所有生词的出处静默错位。UI 上的连续编号由 displayNumbers() 单独算，
// 排除句在编号里被跳过，用户看到的效果和规格一致，但引用不动。
//
// 合并/拆分确实会重排 index（FR-2.3 明说要重排），所以这两个函数额外返回 indexMap，
// 调用方必须拿它去同步 VocabEntry.sentenceIndex，否则同样会错位。

import type { Blank, Sentence, WordSpan } from '@/types/models';
import type { RawSegment } from './segment';

export interface SentenceEdit {
  sentences: Sentence[];
  /** 旧 index → 新 index。拆分时旧句映射到左半句。 */
  indexMap: Map<number, number>;
}

export function createSentences(segments: RawSegment[]): Sentence[] {
  return segments.map((seg, index) => ({
    index,
    text: seg.text,
    charStart: seg.charStart,
    charEnd: seg.charEnd,
    endTimeExplicit: false,
    blanks: [],
    markedDifficult: false,
    excluded: false,
  }));
}

/** index 一律等于数组下标。任何结构编辑之后都要过一遍这个函数。 */
export function reindex(sentences: Sentence[]): Sentence[] {
  return sentences.map((s, index) => (s.index === index ? s : { ...s, index }));
}

/** UI 编号：排除句不占号，返回 index → 显示序号（从 1 开始）；排除句不在 map 里。 */
export function displayNumbers(sentences: Sentence[]): Map<number, number> {
  const numbers = new Map<number, number>();
  let n = 0;
  for (const s of sentences) {
    if (s.excluded) continue;
    numbers.set(s.index, ++n);
  }
  return numbers;
}

function shiftBlanks(blanks: Blank[], delta: number): Blank[] {
  if (delta === 0) return blanks;
  return blanks.map((b) => ({
    ...b,
    ranges: b.ranges.map((r) => ({ start: r.start + delta, end: r.end + delta })),
  }));
}

/**
 * 词级时间戳（`Sentence.words`）跟 `blanks` 是同一套句内 offset，所以合并/拆分时
 * 要做同样的事：平移、按切点分家。**不能只让它作废**（合并一下就没有逐词高亮了），
 * 也不能原样留着（offset 会指向别的词，那是静默错位）。
 */
function shiftWords(words: WordSpan[] | undefined, delta: number): WordSpan[] | undefined {
  if (!words || delta === 0) return words;
  return words.map((w) => ({ ...w, charStart: w.charStart + delta, charEnd: w.charEnd + delta }));
}

/** 两段词表接起来；两边都空就返回 undefined（而不是空数组 —— 那会让 UI 以为「算过、但没有词」）。 */
function concatWords(
  left: WordSpan[] | undefined,
  right: WordSpan[] | undefined,
): WordSpan[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length > 0 ? merged : undefined;
}

/**
 * FR-2.3：与下一句合并。文本从 plainText 原样切出来，
 * 这样两句之间的空格/换行按原文保留，charStart/charEnd 也仍然对得上原文。
 */
export function mergeWithNext(
  sentences: Sentence[],
  index: number,
  plainText: string,
): SentenceEdit {
  const first = sentences[index];
  const second = sentences[index + 1];
  if (!first || !second) return { sentences, indexMap: identityMap(sentences) };

  const merged: Sentence = {
    ...first,
    text: plainText.slice(first.charStart, second.charEnd),
    charEnd: second.charEnd,
    // 时间戳跟随：起点用先出现的那个，终点用后出现的那个。
    startTime: first.startTime ?? second.startTime,
    endTime: second.endTime ?? first.endTime,
    endTimeExplicit: second.endTime !== undefined ? second.endTimeExplicit : first.endTimeExplicit,
    blanks: [...first.blanks, ...shiftBlanks(second.blanks, second.charStart - first.charStart)],
    words: concatWords(first.words, shiftWords(second.words, second.charStart - first.charStart)),
    markedDifficult: first.markedDifficult || second.markedDifficult,
    // 只有两句都被排除，合并后才还是排除 —— 否则会把正文悄悄吞掉。
    excluded: first.excluded && second.excluded,
  };

  const next = [...sentences.slice(0, index), merged, ...sentences.slice(index + 2)];
  const indexMap = new Map<number, number>();
  for (const s of sentences) {
    indexMap.set(s.index, s.index <= index ? s.index : s.index - 1);
  }
  return { sentences: reindex(next), indexMap };
}

export interface SplitResult extends SentenceEdit {
  /** 跨越切点的挖空无处安放，只能丢弃；返回出来让 UI 说清楚丢了什么。 */
  droppedBlanks: Blank[];
}

/**
 * FR-2.3：在句内 offset 处拆分。offset 是相对该句 text 起点的位置。
 * 左半句保留 startTime（起点没变），右半句的起点未知需重新标注；
 * 原句的 endTime 归右半句 —— 它才是真正结束在那个时间点的部分。
 */
export function splitSentence(
  sentences: Sentence[],
  index: number,
  offsetInSentence: number,
  plainText: string,
): SplitResult {
  const target = sentences[index];
  const identity = { sentences, indexMap: identityMap(sentences), droppedBlanks: [] };
  if (!target) return identity;

  const leftRaw = target.text.slice(0, offsetInSentence);
  const rightRaw = target.text.slice(offsetInSentence);
  if (leftRaw.trim().length === 0 || rightRaw.trim().length === 0) return identity;

  const leftStart = target.charStart;
  const leftEnd = target.charStart + leftRaw.trimEnd().length;
  const rightStart = target.charStart + offsetInSentence + (rightRaw.length - rightRaw.trimStart().length);
  const rightEnd = target.charEnd;

  const droppedBlanks: Blank[] = [];
  const leftBlanks: Blank[] = [];
  const rightBlanks: Blank[] = [];
  const cut = leftEnd - leftStart;
  const rightOffset = rightStart - leftStart;
  for (const blank of target.blanks) {
    if (blank.ranges.every((r) => r.end <= cut)) leftBlanks.push(blank);
    else if (blank.ranges.every((r) => r.start >= rightOffset)) rightBlanks.push(...shiftBlanks([blank], -rightOffset));
    else droppedBlanks.push(blank);
  }

  // 词级时间戳按同一个切点分家。横跨切点的（光标落在词中间）两边都不要 ——
  // 它的 offset 在任何一边都指不回同一个词。这种词最多一个，不值得报给用户。
  const leftWords = target.words?.filter((w) => w.charEnd <= cut);
  const rightWords = shiftWords(
    target.words?.filter((w) => w.charStart >= rightOffset),
    -rightOffset,
  );

  const left: Sentence = {
    ...target,
    text: plainText.slice(leftStart, leftEnd),
    charStart: leftStart,
    charEnd: leftEnd,
    endTime: undefined,
    endTimeExplicit: false,
    blanks: leftBlanks,
    words: leftWords?.length ? leftWords : undefined,
  };
  const right: Sentence = {
    ...target,
    text: plainText.slice(rightStart, rightEnd),
    charStart: rightStart,
    charEnd: rightEnd,
    startTime: undefined,
    blanks: rightBlanks,
    words: rightWords?.length ? rightWords : undefined,
  };

  const next = [...sentences.slice(0, index), left, right, ...sentences.slice(index + 1)];
  const indexMap = new Map<number, number>();
  for (const s of sentences) {
    indexMap.set(s.index, s.index <= index ? s.index : s.index + 1);
  }
  return { sentences: reindex(next), indexMap, droppedBlanks };
}

export function setExcluded(sentences: Sentence[], index: number, excluded: boolean): Sentence[] {
  return sentences.map((s) => (s.index === index ? { ...s, excluded } : s));
}

/** FR-1.4：「批量排除文末 N 句」—— 手动粘贴 PDF 时对付末尾的 Glossar。 */
export function excludeLastN(sentences: Sentence[], n: number): Sentence[] {
  const from = Math.max(0, sentences.length - n);
  return sentences.map((s, i) => (i >= from ? { ...s, excluded: true } : s));
}

/**
 * FR-1.4：开头 N 句批量排除 / **取消排除**。
 *
 * 为什么需要「取消排除」这一半：FR-13.7 原来会自动排除开头的标题+导语块，
 * 而那条规则是错的（DW 的播音员照着念）。规则已经去掉，但**在它去掉之前导入的课**
 * 里那几句仍然是 excluded。没有这个控件就只能逐句点开、逐句取消 ——
 * 一课三次，回填过的十来课就是几十次。
 */
export function setExcludedFirstN(sentences: Sentence[], n: number, excluded: boolean): Sentence[] {
  const to = Math.min(sentences.length, Math.max(0, n));
  return sentences.map((s, i) => (i < to ? { ...s, excluded } : s));
}

function identityMap(sentences: Sentence[]): Map<number, number> {
  return new Map(sentences.map((s) => [s.index, s.index]));
}
