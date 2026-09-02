import { describe, it, expect } from 'vitest';
import { migrateGlossaryIntoLessons } from './migrate';
import { getLesson, putLesson } from './lessons';
import type { GlossaryCandidate, Lesson, LessonCache } from '@/types/models';

// 每个用例用自己的 id，不清库 —— fake-indexeddb 是进程级的，而 deleteDatabase()
// 在还有连接开着时会一直挂着（getDB 的连接是单例，`_resetDBForTests` 只丢 promise 不关连接）。

/** 老库里的 LessonCache 还带着 glossary —— 类型上已经删了，测试里显式描述。 */
type LegacyCache = LessonCache & { glossary?: GlossaryCandidate[] };

function lesson(id: string, over: Partial<Lesson> = {}): Lesson {
  return {
    id,
    title: id,
    source: { type: 'dw', dwLessonId: '1', sourceUrl: 'https://example.invalid/l-1' },
    sentences: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function cache(lessonId: string, glossary?: GlossaryCandidate[]): LegacyCache {
  return { lessonId, glossary, hasAudio: false, audioBytes: 0, fetchedAt: 1 };
}

const CANDIDATE: GlossaryCandidate = {
  dwKnowledgeId: 'k1',
  sentenceIndex: 0,
  ranges: [{ start: 0, end: 5 }],
  surface: 'Wald',
  title: 'Wald, -er (m.)',
};

describe('migrateGlossaryIntoLessons（§0 变更 27）', () => {
  it('缓存层里的候选词搬进课程，并落库、报出改过哪几课', async () => {
    const stored = [lesson('m-1')];
    const result = await migrateGlossaryIntoLessons(stored, [cache('m-1', [CANDIDATE])]);
    expect(result.changed).toEqual(['m-1']);
    expect(result.lessons[0].glossary).toEqual([CANDIDATE]);
    // 必须落库：只改内存的话下次启动又要搬一遍
    expect((await getLesson('m-1'))?.glossary).toEqual([CANDIDATE]);
    // updatedAt 要动，否则同步那边比不出新旧，另一台设备的旧版本会赢回来
    expect(result.lessons[0].updatedAt).toBeGreaterThan(1);
  });

  it('幂等：课程里已经有 glossary 就不动，也不算改过', async () => {
    const already = lesson('m-2', { glossary: [] });
    await putLesson(already);
    const result = await migrateGlossaryIntoLessons([already], [cache('m-2', [CANDIDATE])]);
    expect(result.changed).toEqual([]);
    expect(result.lessons[0]).toBe(already);
  });

  it('缓存层没有候选词（手动导入的课、或缓存已清）时零写入', async () => {
    const stored = [lesson('m-3')];
    const result = await migrateGlossaryIntoLessons(stored, [cache('m-3'), cache('m-4', [])]);
    expect(result.changed).toEqual([]);
    // 引用不变 —— 调用方据此判断「什么都没发生」
    expect(result.lessons).toBe(stored);
    expect(await getLesson('m-3')).toBeUndefined();
  });

  it('一次能搬多课，只有真的搬过的才进 changed', async () => {
    const stored = [lesson('m-5'), lesson('m-6'), lesson('m-7', { glossary: [CANDIDATE] })];
    const result = await migrateGlossaryIntoLessons(stored, [
      cache('m-5', [CANDIDATE]),
      cache('m-6'),
      cache('m-7', [CANDIDATE]),
    ]);
    expect(result.changed).toEqual(['m-5']);
    expect(result.lessons[1].glossary).toBeUndefined();
  });
});
