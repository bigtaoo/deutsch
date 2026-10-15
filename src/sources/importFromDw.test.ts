// 2026-09-27：从来源列表导进来的 DW 课记下来源名（collection），课程列表按它折叠。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson } from '@/types/models';

const putLesson = vi.fn(async (_l: Lesson) => {});
vi.mock('@/db/lessons', () => ({ putLesson: (l: Lesson) => putLesson(l) }));
vi.mock('@/db/cache', () => ({ getLessonCache: vi.fn(async () => undefined), putAudioBlob: vi.fn(async () => {}), putLessonCache: vi.fn(async () => {}) }));
vi.mock('@/sync/trigger', () => ({ scheduleLessonSync: vi.fn() }));
const saveLesson = vi.fn(async (_l: Lesson) => {});
vi.mock('@/state/useLessonStore', () => ({ useLessonStore: { getState: () => ({ load: async () => {}, saveLesson }) } }));
// 解码出来的时长：HLS 课补齐时比的就是它（变更 81）
vi.mock('@/audio/player', () => ({ readAudioDuration: async () => 199.13 }));

const PLAIN = {
  title: 'Der deutsche Wald',
  sourceUrl: 'https://learngerman.dw.com/de/l-1',
  plainText: 'Ein Satz.',
  manuscriptHtml: '<p>Ein Satz.</p>',
  spans: [],
  knowledges: [],
  audio: undefined as { mp3Src: string; duration: number } | undefined,
  speakers: undefined as string[] | undefined,
};
const HLS = 'https://hls.invalid/folge01.csmil/master.m3u8';
const fetchLesson = vi.fn(async () => PLAIN);
const downloadAudio = vi.fn(async () => new Blob([new Uint8Array(1000)], { type: 'audio/mpeg' }));
vi.mock('./dw/adapter', () => ({
  fetchLesson: () => fetchLesson(),
  downloadAudio: () => downloadAudio(),
  mapSpansToSentences: () => [],
}));

const { importFromDw, rehydrateLesson } = await import('./importLesson');

beforeEach(() => {
  putLesson.mockClear();
  saveLesson.mockClear();
  fetchLesson.mockImplementation(async () => PLAIN);
});

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

describe('视频课（变更 81）', () => {
  const JOJO = {
    ...PLAIN,
    title: '1 Die Ankunft',
    plainText: 'JOJO: Wow – das ist also Köln.\n\nREZA: Wohin soll es gehen?',
    audio: { mp3Src: HLS, duration: 199 },
    speakers: ['JOJO', 'REZA'],
  };

  it('标题带上季、句子带上说话人、音频地址记的是 m3u8', async () => {
    fetchLesson.mockImplementation(async () => JOJO);
    await importFromDw('1', undefined, undefined, 'DW Jojo sucht das Glück', 'Staffel 1');
    const lesson = putLesson.mock.calls[0][0];
    expect(lesson.title).toBe('Staffel 1 · 1 Die Ankunft');
    expect(lesson.collection).toBe('DW Jojo sucht das Glück');
    expect(lesson.speakers).toEqual(['JOJO', 'REZA']);
    expect(lesson.sentences.map((s) => [s.speaker, s.text])).toEqual([
      ['JOJO', 'Wow – das ist also Köln.'],
      ['REZA', 'Wohin soll es gehen?'],
    ]);
    expect(lesson.audioSrc).toBe(HLS);
  });

  it('补齐素材：转码出来的字节数和上次不同也**不算**换过音频，时长对得上就行', async () => {
    fetchLesson.mockImplementation(async () => JOJO);
    const lesson = { id: 'x', title: 't', source: { type: 'dw', dwLessonId: '1' }, audioSrc: HLS, audioBytes: 1593051, audioDuration: 199.1, sentences: [], glossary: [], createdAt: 0, updatedAt: 0 } as unknown as Lesson;
    const out = await rehydrateLesson(lesson);
    expect(out.audioRestored).toBe(true);
    expect(out.audioChanged).toBe(false);
    expect(saveLesson.mock.calls[0][0].audioDuration).toBe(199.1);
  });

  it('同样的字节差放在 mp3 直链的课上仍然判成换过（原来的判据不受影响）', async () => {
    fetchLesson.mockImplementation(async () => ({ ...JOJO, audio: { mp3Src: 'https://cdn.invalid/a.mp3', duration: 199 } }));
    const lesson = { id: 'x', title: 't', source: { type: 'dw', dwLessonId: '1' }, audioSrc: 'https://cdn.invalid/a.mp3', audioBytes: 1593051, audioDuration: 199.1, sentences: [], glossary: [], createdAt: 0, updatedAt: 0 } as unknown as Lesson;
    expect((await rehydrateLesson(lesson)).audioChanged).toBe(true);
  });
});
