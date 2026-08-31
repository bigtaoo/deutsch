// 把 Sentence[] 摊平成对齐目标，以及把对齐结果折回句级/词级时间戳。
//
// 两条硬规则：
//
// 1. **只喂非排除句**。FR-1.4 排除掉的是标题、栏目说明、文末 Glossar —— 音频里根本没有。
//    把它们喂进去，对齐器就必须在音频某处给它们找位置，找不到就会把相邻真实句子的
//    边界一起拽歪。排除句在结果里没有时间戳，这是对的。
//
// 2. **charOffset 是句内 UTF-16 offset**，和 Sentence.text 的下标同一套坐标，
//    因此也和 Blank.ranges 同一套（见 models.ts）。这样词级时间戳能直接和挖空对上。

import type { Sentence } from '@/types/models';
import { FRAME_SECONDS, romanizeSentence } from './vocab';
import type { TokenSpan } from './viterbi';

export interface AlignTarget {
  ids: Int32Array;
  /** 每个 token 属于哪句（Sentence.index，不是数组下标） */
  sentenceIndex: Int32Array;
  charOffset: Int32Array;
  wordIndex: Int32Array;
  /** 参与对齐的句子（Sentence.index），按文本顺序 */
  covered: number[];
}

export function buildTarget(sentences: Sentence[]): AlignTarget {
  const ids: number[] = [];
  const sentenceIndex: number[] = [];
  const charOffset: number[] = [];
  const wordIndex: number[] = [];
  const covered: number[] = [];

  for (const sentence of sentences) {
    if (sentence.excluded) continue;
    const tokens = romanizeSentence(sentence.text);
    // 罗马化后什么都不剩的句子（纯标点、纯数字）拿不到时间戳。
    // 硬塞进去只会污染邻句边界。
    if (tokens.length === 0) continue;
    covered.push(sentence.index);
    for (const t of tokens) {
      ids.push(t.id);
      sentenceIndex.push(sentence.index);
      charOffset.push(t.charOffset);
      wordIndex.push(t.wordIndex);
    }
  }

  return {
    ids: Int32Array.from(ids),
    sentenceIndex: Int32Array.from(sentenceIndex),
    charOffset: Int32Array.from(charOffset),
    wordIndex: Int32Array.from(wordIndex),
    covered,
  };
}

export interface SentenceTiming {
  index: number;
  start: number;
  end: number;
  /** 该句所有 token 的平均 log-prob。越接近 0 越可信；低于阈值的要人工校对 */
  confidence: number;
}

export interface WordTiming {
  sentenceIndex: number;
  /** 句内词号 */
  wordIndex: number;
  /** 句内 offset，右开 —— 与 Blank.ranges 同坐标 */
  charStart: number;
  charEnd: number;
  start: number;
  end: number;
}

export interface Timings {
  sentences: SentenceTiming[];
  words: WordTiming[];
}

/**
 * spans 必须与 target.ids 一一对应、同序。
 *
 * 句/词的边界取「其首个 token 的起帧」到「其末个 token 的止帧」。
 * 不去吞掉词间和句间的静音：宁可播放时略掉一点前导静音，
 * 也不要让上一句的尾音混进下一句 —— 后者在跟读时是直接听错。
 */
export function toTimings(target: AlignTarget, spans: TokenSpan[]): Timings {
  if (spans.length !== target.ids.length) {
    throw new Error(`span 数 (${spans.length}) 与目标 token 数 (${target.ids.length}) 不一致`);
  }

  const sentences: SentenceTiming[] = [];
  const words: WordTiming[] = [];
  let sentenceCursor: { t: SentenceTiming; scoreSum: number; count: number } | null = null;
  let wordCursor: WordTiming | null = null;

  const flushSentence = () => {
    if (!sentenceCursor) return;
    sentenceCursor.t.confidence = sentenceCursor.scoreSum / sentenceCursor.count;
    sentences.push(sentenceCursor.t);
    sentenceCursor = null;
  };
  const flushWord = () => {
    if (wordCursor) words.push(wordCursor);
    wordCursor = null;
  };

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const si = target.sentenceIndex[i];
    const wi = target.wordIndex[i];
    const start = span.startFrame * FRAME_SECONDS;
    const end = span.endFrame * FRAME_SECONDS;
    const off = target.charOffset[i];

    if (!sentenceCursor || sentenceCursor.t.index !== si) {
      flushWord();
      flushSentence();
      sentenceCursor = {
        t: { index: si, start, end, confidence: 0 },
        scoreSum: 0,
        count: 0,
      };
    }
    sentenceCursor.t.end = end;
    sentenceCursor.scoreSum += span.score;
    sentenceCursor.count++;

    if (!wordCursor || wordCursor.sentenceIndex !== si || wordCursor.wordIndex !== wi) {
      flushWord();
      wordCursor = { sentenceIndex: si, wordIndex: wi, charStart: off, charEnd: off + 1, start, end };
    }
    // charEnd 右开：token 由第 off 个字符产生，所以词覆盖到 off+1。
    // ß→ss 会让两个 token 共享同一个 off，取 max 而不是累加。
    wordCursor.charEnd = Math.max(wordCursor.charEnd, off + 1);
    wordCursor.end = end;
  }
  flushWord();
  flushSentence();
  return { sentences, words };
}
