import { describe, it, expect, vi } from 'vitest';
import { buildQuestion, formPool, glossPool } from './questionSource';
import { newCard } from './fsrs';
import type { DictDeck } from '@/dict/types';
import type { FSRSCard, VocabEntry } from '@/types/models';

const NOW = new Date('2026-09-02T12:00:00Z');
const keepOrder = <T>(c: T[]) => c;

function card(state: FSRSCard['state']): FSRSCard {
  return { ...newCard(NOW), state, reps: state === 0 ? 0 : 3 };
}

function preset(surface: string, extra: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id: surface,
    surface,
    // 释义里**不含词头**：含了会被 maskHeadword 正确地遮成「…」（见下面那条测试），
    // 那时断言的就不是这里要测的东西了。倒过来拼是为了每个词的释义互不相同 ——
    // 释义撞车的候选会被 choices.ts 丢掉。
    meaning: `Sinn: ${[...surface].reverse().join('')}`,
    preset: { band: 4, rank: 1 },
    hasTimestamp: false,
    suspended: false,
    fsrs: card(0),
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
    ...extra,
  };
}

const DECK: DictDeck = {
  id: 4,
  label: '3001–6000',
  words: [
    { w: 'Vorhang', r: 3001, d: ['Vorgang', 'Vorrang', 'Vorfall', 'vorhin'] },
    { w: 'Vorgang', r: 3002, d: ['Vorhang'] },
    { w: 'Einzelgänger', r: 3003 }, // 没有近邻的那 19%
    { w: 'Lebensform', r: 3004 },
    { w: 'Halluzination', r: 3005 },
    { w: 'Fernbedienung', r: 3006 },
  ],
};
const loadDeck = async (band: number) => (band === 4 ? DECK : null);

describe('formPool', () => {
  it('优先用牌组里预存的 IPA 近邻', async () => {
    const pool = await formPool(preset('Vorhang'), [], loadDeck);
    expect(pool.map((c) => c.w)).toEqual(['Vorgang', 'Vorrang', 'Vorfall', 'vorhin']);
  });

  it('近邻不够三个时用同档随机词补，且近邻仍排在前面', async () => {
    const pool = await formPool(preset('Vorgang'), [], loadDeck);
    expect(pool[0].w).toBe('Vorhang'); // 唯一的那个近邻
    expect(pool.length).toBeGreaterThan(3);
  });

  it('一个近邻都没有时也能凑出候选（实测 19% 的词是这样）', async () => {
    const pool = await formPool(preset('Einzelgänger'), [], loadDeck);
    expect(pool.length).toBeGreaterThanOrEqual(3);
    expect(pool.map((c) => c.w)).not.toContain('Einzelgänger');
  });

  it('课程卡没有牌组 —— 退到生词本里别的词的词形', async () => {
    const lessonCard: VocabEntry = { ...preset('Zuversicht'), preset: undefined, lessonId: 'L1' };
    const others = [preset('Vorhang'), preset('Lebensform')];
    const pool = await formPool(lessonCard, [lessonCard, ...others], loadDeck);
    expect(pool.map((c) => c.w).sort()).toEqual(['Lebensform', 'Vorhang']);
  });

  it('牌组取不到（词典没部署）也不抛异常', async () => {
    const pool = await formPool(preset('Vorhang'), [preset('Vorhang'), preset('Lebensform')], async () => null);
    expect(pool.map((c) => c.w)).toEqual(['Lebensform']);
  });

  it('自己不会出现在候选里', async () => {
    const pool = await formPool(preset('Vorhang'), [], loadDeck);
    expect(pool.map((c) => c.w)).not.toContain('Vorhang');
  });
});

describe('glossPool', () => {
  it('只要有释义的别的词', () => {
    const me = preset('Vorhang');
    const pool = glossPool(me, [me, preset('Lebensform'), preset('Falke', { meaning: undefined })]);
    expect(pool.map((c) => c.w)).toEqual(['Lebensform']);
  });

  it('有性的词当名词处理（辨义题靠它做同词性优先）', () => {
    const me = preset('Vorhang');
    const pool = glossPool(me, [me, preset('Lebensform', { gender: 'f' })]);
    expect(pool[0].pos).toBe('noun');
  });
});

describe('buildQuestion', () => {
  it('新卡出辨形题', async () => {
    const q = await buildQuestion(preset('Vorhang'), [], loadDeck, keepOrder);
    expect(q.kind).toBe('form');
    expect(q.choices.map((c) => c.text)).toEqual(['Vorhang', 'Vorgang', 'Vorrang', 'Vorfall']);
  });

  it('进入 Review 的卡出辨义题', async () => {
    const me = preset('Vorhang', { fsrs: card(2) });
    const others = ['Lebensform', 'Halluzination', 'Fernbedienung'].map((w) => preset(w));
    const q = await buildQuestion(me, [me, ...others], loadDeck, keepOrder);
    expect(q.kind).toBe('gloss');
    expect(q.choices.find((c) => c.correct)!.text).toBe('Sinn: gnahroV');
    expect(q.choices).toHaveLength(4);
  });

  it('释义里出现词头时被遮掉 —— 否则这道题不用听就能做对', async () => {
    const me = preset('Vorhang', { fsrs: card(2), meaning: 'ein Vorhang aus Textil' });
    const others = ['Lebensform', 'Halluzination', 'Fernbedienung'].map((w) => preset(w));
    const q = await buildQuestion(me, [me, ...others], loadDeck, keepOrder);
    expect(q.choices.find((c) => c.correct)!.text).toBe('ein … aus Textil');
  });

  it('生词本里凑不出三个有释义的词时，辨义题退回辨形题', async () => {
    // 刚开始用的时候就是这样：手上只有两三张卡
    const me = preset('Vorhang', { fsrs: card(2) });
    const q = await buildQuestion(me, [me, preset('Lebensform')], loadDeck, keepOrder);
    expect(q.kind).toBe('form');
  });

  it('卡自己没有释义时也退回辨形题，不出一道空白的辨义题', async () => {
    const me = preset('Vorhang', { fsrs: card(2), meaning: undefined });
    const others = ['Lebensform', 'Halluzination', 'Fernbedienung'].map((w) => preset(w));
    const q = await buildQuestion(me, [me, ...others], loadDeck, keepOrder);
    expect(q.kind).toBe('form');
  });

  it('辨义题不去取牌组文件 —— 干扰项全在内存里', async () => {
    const spy = vi.fn(loadDeck);
    const me = preset('Vorhang', { fsrs: card(2) });
    const others = ['Lebensform', 'Halluzination', 'Fernbedienung'].map((w) => preset(w));
    await buildQuestion(me, [me, ...others], spy, keepOrder);
    expect(spy).not.toHaveBeenCalled();
  });

  it('生词本里只有这一张卡时给一个单选项，不崩', async () => {
    const only = { ...preset('Zuversicht'), preset: undefined };
    const q = await buildQuestion(only, [only], async () => null, keepOrder);
    expect(q.choices).toHaveLength(1);
    expect(q.choices[0].correct).toBe(true);
  });
});
