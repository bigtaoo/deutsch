import { describe, it, expect } from 'vitest';
import { tokenize, toRanges, surfaceOf, toClozeSegments, shouldSuggestCollocation } from './tokens';

describe('tokenize', () => {
  it('词与标点各自成 token，offset 指回句内位置', () => {
    const text = 'Der Wald, groß!';
    const tokens = tokenize(text);
    expect(tokens.filter((t) => t.isWord).map((t) => t.text)).toEqual(['Der', 'Wald', 'groß']);
    for (const t of tokens) expect(text.slice(t.start, t.end)).toBe(t.text);
  });

  it('连字符与撇号不切词', () => {
    expect(tokenize("Work-and-Travel geht's").filter((t) => t.isWord).map((t) => t.text)).toEqual([
      'Work-and-Travel',
      "geht's",
    ]);
  });

  it('拼回去等于原句', () => {
    const text = '  „Ja“, sagte er — dann ging er.  ';
    expect(tokenize(text).map((t) => t.text).join('')).toBe(text);
  });
});

describe('toRanges / surfaceOf', () => {
  const text = 'Es hing von seiner Laune ab.';

  it('相邻 token 合成一段', () => {
    const tokens = tokenize(text).filter((t) => t.text === 'seiner' || t.text === 'Laune');
    const ranges = toRanges(text, tokens);
    expect(ranges).toHaveLength(1);
    expect(surfaceOf(text, ranges)).toBe('seiner Laune');
  });

  it('隔着别的词的 token 保持两段 —— 这就是 hing ... ab（FR-7.2）', () => {
    const tokens = tokenize(text).filter((t) => t.text === 'hing' || t.text === 'ab');
    const ranges = toRanges(text, tokens);
    expect(ranges).toHaveLength(2);
    expect(surfaceOf(text, ranges)).toBe('hing ... ab');
  });

  it('乱序选中也归一化成从左到右', () => {
    const tokens = tokenize(text).filter((t) => t.text === 'ab' || t.text === 'hing').reverse();
    expect(toRanges(text, tokens).map((r) => r.start)).toEqual([3, 25]);
  });
});

describe('toClozeSegments', () => {
  const text = 'Es hing von seiner Laune ab.';

  it('把挖空处切出来，其余原样保留', () => {
    const segments = toClozeSegments(text, [[{ start: 19, end: 24 }]]);
    expect(segments.map((s) => s.type)).toEqual(['text', 'blank', 'text']);
    expect(segments[1].text).toBe('Laune');
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });

  it('不连续搭配的两个区间各占一个空位', () => {
    const segments = toClozeSegments(text, [[{ start: 3, end: 7 }, { start: 25, end: 27 }]]);
    const blanks = segments.filter((s) => s.type === 'blank');
    expect(blanks.map((b) => b.text)).toEqual(['hing', 'ab']);
    expect(blanks.every((b) => b.blankIndex === 0)).toBe(true);
  });

  it('多个 Blank 按位置排序', () => {
    const segments = toClozeSegments(text, [[{ start: 19, end: 24 }], [{ start: 3, end: 7 }]]);
    expect(segments.filter((s) => s.type === 'blank').map((b) => b.text)).toEqual(['hing', 'Laune']);
  });
});

describe('shouldSuggestCollocation', () => {
  it('单个常见短词提示考虑搭配', () => {
    expect(shouldSuggestCollocation('sich')).toBe(true);
    expect(shouldSuggestCollocation('ab')).toBe(true);
  });

  it('多词搭配不提示', () => {
    expect(shouldSuggestCollocation('hing ... ab')).toBe(false);
    expect(shouldSuggestCollocation('seiner Laune')).toBe(false);
  });

  it('长的实词不提示', () => {
    expect(shouldSuggestCollocation('Zuversicht')).toBe(false);
  });
});
