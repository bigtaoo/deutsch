import { describe, expect, it } from 'vitest';
import { buildTarget, toTimings } from './target';
import { MMS_FA_VOCAB, romanizeChar, romanizeSentence } from './vocab';
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

const ID_TO_CHAR = new Map(Object.entries(MMS_FA_VOCAB).map(([k, v]) => [v, k]));
const chars = (tokens: ReturnType<typeof romanizeSentence>) =>
  tokens.map((t) => ID_TO_CHAR.get(t.id)).join('');

describe('romanizeChar', () => {
  it('去德语变音符', () => {
    expect(romanizeChar('ä')).toBe('a');
    expect(romanizeChar('Ö')).toBe('o');
    expect(romanizeChar('ü')).toBe('u');
  });

  it('ß 展开成 ss —— 一个字符产出两个 token', () => {
    expect(romanizeChar('ß')).toBe('ss');
  });

  it('丢掉标点、数字、空白', () => {
    for (const ch of ['„', '"', '.', ',', '–', '3', ' ', '\n', ':']) {
      expect(romanizeChar(ch)).toBe('');
    }
  });

  it('花体撇号归一到 vocab 里的 ASCII 撇号', () => {
    expect(romanizeChar('’')).toBe("'");
  });
});

describe('romanizeSentence', () => {
  it('保留每个 token 到原文字符的 offset', () => {
    const tokens = romanizeSentence('Fuß');
    expect(chars(tokens)).toBe('fuss');
    // f→0, u→1, s s 都来自同一个 ß（offset 2）
    expect(tokens.map((t) => t.charOffset)).toEqual([0, 1, 2, 2]);
  });

  it('句首标点不占词号', () => {
    const tokens = romanizeSentence('„Work and Travel“');
    expect(tokens.filter((t) => t.wordIndex === 0).map((t) => t.charOffset)).toEqual([1, 2, 3, 4]);
    expect(new Set(tokens.map((t) => t.wordIndex)).size).toBe(3);
  });

  it('连续的标点+空白只断一次词', () => {
    const tokens = romanizeSentence('Was tun? Und dann');
    expect(Math.max(...tokens.map((t) => t.wordIndex))).toBe(3);
  });

  it('德语双写字母原样保留（Viterbi 依赖它）', () => {
    expect(chars(romanizeSentence('alle'))).toBe('alle');
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

  it('跳过罗马化后为空的句子（纯标点/纯数字）', () => {
    const target = buildTarget([sentence(0, '1990.'), sentence(1, 'Ja')]);
    expect(target.covered).toEqual([1]);
  });

  it('sentenceIndex 用 Sentence.index 而不是数组下标', () => {
    const target = buildTarget([sentence(7, 'ja'), sentence(9, 'nein')]);
    expect(target.covered).toEqual([7, 9]);
    expect([...target.sentenceIndex]).toEqual([7, 7, 9, 9, 9, 9]);
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

  it('句边界 = 首 token 起帧 → 末 token 止帧', () => {
    const target = buildTarget([sentence(0, 'ja'), sentence(1, 'nein')]);
    const { sentences } = toTimings(target, spansOf(target.ids.length));
    expect(sentences.map((s) => s.index)).toEqual([0, 1]);
    expect(sentences[0].start).toBeCloseTo(0);
    expect(sentences[0].end).toBeCloseTo(0.04); // j,a → 帧 0..2
    expect(sentences[1].start).toBeCloseTo(0.04);
    expect(sentences[1].end).toBeCloseTo(0.12); // n,e,i,n → 帧 2..6
  });

  it('词级时间戳的 charStart/charEnd 落在句内且右开', () => {
    const target = buildTarget([sentence(0, 'Was tun')]);
    const { words } = toTimings(target, spansOf(target.ids.length));
    expect(words).toHaveLength(2);
    expect([words[0].charStart, words[0].charEnd]).toEqual([0, 3]);
    expect([words[1].charStart, words[1].charEnd]).toEqual([4, 7]);
  });

  it('ß 产生的两个 token 不会把词的 charEnd 撑过头', () => {
    const target = buildTarget([sentence(0, 'Fuß')]);
    const { words } = toTimings(target, spansOf(target.ids.length));
    expect([words[0].charStart, words[0].charEnd]).toEqual([0, 3]);
  });

  it('句 confidence 是该句 token 分数的均值', () => {
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
