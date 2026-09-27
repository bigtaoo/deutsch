// 2026-09-27：整本导了两遍之后的空壳课 —— 什么算「删了不丢东西」。

import { describe, expect, it } from 'vitest';
import { emptyDuplicates, isEmptyShell } from './emptyShell';
import type { Lesson, LessonCache, Sentence } from '@/types/models';

function lesson(id: string, title: string, extra: Partial<Lesson> = {}): Lesson {
  return { id, title, collection: 'Aspekte', source: { type: 'manual' }, sentences: [], createdAt: 0, updatedAt: 0, ...extra };
}
const withAudio: LessonCache = { lessonId: 'x', hasAudio: true, audioBytes: 1, fetchedAt: 0 };
const sentence = (extra: Partial<Sentence>) => ({ index: 0, text: 'Satz.', blanks: [], ...extra }) as Sentence;

describe('isEmptyShell', () => {
  it('只有文字：是', () => {
    expect(isEmptyShell(lesson('a', 'T', { sentences: [sentence({})] }), undefined)).toBe(true);
  });
  it('本机有音频、服务器上有、对齐过、挖过空、有生词挂着：任何一样都不是', () => {
    expect(isEmptyShell(lesson('a', 'T'), withAudio)).toBe(false);
    expect(isEmptyShell(lesson('a', 'T', { audioRef: { sha256: 'h', bytes: 1 } }), undefined)).toBe(false);
    expect(isEmptyShell(lesson('a', 'T', { sentences: [sentence({ startTime: 1 })] }), undefined)).toBe(false);
    expect(isEmptyShell(lesson('a', 'T', { sentences: [sentence({ blanks: [{}] as never })] }), undefined)).toBe(false);
    expect(isEmptyShell(lesson('a', 'T'), undefined, new Set(['a']))).toBe(false);
  });
});

describe('emptyDuplicates', () => {
  it('同组同名、另一门有音频（本机或服务器）：空的那门算重复', () => {
    const lessons = [
      lesson('old1', 'K1 · A'),
      lesson('new1', 'K1 · A'),
      lesson('old2', 'K1 · B'),
      lesson('new2', 'K1 · B', { audioRef: { sha256: 'h', bytes: 1 } }),
    ];
    expect(emptyDuplicates(lessons, { new1: withAudio }).map((l) => l.id)).toEqual(['old1', 'old2']);
  });
  it('两门都是空壳：都不删（删哪门都不对，也没东西可练）；落单的空壳也不删', () => {
    const lessons = [lesson('a', 'K1 · A'), lesson('b', 'K1 · A'), lesson('c', 'K1 · C')];
    expect(emptyDuplicates(lessons, {})).toEqual([]);
  });
  it('同名但在别的组：不算', () => {
    const lessons = [lesson('a', 'K1 · A'), lesson('b', 'K1 · A', { collection: 'Anderes' })];
    expect(emptyDuplicates(lessons, { b: withAudio })).toEqual([]);
  });
  it('有生词挂在空壳上：留着', () => {
    const lessons = [lesson('a', 'K1 · A'), lesson('b', 'K1 · A')];
    expect(emptyDuplicates(lessons, { b: withAudio }, new Set(['a']))).toEqual([]);
  });
});
