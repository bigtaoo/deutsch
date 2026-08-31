import { describe, it, expect } from 'vitest';
import { segmentSentences } from './segment';
import {
  createSentences,
  displayNumbers,
  excludeLastN,
  mergeWithNext,
  setExcluded,
  splitSentence,
} from './sentences';
import type { Blank, Sentence } from '@/types/models';

const PLAIN = 'Der Wald ist groß. Die Bäume sind alt. Es regnet.';

function build(): Sentence[] {
  return createSentences(segmentSentences(PLAIN));
}

function blank(id: string, ranges: Array<{ start: number; end: number }>, surface: string): Blank {
  return { id, ranges, surface, vocabEntryId: `v-${id}` };
}

describe('createSentences', () => {
  it('index 从 0 连续，offset 指回原文', () => {
    const sentences = build();
    expect(sentences.map((s) => s.index)).toEqual([0, 1, 2]);
    for (const s of sentences) expect(PLAIN.slice(s.charStart, s.charEnd)).toBe(s.text);
  });
});

describe('mergeWithNext', () => {
  it('合并后文本按原文拼接，index 重排', () => {
    const { sentences, indexMap } = mergeWithNext(build(), 0, PLAIN);
    expect(sentences).toHaveLength(2);
    expect(sentences[0].text).toBe('Der Wald ist groß. Die Bäume sind alt.');
    expect(sentences.map((s) => s.index)).toEqual([0, 1]);
    // 后面的句子整体前移一位 —— 调用方要拿它同步 VocabEntry.sentenceIndex
    expect(indexMap.get(2)).toBe(1);
    expect(indexMap.get(0)).toBe(0);
  });

  it('时间戳跟随：起点取先出现的，终点取后出现的', () => {
    const base = build();
    base[0] = { ...base[0], startTime: 1 };
    base[1] = { ...base[1], startTime: 5, endTime: 9, endTimeExplicit: true };
    const { sentences } = mergeWithNext(base, 0, PLAIN);
    expect(sentences[0].startTime).toBe(1);
    expect(sentences[0].endTime).toBe(9);
    expect(sentences[0].endTimeExplicit).toBe(true);
  });

  it('第二句的挖空 offset 按新句起点平移', () => {
    const base = build();
    // "Die Bäume sind alt." 里的 "Bäume" = [4, 9)
    base[1] = { ...base[1], blanks: [blank('b1', [{ start: 4, end: 9 }], 'Bäume')] };
    const { sentences } = mergeWithNext(base, 0, PLAIN);
    const range = sentences[0].blanks[0].ranges[0];
    expect(sentences[0].text.slice(range.start, range.end)).toBe('Bäume');
  });

  it('只有两句都排除，合并结果才是排除', () => {
    const base = setExcluded(build(), 1, true);
    expect(mergeWithNext(base, 0, PLAIN).sentences[0].excluded).toBe(false);
    const both = setExcluded(base, 0, true);
    expect(mergeWithNext(both, 0, PLAIN).sentences[0].excluded).toBe(true);
  });

  it('最后一句没有下一句，原样返回', () => {
    const base = build();
    expect(mergeWithNext(base, 2, PLAIN).sentences).toBe(base);
  });
});

describe('splitSentence', () => {
  const merged = mergeWithNext(build(), 0, PLAIN).sentences;

  it('在光标处拆成两句，文本与 offset 都对得上原文', () => {
    const cut = 'Der Wald ist groß.'.length;
    const { sentences } = splitSentence(merged, 0, cut, PLAIN);
    expect(sentences.map((s) => s.text)).toEqual([
      'Der Wald ist groß.',
      'Die Bäume sind alt.',
      'Es regnet.',
    ]);
    for (const s of sentences) expect(PLAIN.slice(s.charStart, s.charEnd)).toBe(s.text);
    expect(sentences.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('左半句留住 startTime，右半句的起点作废等重标', () => {
    const withTimes = [{ ...merged[0], startTime: 2, endTime: 8, endTimeExplicit: true }, merged[1]];
    const { sentences } = splitSentence(withTimes, 0, 'Der Wald ist groß.'.length, PLAIN);
    expect(sentences[0].startTime).toBe(2);
    expect(sentences[0].endTime).toBeUndefined();
    expect(sentences[1].startTime).toBeUndefined();
    expect(sentences[1].endTime).toBe(8);
  });

  it('挖空按所在半句归属，跨切点的被丢弃并报告', () => {
    const cut = 'Der Wald ist groß.'.length;
    const withBlanks = [
      {
        ...merged[0],
        blanks: [
          blank('links', [{ start: 4, end: 8 }], 'Wald'),
          blank('rechts', [{ start: 23, end: 28 }], 'Bäume'),
          blank('quer', [{ start: 4, end: 8 }, { start: 23, end: 28 }], 'Wald Bäume'),
        ],
      },
      merged[1],
    ];
    const { sentences, droppedBlanks } = splitSentence(withBlanks, 0, cut, PLAIN);
    expect(sentences[0].blanks.map((b) => b.id)).toEqual(['links']);
    expect(sentences[1].blanks.map((b) => b.id)).toEqual(['rechts']);
    expect(droppedBlanks.map((b) => b.id)).toEqual(['quer']);
    const r = sentences[1].blanks[0].ranges[0];
    expect(sentences[1].text.slice(r.start, r.end)).toBe('Bäume');
  });

  it('切点落在纯空白处不产生空句子', () => {
    expect(splitSentence(merged, 0, 0, PLAIN).sentences).toBe(merged);
    expect(splitSentence(merged, 0, merged[0].text.length, PLAIN).sentences).toBe(merged);
  });
});

describe('排除', () => {
  it('excludeLastN 排除文末 N 句', () => {
    const sentences = excludeLastN(build(), 2);
    expect(sentences.map((s) => s.excluded)).toEqual([false, true, true]);
  });

  it('排除不重排 index，只影响显示编号', () => {
    const sentences = setExcluded(build(), 1, true);
    expect(sentences.map((s) => s.index)).toEqual([0, 1, 2]);
    const numbers = displayNumbers(sentences);
    expect(numbers.get(0)).toBe(1);
    expect(numbers.has(1)).toBe(false);
    expect(numbers.get(2)).toBe(2);
  });
});
