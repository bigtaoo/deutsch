// 「空壳课」：只有文字、别的什么都没有的课 —— 本机没音频、服务器上也没有、一句没对齐、一个空没挖。
//
// 2026-09-27 他整本导入 Aspekte 时先不带音频导了一遍（37 课），再带音频导一遍，
// 列表里每题两门，一门能练、一门「素材未下载」。空壳删掉不丢任何东西，
// 所以：再导同一题时把音频**补进**那门空壳，而不是另起一门；已经成对的，组头给一键删掉空的那一半。

import type { Lesson, LessonCache } from '@/types/models';

export function isEmptyShell(lesson: Lesson, cache: LessonCache | undefined, vocabLessonIds: ReadonlySet<string> = new Set()): boolean {
  return (
    !cache?.hasAudio &&
    !lesson.audioRef &&
    !vocabLessonIds.has(lesson.id) &&
    lesson.sentences.every((s) => s.startTime === undefined && s.blanks.length === 0)
  );
}

/** 同一组、同名的另一门课已经有音频（本机或服务器上）的空壳 —— 删掉它们只少了重复。 */
export function emptyDuplicates(
  lessons: readonly Lesson[],
  caches: Readonly<Record<string, LessonCache | undefined>>,
  vocabLessonIds: ReadonlySet<string> = new Set(),
): Lesson[] {
  const withAudio = new Set(
    lessons.filter((l) => caches[l.id]?.hasAudio || l.audioRef).map((l) => `${l.collection ?? ''}\u0000${l.title}`),
  );
  return lessons.filter(
    (l) => isEmptyShell(l, caches[l.id], vocabLessonIds) && withAudio.has(`${l.collection ?? ''}\u0000${l.title}`),
  );
}
