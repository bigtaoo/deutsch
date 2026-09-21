import { describe, it, expect, vi } from 'vitest';
import { buildQuestion, buildReadQuestion, formPool, glossPool, pickCloze, wordPool } from './questionSource';
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

// ── FR-21：读卡 ───────────────────────────────────────────────────
describe('pickCloze', () => {
  it('挑第一条挖得动的例句', () => {
    const e = preset('Vorhang', { examples: ['Ganz ohne das Wort.', 'Der Vorhang fiel.'] });
    expect(pickCloze(e)).toBe('Der _____ fiel.');
  });

  it('一条都挖不动时返回 null —— 那道题会降级，不是坏卡', () => {
    expect(pickCloze(preset('Vorhang', { examples: ['Ein ganz anderer Satz.'] }))).toBeNull();
    expect(pickCloze(preset('Vorhang'))).toBeNull();
  });

  it('词头挖不动时用 surface 再试一次（查词卡的 surface 与词头可能不同）', () => {
    const e = preset('Plattform', { lemma: 'Plattform', examples: ['Viele Plattformen im Netz.'] });
    expect(pickCloze(e)).toBe('Viele _____ im Netz.');
  });
});

describe('wordPool（FR-21.7）', () => {
  it('预置卡取牌组里名次相邻的词，不含自己', () => {
    const e = preset('Vorhang', { preset: { band: 4, rank: 3001 } });
    return wordPool(e, [], loadDeck).then((pool) => {
      expect(pool.length).toBeGreaterThanOrEqual(3);
      expect(pool.map((c) => c.w)).not.toContain('Vorhang');
      expect(DECK.words.map((x) => x.w)).toEqual(expect.arrayContaining(pool.map((c) => c.w)));
    });
  });

  it('**不用 IPA 近邻** —— 那是给辨音题的，填进句子里一眼就假', async () => {
    // Vorhang 的近邻是 Vorgang/Vorrang/Vorfall/vorhin，其中 Vorrang/Vorfall/vorhin
    // 根本不在这个牌组里。wordPool 只会给出牌组里的词，所以它没走那条路。
    const e = preset('Vorhang', { preset: { band: 4, rank: 3001 } });
    const pool = await wordPool(e, [], loadDeck);
    expect(pool.map((c) => c.w)).not.toContain('vorhin');
  });

  it('课程卡没有名次，退到生词本里同词性的词', async () => {
    const me = preset('Vorhang', { preset: undefined, gender: 'm', lessonId: 'L1' });
    const others = [
      preset('Haus', { preset: undefined, gender: 'n' }),
      preset('Tor', { preset: undefined, gender: 'n' }),
      preset('Bild', { preset: undefined, gender: 'n' }),
      preset('gehen', { preset: undefined }), // 没有性 —— 按 toCandidate 的近似不算名词
    ];
    const pool = await wordPool(me, [me, ...others], loadDeck);
    expect(pool.map((c) => c.w).sort()).toEqual(['Bild', 'Haus', 'Tor']);
  });
});

describe('buildReadQuestion（FR-21.4）', () => {
  const read = (state: FSRSCard['state'], reps: number): FSRSCard => ({ ...card(state), reps });
  const others = [
    preset('Vorgang'),
    preset('Lebensform'),
    preset('Halluzination'),
    preset('Fernbedienung'),
  ];

  it('还没进 Review 的读卡考「看词形选释义」', async () => {
    const e = preset('Vorhang', { fsrsRead: read(0, 0) });
    const q = await buildReadQuestion(e, [e, ...others], loadDeck, keepOrder);
    expect(q.kind).toBe('read-gloss');
    expect(q.prompt).toBe('Vorhang');
  });

  it('Review + reps 奇数考「看释义选词形」', async () => {
    const e = preset('Vorhang', { fsrsRead: read(2, 1) });
    const q = await buildReadQuestion(e, [e, ...others], loadDeck, keepOrder);
    expect(q.kind).toBe('read-form');
    expect(q.choices.map((c) => c.text)).toContain('Vorhang');
  });

  it('Review + reps 偶数考挖空 —— 前提是卡上有挖得动的句子', async () => {
    const e = preset('Vorhang', { fsrsRead: read(2, 2), examples: ['Der Vorhang fiel.'] });
    const q = await buildReadQuestion(e, [e, ...others], loadDeck, keepOrder);
    expect(q.kind).toBe('cloze');
    expect(q.prompt).toBe('Der _____ fiel.');
  });

  it('挖不动就降级成 read-form，不抛异常也不出空题', async () => {
    const ohne = preset('Vorhang', { fsrsRead: read(2, 2) });
    expect((await buildReadQuestion(ohne, [ohne, ...others], loadDeck, keepOrder)).kind).toBe('read-form');

    const falsch = preset('Vorhang', { fsrsRead: read(2, 2), examples: ['Ein anderer Satz.'] });
    expect((await buildReadQuestion(falsch, [falsch, ...others], loadDeck, keepOrder)).kind).toBe(
      'read-form',
    );
  });

  it('生词本里凑不出有释义的干扰项时，read-gloss 降级成 read-form', async () => {
    // 只有自己一张卡：glossPool 空，但牌组还能给出词形干扰项
    const allein = preset('Vorhang', { fsrsRead: read(0, 0) });
    const q = await buildReadQuestion(allein, [allein], loadDeck, keepOrder);
    expect(q.kind).toBe('read-form');
    expect(q.choices.length).toBeGreaterThanOrEqual(3);
  });

  it('读卡的题一定带题面 —— 没有题面的读卡在界面上是一张空卡', async () => {
    for (const [state, reps] of [[0, 0], [2, 1], [2, 2]] as const) {
      const e = preset('Vorhang', { fsrsRead: read(state, reps), examples: ['Der Vorhang fiel.'] });
      const q = await buildReadQuestion(e, [e, ...others], loadDeck, keepOrder);
      expect(q.prompt).toBeTruthy();
    }
  });

  it('正确项恰好一个 —— 三种题型都要', async () => {
    for (const [state, reps] of [[0, 0], [2, 1], [2, 2]] as const) {
      const e = preset('Vorhang', { fsrsRead: read(state, reps), examples: ['Der Vorhang fiel.'] });
      const q = await buildReadQuestion(e, [e, ...others], loadDeck, keepOrder);
      expect(q.choices.filter((c) => c.correct)).toHaveLength(1);
    }
  });
});
