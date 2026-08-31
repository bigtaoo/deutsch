import { describe, it, expect } from 'vitest';
import { annotatedSentences, resolveRange, sentenceIndexAt } from './timing';
import type { Sentence } from '@/types/models';

function s(index: number, extra: Partial<Sentence> = {}): Sentence {
  return {
    index,
    text: `Satz ${index}`,
    charStart: index * 10,
    charEnd: index * 10 + 6,
    endTimeExplicit: false,
    blanks: [],
    markedDifficult: false,
    excluded: false,
    ...extra,
  };
}

describe('resolveRange', () => {
  it('显式 endTime 优先', () => {
    const list = [s(0, { startTime: 1, endTime: 3, endTimeExplicit: true }), s(1, { startTime: 5 })];
    expect(resolveRange(list, 0, 100)).toEqual({ start: 1, end: 3, explicitEnd: true });
  });

  it('未显式标记时取下一个**有 startTime** 的句子，跳过中间未标注的', () => {
    const list = [s(0, { startTime: 1 }), s(1), s(2), s(3, { startTime: 40 })];
    expect(resolveRange(list, 0, 100)).toEqual({ start: 1, end: 40, explicitEnd: false });
  });

  it('后面没有任何标注时退到音频总时长', () => {
    const list = [s(0, { startTime: 1 }), s(1)];
    expect(resolveRange(list, 0, 90)).toEqual({ start: 1, end: 90, explicitEnd: false });
  });

  it('连音频总时长都不知道时给保底区间，不返回 null（§3.3 R3）', () => {
    const list = [s(0, { startTime: 1 })];
    expect(resolveRange(list, 0, undefined)).toEqual({ start: 1, end: 11, explicitEnd: false });
  });

  it('未标注的句子没有区间', () => {
    expect(resolveRange([s(0)], 0, 100)).toBeNull();
  });

  it('endTime 有值但不是显式的，仍按推断规则重算', () => {
    // 上一次推断出来的 endTime 可能已经过期（后来又标了新的句子）
    const list = [s(0, { startTime: 1, endTime: 99, endTimeExplicit: false }), s(1, { startTime: 20 })];
    expect(resolveRange(list, 0, 100)?.end).toBe(20);
  });
});

describe('annotatedSentences', () => {
  it('只留下已标注且未排除的', () => {
    const list = [s(0, { startTime: 1 }), s(1), s(2, { startTime: 5, excluded: true }), s(3, { startTime: 9 })];
    expect(annotatedSentences(list).map((x) => x.index)).toEqual([0, 3]);
  });
});

describe('sentenceIndexAt', () => {
  const list = [s(0, { startTime: 0 }), s(1), s(2, { startTime: 10 })];

  it('落在区间内返回该句', () => {
    expect(sentenceIndexAt(list, 5, 30)).toBe(0);
    expect(sentenceIndexAt(list, 12, 30)).toBe(2);
  });

  it('区间外返回 null，不硬凑一个高亮', () => {
    expect(sentenceIndexAt([s(0, { startTime: 5 })], 1, 30)).toBeNull();
  });
});
