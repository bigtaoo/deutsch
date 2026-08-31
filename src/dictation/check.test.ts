import { describe, it, expect } from 'vitest';
import { checkAnswer, diffChars, verdictToRating, normalizeWhitespace } from './check';

describe('checkAnswer', () => {
  it('完全一致 → 正确', () => {
    expect(checkAnswer('Zuversicht', 'Zuversicht').verdict).toBe('correct');
  });

  it('首尾空白与连续空白先折掉', () => {
    expect(checkAnswer('hing ab', '  hing   ab ').verdict).toBe('correct');
    expect(normalizeWhitespace(' a  b ')).toBe('a b');
  });

  // §10 验收清单点名的三个例子
  it('Hauser 对 Häuser → 转写等价', () => {
    expect(checkAnswer('Häuser', 'Hauser').verdict).toBe('transliteration');
  });

  it('Haeuser 对 Häuser → 转写等价', () => {
    expect(checkAnswer('Häuser', 'Haeuser').verdict).toBe('transliteration');
  });

  it('zuversicht 对 Zuversicht → 仅大小写错', () => {
    expect(checkAnswer('Zuversicht', 'zuversicht').verdict).toBe('case');
  });

  it('打错一个词 → 错误，并给出 diff', () => {
    const result = checkAnswer('Zuversicht', 'Zufersicht');
    expect(result.verdict).toBe('wrong');
    expect(result.diff.length).toBeGreaterThan(1);
  });

  it('ß 与 ss 互认', () => {
    expect(checkAnswer('Straße', 'Strasse').verdict).toBe('transliteration');
    expect(checkAnswer('Strasse', 'Straße').verdict).toBe('transliteration');
  });

  it('大小写 + 变音符同时错 → 仍归到大小写档（更轻的一档）', () => {
    expect(checkAnswer('Häuser', 'haeuser').verdict).toBe('case');
  });

  it('strictCase=false 时大小写错按正确处理', () => {
    expect(checkAnswer('Zuversicht', 'zuversicht', { strictCase: false }).verdict).toBe('correct');
  });

  it('strictCase=false 不会把真错的答案放过', () => {
    expect(checkAnswer('Zuversicht', 'Zufersicht', { strictCase: false }).verdict).toBe('wrong');
  });

  it('空答案是错误，不是「正确」', () => {
    expect(checkAnswer('Wald', '').verdict).toBe('wrong');
  });
});

describe('verdictToRating', () => {
  it('按 FR-8.6 映射', () => {
    expect(verdictToRating('correct')).toBe('good');
    expect(verdictToRating('transliteration')).toBe('good');
    expect(verdictToRating('case')).toBe('hard');
    expect(verdictToRating('wrong')).toBe('again');
  });
});

describe('diffChars', () => {
  it('相同部分标 same，缺的标 missing，多的标 extra', () => {
    const parts = diffChars('Wald', 'Wold');
    expect(parts.map((p) => p.text).join('')).toContain('W');
    expect(parts.filter((p) => p.type === 'missing').map((p) => p.text).join('')).toBe('a');
    expect(parts.filter((p) => p.type === 'extra').map((p) => p.text).join('')).toBe('o');
  });

  it('答案为空时全部是 missing', () => {
    expect(diffChars('abc', '')).toEqual([{ type: 'missing', text: 'abc' }]);
  });

  it('把期望字符按顺序拼回来', () => {
    const parts = diffChars('Zuversicht', 'Zufersicht');
    const rebuilt = parts.filter((p) => p.type !== 'extra').map((p) => p.text).join('');
    expect(rebuilt).toBe('Zuversicht');
  });
});
