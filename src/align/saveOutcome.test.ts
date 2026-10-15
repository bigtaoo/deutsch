// 变更 82：对齐写回以**现在**的那份课为底，不抹掉对齐期间写进去的译文。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLessonStore } from '@/state/useLessonStore';
import type { Lesson, Sentence } from '@/types/models';
import type { AlignOutcome } from './align';

const { saveOutcome } = await import('./client');

const sentence = (index: number, text: string, extra: Partial<Sentence> = {}): Sentence =>
  ({ index, text, ...extra }) as Sentence;
const lesson = (sentences: Sentence[]): Lesson =>
  ({ id: 'L', title: 't', source: { type: 'dw', dwLessonId: '1', sourceUrl: '' }, sentences, createdAt: 0, updatedAt: 0 }) as Lesson;
const outcome = {
  sentences: [
    { index: 0, start: 1, end: 2, confidence: -0.01 },
    { index: 1, start: 2, end: 3, confidence: -0.01 },
  ],
  words: [],
  duration: 3,
} as unknown as AlignOutcome;

const saveLesson = vi.fn(async (_l: Lesson) => {});
beforeEach(() => {
  saveLesson.mockClear();
});

describe('saveOutcome', () => {
  it('对齐期间写进去的译文留着，时间戳照样写上', async () => {
    const snapshot = lesson([sentence(0, 'Hallo.'), sentence(1, 'Tschüss.')]);
    const latest = lesson([sentence(0, 'Hallo.', { translation: '你好。' }), sentence(1, 'Tschüss.', { translation: '再见。' })]);
    useLessonStore.setState({ lessons: [latest], saveLesson } as never);
    await saveOutcome(snapshot, outcome, {}, () => {});
    const saved = saveLesson.mock.calls[0][0];
    expect(saved.sentences.map((s) => s.translation)).toEqual(['你好。', '再见。']);
    expect(saved.sentences.every((s) => (s.startTime ?? 0) > 0)).toBe(true);
  });

  it('句子在这期间被拆过/改过字：退回快照（时间戳是按快照的句子算的）', async () => {
    const snapshot = lesson([sentence(0, 'Hallo.'), sentence(1, 'Tschüss.')]);
    const latest = lesson([sentence(0, 'Hallo!', { translation: '你好！' }), sentence(1, 'Tschüss.')]);
    useLessonStore.setState({ lessons: [latest], saveLesson } as never);
    await saveOutcome(snapshot, outcome, {}, () => {});
    const saved = saveLesson.mock.calls[0][0];
    expect(saved.sentences[0].text).toBe('Hallo.');
    expect(saved.sentences[0].translation).toBeUndefined();
  });
});
