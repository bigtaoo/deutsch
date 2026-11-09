// FR-22.14：课程新词自动进速背（变更 84）。依赖从外面注入：词典、常见词表、AI 都是假的。
//
// 守的是：没对齐的课不跑、跑过的不再跑（且不为几个词反复问 AI）、词库里有的不重复加、
// 没中文的不进池、加进来的词带着课和句子（卡背要放原句）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME, META_KEYS } from '@/db/schema';
import { putMeta } from '@/db/meta';
import { normalizeKey } from '@/dict/bucket';
import type { DictLookup } from '@/dict/types';
import type { Lesson, Sentence } from '@/types/models';
import { harvestLesson, type HarvestDeps } from './harvest';
import { getDrillState } from './state';
import { customItemId } from './wordbank';

const DICT: Record<string, DictLookup> = {
  kaution: { entry: { w: 'Kaution', s: [{ p: 'noun', g: 'f', zh: ['押金'] }] }, via: 'exact' } as DictLookup,
  nebenkosten: { entry: { w: 'Nebenkosten', s: [{ p: 'noun' }] }, via: 'exact' } as DictLookup,
  vermieter: { entry: { w: 'Vermieter', s: [{ p: 'noun', g: 'm', zh: ['房东'] }] }, via: 'exact' } as DictLookup,
};

function sentence(index: number, text: string, timed = true): Sentence {
  return { index, text, charStart: 0, charEnd: text.length, endTimeExplicit: false, blanks: [], ...(timed ? { startTime: index } : {}) } as unknown as Sentence;
}

function lesson(id: string, timed = true): Lesson {
  return {
    id,
    title: id,
    sentences: [sentence(0, 'Die Kaution zahlt man vorher.', timed), sentence(1, 'Der Vermieter will Nebenkosten.', timed)],
  } as unknown as Lesson;
}

function deps(over: Partial<HarvestDeps> = {}): HarvestDeps {
  return {
    lookup: async (w) => DICT[normalizeKey(w)] ?? null,
    common: async () => ({ keys: new Set(['zahlen', 'wollen']), forms: new Set(['die', 'der', 'man', 'vorher', 'will', 'zahlt']) }),
    gloss: vi.fn(async (items: { word: string }[]) => items.map(() => '附加费')),
    aiAvailable: async () => true,
    knownWords: [],
    ...over,
  };
}

beforeEach(async () => {
  // 词库里有 Vermieter：课程里碰到它不另加手动词
  await putMeta(META_KEYS.drillWordbank, {
    version: 't',
    fetchedAt: 0,
    items: [{ id: 'vermieter', w: 'Vermieter', p: 'noun', g: 'm', zh: '房东', t: 'wohnen' }],
  });
});

afterEach(async () => {
  const db = await getDB();
  db.close();
  _resetDBForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe('harvestLesson', () => {
  it('词典有中文的直接收；缺中文的问 AI 按原句补；词库里有的不另加；都挂上课和句子', async () => {
    const d = deps();
    expect(await harvestLesson(lesson('L1'), [], d, 100)).toEqual({ status: 'done', added: 2 });
    const { custom } = await getDrillState();
    expect(custom[customItemId('Kaution')]).toMatchObject({ zh: '押金', p: 'noun', g: 'f', src: 'lesson', lessonId: 'L1', si: 0 });
    expect(custom[customItemId('Nebenkosten')]).toMatchObject({ zh: '附加费', src: 'lesson', si: 1 });
    expect(custom[customItemId('Vermieter')]).toBeUndefined();
    expect(d.gloss).toHaveBeenCalledWith([{ word: 'Nebenkosten', context: 'Der Vermieter will Nebenkosten.' }]);
  });

  it('同一课跑第二遍：skipped，也不再问 AI', async () => {
    await harvestLesson(lesson('L1'), [], deps(), 100);
    const again = deps();
    expect(await harvestLesson(lesson('L1'), [], again, 200)).toEqual({ status: 'skipped' });
    expect(again.gloss).not.toHaveBeenCalled();
  });

  it('没对齐的课：skipped 且不记「跑过了」—— 对齐之后还要再跑', async () => {
    expect(await harvestLesson(lesson('L2', false), [], deps(), 100)).toEqual({ status: 'skipped' });
    expect(await harvestLesson(lesson('L2'), [], deps(), 200)).toEqual({ status: 'done', added: 2 });
  });

  it('常见词表没拿到（断网）：skipped，下次再试', async () => {
    const offline = deps({ common: async () => ({ keys: new Set(), forms: new Set() }) });
    expect(await harvestLesson(lesson('L3'), [], offline, 100)).toEqual({ status: 'skipped' });
    expect((await harvestLesson(lesson('L3'), [], deps(), 200)).status).toBe('done');
  });

  it('没配 AI：缺中文的这次不进池，不去问', async () => {
    const d = deps({ aiAvailable: async () => false });
    expect(await harvestLesson(lesson('L4'), [], d, 100)).toEqual({ status: 'done', added: 1 });
    expect(d.gloss).not.toHaveBeenCalled();
  });

  it('AI 出错：缺中文的这次不进池，但整课记「跑过了」—— 不为几个词每次打开都再问', async () => {
    const failing = deps({ gloss: vi.fn(async () => Promise.reject(new Error('502'))) });
    expect(await harvestLesson(lesson('L5'), [], failing, 100)).toEqual({ status: 'done', added: 1 });
    expect((await getDrillState()).custom[customItemId('Nebenkosten')]).toBeUndefined();
    expect(await harvestLesson(lesson('L5'), [], deps(), 200)).toEqual({ status: 'skipped' });
  });

  it('标过认识的、已经手动加过的不再收', async () => {
    expect(await harvestLesson(lesson('L6'), ['kaution', 'nebenkosten'], deps({ knownWords: ['kaution', 'nebenkosten'] }), 100)).toEqual({
      status: 'done',
      added: 0,
    });
  });
});
