// 这道缝的验收：**只拿一个 EmissionMatrix，不碰模型，就能算出全套时间戳。**
//
// 测的不是 viterbi 对不对（那是 viterbi.test.ts / target.test.ts 的事），
// 而是「矩阵是一个自足的中间产物」这条契约本身 —— 它成立，emissions 那一半才能换地方跑
// （原生插件、远端）。所以这里刻意**不** import emissions.ts，只喂一个手工造的矩阵。

import { describe, expect, it } from 'vitest';
import { alignEmissions } from './align';
import { emissionTransferables, type EmissionMatrix } from './emissionMatrix';
import { MMS_FA } from './config';
import { buildTarget } from './target';
import { FRAME_SECONDS } from './vocab';
import type { Sentence } from '@/types/models';

function sentence(index: number, text: string, charStart: number): Sentence {
  return {
    index,
    text,
    charStart,
    charEnd: charStart + text.length,
    endTimeExplicit: false,
    blanks: [],
    markedDifficult: false,
    excluded: false,
  };
}

/**
 * 造一个「每个 token 各占 framesPerToken 帧、且确定无疑」的矩阵。
 *
 * 相邻同字之间必须留一帧 blank（CTC 的第 3 条转移限制，见 viterbi.ts），
 * 所以每个 token 后面都跟一帧 blank —— 这样任何输入文本都有合法路径。
 */
function certainMatrix(sentences: Sentence[], framesPerToken: number): EmissionMatrix {
  const { vocabSize, blankId } = MMS_FA;
  const ids = buildTarget(sentences).ids;
  const frames = ids.length * (framesPerToken + 1);
  const logProbs = new Float32Array(frames * vocabSize).fill(Math.log(0.001));
  for (let i = 0; i < ids.length; i++) {
    const base = i * (framesPerToken + 1);
    for (let f = 0; f < framesPerToken; f++) {
      logProbs[(base + f) * vocabSize + ids[i]] = Math.log(0.9);
    }
    logProbs[(base + framesPerToken) * vocabSize + blankId] = Math.log(0.9);
  }
  return {
    logProbs,
    frames,
    vocabSize,
    duration: frames * FRAME_SECONDS,
    source: { kind: 'remote', origin: 'test' },
  };
}

describe('alignEmissions', () => {
  const sentences = [sentence(0, 'Hallo Welt', 0), sentence(1, 'Guten Tag', 11)];

  it('只靠矩阵就能算出句级与词级时间戳 —— 不需要模型', () => {
    const outcome = alignEmissions(certainMatrix(sentences, 4), sentences);

    expect(outcome.sentences.map((s) => s.index)).toEqual([0, 1]);
    expect(outcome.covered).toBe(2);
    // 单调、不重叠、落在音频里
    expect(outcome.sentences[0].start).toBe(0);
    expect(outcome.sentences[0].end).toBeLessThanOrEqual(outcome.sentences[1].start);
    expect(outcome.sentences[1].end).toBeLessThanOrEqual(outcome.duration);
    // 每句的词都齐了（"Hallo Welt" 两个词，"Guten Tag" 两个词）
    expect(outcome.words.filter((w) => w.sentenceIndex === 0).map((w) => w.wordIndex)).toEqual([0, 1]);
    expect(outcome.words.filter((w) => w.sentenceIndex === 1).map((w) => w.wordIndex)).toEqual([0, 1]);
  });

  it('矩阵是谁算的原样带出来 —— 黑匣子与诊断页要认这一位', () => {
    const outcome = alignEmissions(certainMatrix(sentences, 3), sentences);
    expect(outcome.source).toEqual({ kind: 'remote', origin: 'test' });
  });

  it('确定的矩阵给出接近 0 的置信度 —— 分数确实是从矩阵里来的', () => {
    const outcome = alignEmissions(certainMatrix(sentences, 4), sentences);
    for (const s of outcome.sentences) {
      expect(s.confidence).toBeGreaterThan(Math.log(0.9) - 0.01);
    }
  });

  it('没有可对齐的句子时当场抛错 —— 而不是先白算一遍', () => {
    const excluded = [{ ...sentence(0, 'Glossar', 0), excluded: true }];
    // 矩阵借上面那组造，反正根本走不到用它的那一步
    expect(() => alignEmissions(certainMatrix(sentences, 2), excluded)).toThrow('没有可对齐的句子');
  });

  it('transfer 列表就是矩阵底下那段 buffer —— 进 Worker 时不该有拷贝', () => {
    const matrix = certainMatrix(sentences, 2);
    expect(emissionTransferables(matrix)).toEqual([matrix.logProbs.buffer]);
  });

  it('structured clone 一遍还是同一个矩阵 —— 「可序列化」不是嘴上说的', () => {
    const matrix = certainMatrix(sentences, 3);
    const copy = structuredClone(matrix);
    expect(copy.frames).toBe(matrix.frames);
    expect(copy.source).toEqual(matrix.source);
    expect(Array.from(copy.logProbs)).toEqual(Array.from(matrix.logProbs));
    // 而且它算出来的东西也一样
    expect(alignEmissions(copy, sentences).sentences).toEqual(
      alignEmissions(matrix, sentences).sentences,
    );
  });
});
