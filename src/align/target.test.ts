import { describe, expect, it } from 'vitest';
import { buildTarget, toTimings } from './target';
import { GERMAN_VOCAB, SEPARATOR_WORD_INDEX, mapChar, tokenizeSentence } from './vocab';
import type { Sentence } from '@/types/models';
import type { TokenSpan } from './viterbi';

function sentence(index: number, text: string, excluded = false): Sentence {
  return {
    index,
    text,
    charStart: 0,
    charEnd: text.length,
    endTimeExplicit: false,
    blanks: [],
    markedDifficult: false,
    excluded,
  };
}

const ID_TO_CHAR = new Map(Object.entries(GERMAN_VOCAB).map(([k, v]) => [v, k]));
const chars = (tokens: ReturnType<typeof tokenizeSentence>) =>
  tokens.map((t) => ID_TO_CHAR.get(t.id)).join('');

describe('mapChar', () => {
  it('德语变音符**原样保留** —— 这正是换掉罗马化模型的理由', () => {
    expect(mapChar('ä')).toBe('ä');
    expect(mapChar('Ö')).toBe('ö');
    expect(mapChar('ü')).toBe('ü');
    expect(mapChar('ß')).toBe('ß');
    expect(mapChar('ẞ')).toBe('ß');
  });

  it('词表以外的带符字母去掉变音符：é→e、ç→c', () => {
    expect(mapChar('é')).toBe('e');
    expect(mapChar('ç')).toBe('c');
    expect(mapChar('í')).toBe('i');
  });

  it('丢掉标点、数字、空白、撇号（这套词表里没有撇号）', () => {
    for (const ch of ['„', '"', '.', ',', '–', '3', ' ', '\n', ':', "'", '’', '-']) {
      expect(mapChar(ch)).toBe('');
    }
  });
});

describe('tokenizeSentence', () => {
  it('保留每个 token 到原文字符的 offset', () => {
    const tokens = tokenizeSentence('Fuß');
    expect(chars(tokens)).toBe('fuß');
    expect(tokens.map((t) => t.charOffset)).toEqual([0, 1, 2]);
  });

  it('词与词之间插一个 `|`，它不属于任何词', () => {
    const tokens = tokenizeSentence('Was tun');
    expect(chars(tokens)).toBe('was|tun');
    const sep = tokens.find((t) => t.wordIndex === SEPARATOR_WORD_INDEX)!;
    expect(sep.id).toBe(GERMAN_VOCAB['|']);
    // 分隔符的出处是那个空格
    expect(sep.charOffset).toBe(3);
  });

  it('句首标点不占词号，也不产生分隔符', () => {
    const tokens = tokenizeSentence('„Work and Travel“');
    expect(chars(tokens)).toBe('work|and|travel');
    expect(tokens.filter((t) => t.wordIndex === 0).map((t) => t.charOffset)).toEqual([1, 2, 3, 4]);
  });

  it('只有空白断词：词内的撇号与连字符不断词', () => {
    expect(chars(tokenizeSentence("geht's"))).toBe('gehts');
    expect(chars(tokenizeSentence('E-Mail'))).toBe('email');
    expect(new Set(tokenizeSentence("geht's").map((t) => t.wordIndex))).toEqual(new Set([0]));
  });

  it('连续的标点+空白只断一次词', () => {
    const tokens = tokenizeSentence('Was tun? Und dann');
    expect(Math.max(...tokens.map((t) => t.wordIndex))).toBe(3);
    expect(tokens.filter((t) => t.wordIndex === SEPARATOR_WORD_INDEX)).toHaveLength(3);
  });

  it('德语双写字母原样保留（Viterbi 依赖它）', () => {
    expect(chars(tokenizeSentence('alle'))).toBe('alle');
  });
});

describe('buildTarget', () => {
  it('跳过排除句', () => {
    const target = buildTarget([
      sentence(0, 'Titel hier', true),
      sentence(1, 'Was tun'),
      sentence(2, 'Glossar', true),
    ]);
    expect(target.covered).toEqual([1]);
    expect(new Set(target.sentenceIndex)).toEqual(new Set([1]));
  });

  it('跳过映射后为空的句子（纯标点/纯数字）', () => {
    const target = buildTarget([sentence(0, '1990.'), sentence(1, 'Ja')]);
    expect(target.covered).toEqual([1]);
  });

  it('句与句之间也插一个分隔符，记在上一句名下', () => {
    const target = buildTarget([sentence(7, 'ja'), sentence(9, 'nein')]);
    expect(target.covered).toEqual([7, 9]);
    // j a | n e i n
    expect([...target.sentenceIndex]).toEqual([7, 7, 7, 9, 9, 9, 9]);
    expect([...target.wordIndex]).toEqual([0, 0, SEPARATOR_WORD_INDEX, 0, 0, 0, 0]);
    expect(target.charOffset[2]).toBe(-1);
  });

  it('四个平行数组等长', () => {
    const t = buildTarget([sentence(0, 'Die Schulzeit ist beendet.')]);
    expect(t.sentenceIndex).toHaveLength(t.ids.length);
    expect(t.charOffset).toHaveLength(t.ids.length);
    expect(t.wordIndex).toHaveLength(t.ids.length);
  });
});

describe('toTimings', () => {
  // 每 token 一帧，第 i 个 token 占第 i 帧 —— 0.02s/帧
  const spansOf = (n: number): TokenSpan[] =>
    Array.from({ length: n }, (_, i) => ({ startFrame: i, endFrame: i + 1, score: -0.1 }));

  it('句边界 = 首 token 起帧 → 末 token 止帧，句间那个分隔符不算进任何一句', () => {
    const target = buildTarget([sentence(0, 'ja'), sentence(1, 'nein')]);
    const { sentences } = toTimings(target, spansOf(target.ids.length));
    expect(sentences.map((s) => s.index)).toEqual([0, 1]);
    expect(sentences[0].start).toBeCloseTo(0);
    expect(sentences[0].end).toBeCloseTo(0.04); // j,a → 帧 0..2；帧 2 是分隔符，不要
    expect(sentences[1].start).toBeCloseTo(0.06); // n 从帧 3 开始
    expect(sentences[1].end).toBeCloseTo(0.14);
  });

  it('词级时间戳的 charStart/charEnd 落在句内且右开', () => {
    const target = buildTarget([sentence(0, 'Was tun')]);
    const { words } = toTimings(target, spansOf(target.ids.length));
    expect(words).toHaveLength(2);
    expect([words[0].charStart, words[0].charEnd]).toEqual([0, 3]);
    expect([words[1].charStart, words[1].charEnd]).toEqual([4, 7]);
  });

  it('词内的分隔符（不该有）不会把词的 charEnd 撑过头', () => {
    const target = buildTarget([sentence(0, 'Fuß')]);
    const { words } = toTimings(target, spansOf(target.ids.length));
    expect([words[0].charStart, words[0].charEnd]).toEqual([0, 3]);
  });

  it('句 confidence 是该句 token 分数的均值，不含分隔符', () => {
    const target = buildTarget([sentence(0, 'ja')]);
    const spans = spansOf(2);
    spans[0].score = -0.2;
    spans[1].score = -0.4;
    const { sentences } = toTimings(target, spans);
    expect(sentences[0].confidence).toBeCloseTo(-0.3);
  });

  it('span 数与目标不一致时报错', () => {
    const target = buildTarget([sentence(0, 'ja')]);
    expect(() => toTimings(target, spansOf(5))).toThrow(/不一致/);
  });
});
