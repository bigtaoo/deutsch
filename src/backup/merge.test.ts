import { describe, expect, it } from 'vitest';
import { mergeBackup, mergeLessons, mergeVocabEntries } from './merge';
import type { Lesson, VocabEntry } from '@/types/models';

function lesson(overrides: Partial<Lesson>): Lesson {
  return {
    id: 'l1',
    title: 'Local Title',
    source: { type: 'manual' },
    sentences: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function vocab(overrides: Partial<VocabEntry>): VocabEntry {
  return {
    id: 'v1',
    surface: 'Wort',
    contextSentence: 'Ein Wort.',
    lessonId: 'l1',
    sentenceIndex: 0,
    hasTimestamp: false,
    suspended: false,
    fsrs: {
      due: 0,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: 0,
    },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('mergeLessons', () => {
  it('adds a lesson that only exists in incoming', () => {
    const { merged, summary } = mergeLessons([], [lesson({ id: 'new' })]);
    expect(merged.map((l) => l.id)).toEqual(['new']);
    expect(summary.addedLessons).toEqual(['new']);
  });

  it('keeps local when local is newer, and records it as skipped', () => {
    const local = lesson({ id: 'l1', updatedAt: 100, title: 'Newer local' });
    const incoming = lesson({ id: 'l1', updatedAt: 50, title: 'Older incoming' });
    const { merged, summary } = mergeLessons([local], [incoming]);
    expect(merged[0].title).toBe('Newer local');
    expect(summary.skippedLessons).toEqual(['l1']);
    expect(summary.updatedLessons).toEqual([]);
  });

  it('overwrites local when incoming is newer, and names the overwritten title', () => {
    const local = lesson({ id: 'l1', updatedAt: 50, title: 'Old local title' });
    const incoming = lesson({ id: 'l1', updatedAt: 100, title: 'New incoming title' });
    const { merged, summary } = mergeLessons([local], [incoming]);
    expect(merged[0].title).toBe('New incoming title');
    expect(summary.updatedLessons).toEqual(['l1']);
    expect(summary.overwrittenLessonTitles).toEqual(['Old local title']);
  });

  it('leaves lessons that only exist locally untouched', () => {
    const localOnly = lesson({ id: 'local-only' });
    const { merged, summary } = mergeLessons([localOnly], []);
    expect(merged).toEqual([localOnly]);
    expect(summary.addedLessons).toEqual([]);
    expect(summary.updatedLessons).toEqual([]);
    expect(summary.skippedLessons).toEqual([]);
  });
});

describe('mergeVocabEntries', () => {
  it('adds a vocab entry that only exists in incoming', () => {
    const { merged, summary } = mergeVocabEntries([], [vocab({ id: 'new' })]);
    expect(merged.map((v) => v.id)).toEqual(['new']);
    expect(summary.addedVocab).toEqual(['new']);
  });

  it('picks the entry with the newer fsrs.last_review, not the newer updatedAt', () => {
    const local = vocab({
      id: 'v1',
      updatedAt: 9999, // 故意让 updatedAt 更新但 last_review 更旧
      fsrs: { ...vocab({}).fsrs, last_review: 10 },
    });
    const incoming = vocab({
      id: 'v1',
      updatedAt: 1,
      fsrs: { ...vocab({}).fsrs, last_review: 20 },
    });
    const { merged, summary } = mergeVocabEntries([local], [incoming]);
    expect(merged[0].fsrs.last_review).toBe(20);
    expect(summary.updatedVocab).toEqual(['v1']);
  });

  it('keeps local when local last_review is newer', () => {
    const local = vocab({ id: 'v1', fsrs: { ...vocab({}).fsrs, last_review: 20 } });
    const incoming = vocab({ id: 'v1', fsrs: { ...vocab({}).fsrs, last_review: 10 } });
    const { merged, summary } = mergeVocabEntries([local], [incoming]);
    expect(merged[0].fsrs.last_review).toBe(20);
    expect(summary.skippedVocab).toEqual(['v1']);
  });

  it('treats missing last_review on both sides as a tie and breaks it via updatedAt', () => {
    const local = vocab({ id: 'v1', updatedAt: 1 });
    const incoming = vocab({ id: 'v1', updatedAt: 2 });
    const { merged, summary } = mergeVocabEntries([local], [incoming]);
    expect(merged[0].updatedAt).toBe(2);
    expect(summary.updatedVocab).toEqual(['v1']);
  });
});

describe('mergeBackup', () => {
  it('combines lesson and vocab summaries into one report', () => {
    const local = { lessons: [lesson({ id: 'l1', updatedAt: 100 })], vocab: [] as VocabEntry[] };
    const incoming = {
      lessons: [lesson({ id: 'l2', updatedAt: 1 })],
      vocab: [vocab({ id: 'v1' })],
    };
    const { lessons, vocab: mergedVocab, summary } = mergeBackup(local, incoming);
    expect(lessons.map((l) => l.id).sort()).toEqual(['l1', 'l2']);
    expect(mergedVocab.map((v) => v.id)).toEqual(['v1']);
    expect(summary.addedLessons).toEqual(['l2']);
    expect(summary.addedVocab).toEqual(['v1']);
  });
});
