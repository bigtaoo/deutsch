import { describe, expect, it } from 'vitest';
import { fitLines, wrapLines } from './card';

/** 等宽假字体：德语字符 1 格，中日韩字符 2 格 —— 够测折行逻辑本身。 */
const measure = (width: number) => (text: string) =>
  [...text].reduce((sum, ch) => sum + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0) * width;

describe('wrapLines', () => {
  it('德语按空格断，不在词中间断开', () => {
    const lines = wrapLines(measure(1), 'Wer immer strebend sich bemüht', 14);
    expect(lines).toEqual(['Wer immer', 'strebend sich', 'bemüht']);
  });

  it('中文按字断 —— 整句没有空格，按空格断会溢出', () => {
    const lines = wrapLines(measure(1), '不懂外语的人对自己的母语也一无所知', 10);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('不懂外语的人对自己的母语也一无所知');
    for (const line of lines) expect(measure(1)(line)).toBeLessThanOrEqual(10);
  });

  it('中德混排在切换处也能断', () => {
    const lines = wrapLines(measure(1), 'Goethe 说：熟能生巧', 8);
    expect(lines.join('')).toContain('Goethe');
    for (const line of lines) expect(measure(1)(line)).toBeLessThanOrEqual(8);
  });

  it('装得下就只有一行', () => {
    expect(wrapLines(measure(1), 'Aller Anfang ist schwer.', 100)).toEqual([
      'Aller Anfang ist schwer.',
    ]);
  });

  it('空串给一行空的，不是空数组 —— 调用方总能安全地取 [0]', () => {
    expect(wrapLines(measure(1), '', 100)).toEqual(['']);
  });

  it('一个词就比整行还长时不吞字', () => {
    const lines = wrapLines(measure(1), 'Donaudampfschifffahrt ist', 10);
    expect(lines.join(' ')).toBe('Donaudampfschifffahrt ist');
  });
});

describe('fitLines', () => {
  const sizes = [10, 6, 4];
  const measureAt = (size: number) => measure(size);

  it('大字号放得下就用大字号', () => {
    const { fontSize, lines } = fitLines(measureAt, 'Aller Anfang', 200, sizes, 2);
    expect(fontSize).toBe(10);
    expect(lines).toHaveLength(1);
  });

  it('放不下就往下降一号，直到行数够', () => {
    const { fontSize, lines } = fitLines(
      measureAt,
      'Wer fremde Sprachen nicht kennt weiß nichts von seiner eigenen',
      200,
      sizes,
      2,
    );
    expect(fontSize).toBeLessThan(10);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('最小号仍然超行时宁可超行也不截断', () => {
    const { fontSize, lines } = fitLines(measureAt, 'a b c d e f g h i j k', 8, sizes, 1);
    expect(fontSize).toBe(4);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('a b c d e f g h i j k');
  });
});
