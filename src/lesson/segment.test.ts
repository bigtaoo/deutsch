import { describe, it, expect } from 'vitest';
import { segmentSentences, endsWithAbbreviation, hasUnclosedQuote } from './segment';

const texts = (input: string) => segmentSentences(input).map((s) => s.text);

describe('segmentSentences', () => {
  it('切开普通的两句', () => {
    expect(texts('Der Wald ist groß. Die Bäume sind alt.')).toEqual([
      'Der Wald ist groß.',
      'Die Bäume sind alt.',
    ]);
  });

  it('offset 指回原文中的真实位置（FR-2.4）', () => {
    const input = 'Erster Satz. Zweiter Satz.';
    for (const s of segmentSentences(input)) {
      expect(input.slice(s.charStart, s.charEnd)).toBe(s.text);
    }
  });

  it('换行是硬边界，不跨行合并', () => {
    expect(texts('Titel\nund weiter')).toEqual(['Titel', 'und weiter']);
  });

  // FR-2.2 验收清单里点名的五个例子
  it('R-abbr: z. B. 不被误断', () => {
    expect(texts('Viele Tiere, z. B. Rehe, leben dort.')).toHaveLength(1);
  });

  it('R-abbr: z.B. 无空格变体同样不被误断', () => {
    expect(texts('Viele Tiere, z.B. Rehe, leben dort.')).toHaveLength(1);
  });

  it('R-abbr: u. a. 不被误断', () => {
    expect(texts('Dort wachsen u. a. Buchen und Eichen.')).toHaveLength(1);
  });

  it('R-ordinal: am 3. Oktober 不被误断', () => {
    expect(texts('Das war am 3. Oktober ein Feiertag.')).toHaveLength(1);
  });

  it('R-ordinal: im 19. Jahrhundert 不被误断', () => {
    expect(texts('Im 19. Jahrhundert Wanderten viele aus.')).toHaveLength(1);
  });

  it('R-abbr: Dr. Müller 不被误断', () => {
    expect(texts('Dr. Müller Kommt heute.')).toHaveLength(1);
  });

  it('R-initial: A. Merkel 不被误断', () => {
    expect(texts('Das sagte A. Merkel Gestern.')).toHaveLength(1);
  });

  it('R-lower: 小写开头的片段被并回上一句', () => {
    // Segmenter 会在 "Nr." 后断开，下一片以小写开头 → 合并
    expect(texts('Die Regel Nr. gilt weiter.')).toHaveLength(1);
  });

  it('R-quote: 德语引号未闭合时合并', () => {
    const result = texts('Er sagte: „Der Wald ist groß. Die Bäume sind alt.“ Dann ging er.');
    expect(result).toEqual([
      'Er sagte: „Der Wald ist groß. Die Bäume sind alt.“',
      'Dann ging er.',
    ]);
  });

  it('空行与多余空白不产生空句子', () => {
    expect(texts('Erster Satz.\n\n\n   \n Zweiter Satz.')).toEqual([
      'Erster Satz.',
      'Zweiter Satz.',
    ]);
  });
});

describe('endsWithAbbreviation', () => {
  it('命中缩写', () => {
    expect(endsWithAbbreviation('Dort leben z. B.')).toBe(true);
    expect(endsWithAbbreviation('Dort leben z.B.')).toBe(true);
    expect(endsWithAbbreviation('Es kostet ca.')).toBe(true);
  });

  it('只是碰巧同尾的普通词不算缩写', () => {
    expect(endsWithAbbreviation('Er ging zum Bahnhofs.')).toBe(false);
    expect(endsWithAbbreviation('Das ist alles.')).toBe(false);
  });
});

describe('hasUnclosedQuote', () => {
  it('识别未闭合的德语引号与括号', () => {
    expect(hasUnclosedQuote('Er sagte: „Der Wald')).toBe(true);
    expect(hasUnclosedQuote('Er sagte: „Der Wald.“')).toBe(false);
    expect(hasUnclosedQuote('Ein Satz (mit Klammer')).toBe(true);
    expect(hasUnclosedQuote('Ein Satz "mit')).toBe(true);
    expect(hasUnclosedQuote('Ein Satz "mit" Zitat')).toBe(false);
  });
});
