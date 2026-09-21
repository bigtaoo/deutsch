import { describe, it, expect } from 'vitest';
import { applyZh, pendingZh, zhPreview, zhRequest, ZH_PROMPT } from './glossZh';
import { parseTranslations } from '@/lesson/translation';
import type { FSRSCard, VocabEntry } from '@/types/models';

const NOW = new Date('2026-09-21T12:00:00Z').getTime();

const CARD: FSRSCard = {
  due: NOW,
  stability: 1,
  difficulty: 5,
  elapsed_days: 0,
  scheduled_days: 0,
  reps: 0,
  lapses: 0,
  state: 0,
};

function entry(id: string, extra: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id,
    surface: id,
    meaning: `Erklärung von ${id}`,
    hasTimestamp: false,
    suspended: false,
    fsrs: CARD,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

describe('pendingZh', () => {
  it('只挑还没有中译的，按 createdAt 升序 —— 编号就靠这个顺序', () => {
    const list = [
      entry('spaet', { createdAt: NOW }),
      entry('fertig', { createdAt: NOW - 5000, meaningZh: '已有' }),
      entry('frueh', { createdAt: NOW - 10_000 }),
    ];
    expect(pendingZh(list).map((e) => e.id)).toEqual(['frueh', 'spaet']);
  });

  it('暂停的词条也算 —— 暂停的是调度，不是这个词', () => {
    expect(pendingZh([entry('pausiert', { suspended: true })])).toHaveLength(1);
  });
});

describe('zhRequest', () => {
  it('提示词在前，编号从 1 开始，带上德语释义当语境', () => {
    const text = zhRequest([entry('Zug'), entry('Vorhang')]);
    expect(text.startsWith(ZH_PROMPT)).toBe(true);
    expect(text).toContain('1. Zug — Erklärung von Zug');
    expect(text).toContain('2. Vorhang — Erklärung von Vorhang');
  });

  it('没有释义的词条只给词形，不给一个空的破折号', () => {
    expect(zhRequest([entry('Wort', { meaning: undefined })])).toContain('1. Wort\n');
  });

  it('用词头而不是表层形式 —— 翻的是这个词，不是它在某句里的样子', () => {
    expect(zhRequest([entry('gelaufen', { lemma: 'laufen' })])).toContain('1. laufen');
  });
});

describe('applyZh', () => {
  const ordered = [entry('a'), entry('b'), entry('c')];

  it('按编号写回，只返回真的变了的那些', () => {
    const { updated, applied } = applyZh(ordered, new Map([[1, '第一'], [3, '第三']]));
    expect(applied).toBe(2);
    expect(updated.map((e) => [e.id, e.meaningZh])).toEqual([['a', '第一'], ['c', '第三']]);
  });

  it('这次没给到的词原样保留 —— 一次贴一半是常事', () => {
    const { updated } = applyZh(ordered, new Map([[2, '第二']]));
    expect(updated.map((e) => e.id)).toEqual(['b']);
  });

  it('落不到词上的编号报出来，不静默丢掉', () => {
    const { strayNumbers } = applyZh(ordered, new Map([[1, '一'], [9, '九'], [7, '七']]));
    expect(strayNumbers).toEqual([7, 9]);
  });

  it('值没变就不算改过 —— 重复贴同一份不该把 updatedAt 全推新（那会白推一次同步）', () => {
    const had = [entry('a', { meaningZh: '窗帘' })];
    expect(applyZh(had, new Map([[1, '窗帘']])).applied).toBe(0);
    expect(applyZh(had, new Map([[1, '  窗帘  ']])).applied).toBe(0);
  });

  it('空译文不写入', () => {
    expect(applyZh(ordered, new Map([[1, '   ']])).applied).toBe(0);
  });
});

describe('与 FR-19 的解析器接得上', () => {
  it('复制走 → 在外面翻 → 原样贴回来，编号对得上', () => {
    const ordered = [entry('Vorhang'), entry('Zug'), entry('abwägen')];
    const reply = [
      '好的，以下是翻译：',
      '',
      '1. 窗帘',
      '**2.** 火车；一步棋',
      '- 3) 权衡',
      '',
      '以上。',
    ].join('\n');
    const { updated, applied, strayNumbers } = applyZh(ordered, parseTranslations(reply));
    expect(applied).toBe(3);
    expect(strayNumbers).toEqual([]);
    expect(updated.map((e) => e.meaningZh)).toEqual(['窗帘', '火车；一步棋', '权衡']);
  });
});

describe('zhPreview', () => {
  it('按编号排好，一行一个「德语词 → 中文」', () => {
    const ordered = [entry('Vorhang'), entry('Zug')];
    expect(zhPreview(ordered, new Map([[2, '火车'], [1, '窗帘']]))).toEqual([
      { n: 1, word: 'Vorhang', zh: '窗帘' },
      { n: 2, word: 'Zug', zh: '火车' },
    ]);
  });

  it('落不到词上的编号不进预览 —— 它由 strayNumbers 那条路报', () => {
    expect(zhPreview([entry('a')], new Map([[5, '五']]))).toEqual([]);
  });
});
