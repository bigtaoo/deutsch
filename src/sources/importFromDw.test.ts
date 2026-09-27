// 2026-09-27：从来源列表导进来的 DW 课记下来源名（collection），课程列表按它折叠。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson } from '@/types/models';

const putLesson = vi.fn(async (_l: Lesson) => {});
vi.mock('@/db/lessons', () => ({ putLesson: (l: Lesson) => putLesson(l) }));
vi.mock('@/db/cache', () => ({ getLessonCache: vi.fn(), putAudioBlob: vi.fn(async () => {}), putLessonCache: vi.fn(async () => {}) }));
vi.mock('@/sync/trigger', () => ({ scheduleLessonSync: vi.fn() }));
vi.mock('@/state/useLessonStore', () => ({ useLessonStore: { getState: () => ({ load: async () => {} }) } }));
vi.mock('./dw/adapter', () => ({
  fetchLesson: async () => ({
    title: 'Der deutsche Wald',
    sourceUrl: 'https://learngerman.dw.com/de/l-1',
    plainText: 'Ein Satz.',
    manuscriptHtml: '<p>Ein Satz.</p>',
    spans: [],
    knowledges: [],
    audio: undefined,
  }),
  downloadAudio: vi.fn(),
  mapSpansToSentences: () => [],
}));

const { importFromDw } = await import('./importLesson');

beforeEach(() => putLesson.mockClear());

describe('importFromDw 记来源', () => {
  it('从某个来源的列表导：collection = 来源名', async () => {
    await importFromDw('1', undefined, undefined, 'DW Top-Thema');
    expect(putLesson.mock.calls[0][0].collection).toBe('DW Top-Thema');
  });

  it('按 id 导（不知道是哪个系列）：不记，列表里归默认那一组', async () => {
    await importFromDw('1');
    expect(putLesson.mock.calls[0][0]).not.toHaveProperty('collection');
  });
});
