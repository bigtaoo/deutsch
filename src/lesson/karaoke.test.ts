import { describe, it, expect } from 'vitest';
import { activeAt, activeTokenAt, buildKaraoke } from './karaoke';
import type { Sentence, WordSpan } from '@/types/models';

function s(index: number, text: string, extra: Partial<Sentence> = {}): Sentence {
  return {
    index,
    text,
    charStart: 0,
    charEnd: text.length,
    endTimeExplicit: false,
    blanks: [],
    markedDifficult: false,
    excluded: false,
    ...extra,
  };
}

function w(charStart: number, charEnd: number, start: number, end: number): WordSpan {
  return { charStart, charEnd, start, end };
}

const NUMBERS = 'Zwischen 18 und 30 Jahren.';

describe('buildKaraoke', () => {
  it('token 拼回来正是原句 —— 标点、空格、数字一个都没丢', () => {
    const [line] = buildKaraoke([s(0, NUMBERS, { startTime: 0.9, endTime: 3.8, endTimeExplicit: true })]);
    expect(line.tokens.map((t) => t.text).join('')).toBe(NUMBERS);
  });

  it('一个显示词覆盖多个 WordSpan 时取并集（`Work-and-Travel` 在对齐器那边是三个词）', () => {
    const text = 'Work-and-Travel ist teuer.';
    const [line] = buildKaraoke([
      s(0, text, {
        startTime: 0.9,
        endTime: 2.5,
        endTimeExplicit: true,
        words: [w(0, 4, 1, 1.2), w(5, 8, 1.2, 1.4), w(9, 15, 1.4, 2), w(16, 19, 2.1, 2.3)],
      }),
    ]);
    const compound = line.tokens.find((t) => t.text === 'Work-and-Travel')!;
    expect(compound.time).toEqual({ start: 1, end: 2 });
    expect(compound.bridged).toBeUndefined();
  });

  it('罗马化丢掉的数字由前后两个真锚点之间的空档接住，并标成 bridged', () => {
    const [line] = buildKaraoke([
      s(0, NUMBERS, {
        startTime: 0.9,
        endTime: 3.8,
        endTimeExplicit: true,
        words: [w(0, 8, 1, 1.5), w(12, 15, 2, 2.3), w(19, 25, 3, 3.6)],
      }),
    ]);
    const byText = new Map(line.tokens.filter((t) => t.isWord).map((t) => [t.text, t]));
    expect(byText.get('18')!.time).toEqual({ start: 1.5, end: 2 });
    expect(byText.get('18')!.bridged).toBe(true);
    expect(byText.get('30')!.time).toEqual({ start: 2.3, end: 3 });
    expect(byText.get('Zwischen')!.bridged).toBeUndefined();
    expect(line.hasWords).toBe(true);
  });

  it('句首/句尾的数字用句子自己的边界当锚点', () => {
    const text = '1950er-Jahre waren still.';
    // 「1950er-Jahre」与「waren」都没有真锚点，只有 `still` 有
    const [line] = buildKaraoke([
      s(0, text, { startTime: 5, endTime: 8, endTimeExplicit: true, words: [w(19, 24, 7, 7.6)] }),
    ]);
    // 句首到 `still` 起点这段空档按字符数摊给那两个词：起点是句子的起点，
    // 终点接上后面那个真锚点。
    const first = line.tokens[0];
    expect(first.text).toBe('1950er-Jahre');
    expect(first.bridged).toBe(true);
    expect(first.time!.start).toBe(5);
    expect(first.time!.end).toBeCloseTo(5 + (2 * 12) / 17);
    const waren = line.tokens.find((t) => t.text === 'waren')!;
    expect(waren.time!.end).toBeCloseTo(7);
  });

  it('只有句级时间戳、没有词级时间戳时不桥接 —— 那会退化成伪同步', () => {
    const [line] = buildKaraoke([s(0, NUMBERS, { startTime: 1, endTime: 4, endTimeExplicit: true })]);
    expect(line.hasWords).toBe(false);
    expect(line.tokens.every((t) => t.time === undefined)).toBe(true);
    expect(line.range).toEqual({ start: 1, end: 4 });
  });

  it('没有句级时间戳的句子：range 为 null，词级也一律不给', () => {
    const [line] = buildKaraoke([s(0, NUMBERS, { words: [w(0, 8, 1, 1.5)] })]);
    expect(line.range).toBeNull();
    expect(line.tokens.every((t) => t.time === undefined)).toBe(true);
  });
});

describe('activeAt', () => {
  const lines = buildKaraoke(
    [
      s(0, 'Erster Satz.', {
        startTime: 1,
        endTime: 2,
        endTimeExplicit: true,
        words: [w(0, 6, 1, 1.4), w(7, 11, 1.5, 2)],
      }),
      s(1, 'Zweiter Satz.', {
        startTime: 5,
        endTime: 6,
        endTimeExplicit: true,
        words: [w(0, 7, 5, 5.4)],
      }),
    ],
    20,
  );

  it('落在句内：inside=true，并给出当前词', () => {
    const active = activeAt(lines, 1.6)!;
    expect(active.line).toBe(0);
    expect(active.inside).toBe(true);
    expect(lines[0].tokens[active.token!].text).toBe('Satz');
  });

  it('落在两句之间的空档：仍然标出刚读完的那一句，但不标词', () => {
    const active = activeAt(lines, 3.5)!;
    expect(active.line).toBe(0);
    expect(active.inside).toBe(false);
    expect(active.token).toBeNull();
  });

  it('第一句开口之前什么都不标', () => {
    expect(activeAt(lines, 0.4)).toBeNull();
  });

  it('全篇没有一句有时间戳时返回 null，而不是硬标第一句', () => {
    expect(activeAt(buildKaraoke([s(0, 'Ohne Zeit.')]), 3)).toBeNull();
  });
});

describe('activeTokenAt', () => {
  const [line] = buildKaraoke([
    s(0, 'Erster Satz.', {
      startTime: 1,
      endTime: 2.2,
      endTimeExplicit: true,
      words: [w(0, 6, 1, 1.4), w(7, 11, 1.8, 2.2)],
    }),
  ]);

  it('词与词之间的静音里，上一个词继续亮着（不闪黑）', () => {
    const first = line.tokens.findIndex((t) => t.text === 'Erster');
    expect(activeTokenAt(line, 1.4)).toBe(first);
    expect(activeTokenAt(line, 1.7)).toBe(first);
    expect(line.tokens[activeTokenAt(line, 1.9)!].text).toBe('Satz');
  });

  it('第一个词开口之前不亮任何词', () => {
    expect(activeTokenAt(line, 1)).not.toBeNull();
    expect(activeTokenAt(line, 0.5)).toBeNull();
  });
});

describe('连着两个没有 token 的词', () => {
  it('空档按字符数分摊，不是第一个吞掉全部', () => {
    // `1950 1960` 两个词都是纯数字，罗马化后一个 token 都不剩
    const text = 'Jahre 1950 1960 waren.';
    const [line] = buildKaraoke([
      s(0, text, {
        startTime: 1,
        endTime: 5,
        endTimeExplicit: true,
        words: [w(0, 5, 1, 2), w(16, 21, 4, 5)],
      }),
    ]);
    const [a, b] = line.tokens.filter((t) => t.isWord && t.bridged);
    expect(a.text).toBe('1950');
    expect(b.text).toBe('1960');
    expect(a.time).toEqual({ start: 2, end: 3 });
    expect(b.time).toEqual({ start: 3, end: 4 });
  });
});
