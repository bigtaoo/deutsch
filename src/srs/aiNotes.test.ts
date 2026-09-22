import { describe, it, expect } from 'vitest';
import { AI_PROMPT, aiPreview, aiRequest, applyAiNotes, countMissingMeaning, pendingAi } from './aiNotes';
import { parseTranslations } from '@/lesson/translation';
import type { FSRSCard, VocabEntry } from '@/types/models';

const NOW = new Date('2026-09-22T12:00:00Z').getTime();

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
    hasTimestamp: false,
    suspended: false,
    fsrs: CARD,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

describe('pendingAi', () => {
  it('两个口子都进：查不到的空卡，和人手标记的词', () => {
    const list = pendingAi([
      entry('leer'), // 没有 meaning —— 查词面板「照样收下」那种
      entry('gut', { meaning: 'wohlgefällig' }), // 有释义、没标记：不进
      entry('Zuversicht', { meaning: 'Vertrauen in die Zukunft', askAi: true }),
    ]);
    expect(list.map((e) => e.id)).toEqual(['leer', 'Zuversicht']);
  });

  it('已经有解释的空卡不再进队列 —— 否则它永远待在待办里', () => {
    expect(pendingAi([entry('leer', { note: '一段解释' })])).toEqual([]);
  });

  it('已经有解释、但**又被标记了一次**的词照旧进 —— 重新标记是一个明确的动作', () => {
    const list = pendingAi([entry('leer', { note: '一段解释', askAi: true })]);
    expect(list).toHaveLength(1);
  });

  it('暂停复习的词条也算：暂停的是调度，不是这个词条本身', () => {
    expect(pendingAi([entry('x', { suspended: true })])).toHaveLength(1);
  });

  it('按 createdAt 升序 —— 这个顺序就是编号，新加的词只能排在末尾', () => {
    const list = pendingAi([
      entry('c', { createdAt: NOW + 2000 }),
      entry('a', { createdAt: NOW }),
      entry('b', { createdAt: NOW + 1000 }),
    ]);
    expect(list.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('aiRequest', () => {
  it('提示词在最前，然后是编号词表', () => {
    const text = aiRequest([entry('Zuversicht'), entry('abwägen')]);
    expect(text.startsWith(AI_PROMPT)).toBe(true);
    expect(text).toContain('1. Zuversicht');
    expect(text).toContain('2. abwägen');
  });

  it('带上已有的全部线索：词典释义、中译、原句', () => {
    const text = aiRequest([
      entry('Zug', {
        meaning: 'Eisenbahnzug',
        meaningZh: '火车',
        contextSentence: 'Der Zug fuhr ein.',
      }),
    ]);
    expect(text).toContain('（词典：Eisenbahnzug）');
    expect(text).toContain('（中译：火车）');
    expect(text).toContain('原句：Der Zug fuhr ein.');
  });

  it('没有原句时退到词典例句 —— 查不到的复合词往往只有这一个语境', () => {
    const text = aiRequest([entry('Vorhang', { examples: ['Der Vorhang fiel.'] })]);
    expect(text).toContain('原句：Der Vorhang fiel.');
  });

  it('编号用 lemma 而不是 surface —— 问的是词头', () => {
    expect(aiRequest([entry('Plattformen', { lemma: 'Plattform' })])).toContain('1. Plattform');
  });

  it('原句里的换行被压平 —— 不然它会顶掉下一个词的编号行', () => {
    const text = aiRequest([entry('x', { contextSentence: 'erste Zeile\nzweite Zeile' })]);
    expect(text).toContain('原句：erste Zeile zweite Zeile');
  });
});

describe('applyAiNotes', () => {
  const ordered = [entry('a'), entry('b'), entry('c')];

  it('按编号写回，并**清掉 askAi**', () => {
    const marked = [entry('a', { askAi: true }), entry('b')];
    const { updated, applied } = applyAiNotes(marked, new Map([[1, '关于 a 的解释']]));
    expect(applied).toBe(1);
    expect(updated[0].note).toBe('关于 a 的解释');
    expect('askAi' in updated[0]).toBe(false);
  });

  it('这次没给到的词保留原样 —— 一次贴一半是常事', () => {
    const { updated } = applyAiNotes(ordered, new Map([[2, 'b 的解释']]));
    expect(updated.map((e) => e.id)).toEqual(['b']);
  });

  it('落不到词上的编号报出来，不静默丢掉', () => {
    const { applied, strayNumbers } = applyAiNotes(ordered, new Map([[9, '?'], [1, 'ok']]));
    expect(applied).toBe(1);
    expect(strayNumbers).toEqual([9]);
  });

  it('内容一字不差且没有标记时不产生一次写入', () => {
    const same = [entry('a', { note: '同样的解释' })];
    expect(applyAiNotes(same, new Map([[1, '同样的解释']])).applied).toBe(0);
  });

  it('内容一样但还挂着标记时**要写** —— 否则那个标记永远消不掉', () => {
    const same = [entry('a', { note: '同样的解释', askAi: true })];
    const { updated, applied } = applyAiNotes(same, new Map([[1, '同样的解释']]));
    expect(applied).toBe(1);
    expect('askAi' in updated[0]).toBe(false);
  });

  it('空解释不写 —— 和「这个词还没问」是一回事', () => {
    expect(applyAiNotes(ordered, new Map([[1, '   ']])).applied).toBe(0);
  });
});

describe('和 parseTranslations 合起来走一遍', () => {
  it('一个词的解释占好几行时整块收下', () => {
    const ordered = [entry('Zuversicht'), entry('Vertrauen')];
    const pasted = [
      '1. 信心、笃定。',
      '偏向对未来的乐观预期，不含「托付」的意思。',
      '搭配：voller Zuversicht。',
      '2. 信任。',
    ].join('\n');
    const { updated, applied } = applyAiNotes(ordered, parseTranslations(pasted));
    expect(applied).toBe(2);
    expect(updated[0].note).toContain('voller Zuversicht');
    expect(updated[0].note?.split('\n')).toHaveLength(3);
  });

  it('前言后记落不到任何编号上，自然被忽略', () => {
    const { applied } = applyAiNotes(
      [entry('a')],
      parseTranslations('好的，以下是讲解：\n\n1. a 的解释\n\n以上。'),
    );
    expect(applied).toBe(1);
  });
});

describe('countMissingMeaning / aiPreview', () => {
  it('说清待办里「只能靠外面补」的有几个', () => {
    expect(countMissingMeaning([entry('a'), entry('b', { meaning: 'x', askAi: true })])).toBe(1);
  });

  it('预览按编号排序、落空的编号不出现在预览里', () => {
    const rows = aiPreview(
      [entry('Plattformen', { lemma: 'Plattform' })],
      new Map([[5, '落空'], [1, ' 解释 ']]),
    );
    expect(rows).toEqual([{ n: 1, word: 'Plattform', note: '解释' }]);
  });
});
