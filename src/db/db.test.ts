import { afterEach, describe, expect, it } from 'vitest';
import { getDB, _resetDBForTests, initStoragePersistence, getStorageEstimate } from './index';
import { putLesson, getLesson, getAllLessons, deleteLesson } from './lessons';
import {
  putVocabEntry,
  getVocabEntriesByLesson,
  findVocabEntriesBySurface,
} from './vocab';
import { putLessonCache, getLessonCache, putAudioBlob, hasCachedAudio, deleteLessonCache } from './cache';
import { getSettings, putSettings, getMeta, putMeta } from './meta';
import { DB_NAME } from './schema';
import type { Lesson, VocabEntry } from '@/types/models';

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

function makeLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: 'lesson-1',
    title: 'Testlektion',
    source: { type: 'manual' },
    sentences: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeVocab(overrides: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id: 'vocab-1',
    surface: 'Beispiel',
    contextSentence: 'Das ist ein Beispiel.',
    lessonId: 'lesson-1',
    sentenceIndex: 0,
    hasTimestamp: false,
    suspended: false,
    fsrs: {
      due: Date.now(),
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: 0,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('lessons store', () => {
  it('round-trips a Lesson', async () => {
    await putLesson(makeLesson());
    const loaded = await getLesson('lesson-1');
    expect(loaded?.title).toBe('Testlektion');
  });

  it('lists all lessons', async () => {
    await putLesson(makeLesson({ id: 'a' }));
    await putLesson(makeLesson({ id: 'b' }));
    const all = await getAllLessons();
    expect(all.map((l) => l.id).sort()).toEqual(['a', 'b']);
  });

  it('deletes a lesson', async () => {
    await putLesson(makeLesson());
    await deleteLesson('lesson-1');
    expect(await getLesson('lesson-1')).toBeUndefined();
  });
});

describe('vocab store', () => {
  it('indexes by lessonId', async () => {
    await putVocabEntry(makeVocab({ id: 'v1', lessonId: 'lesson-1' }));
    await putVocabEntry(makeVocab({ id: 'v2', lessonId: 'lesson-2' }));
    const forLesson1 = await getVocabEntriesByLesson('lesson-1');
    expect(forLesson1.map((v) => v.id)).toEqual(['v1']);
  });

  it('finds by surface case-insensitively (FR-9.3)', async () => {
    await putVocabEntry(makeVocab({ id: 'v1', surface: 'Wald' }));
    const matches = await findVocabEntriesBySurface('wald');
    expect(matches).toHaveLength(1);
  });
});

describe('lessonCache + audioBlobs stores (§2.3)', () => {
  it('round-trips cache metadata and audio blob separately', async () => {
    await putLessonCache({
      lessonId: 'lesson-1',
      plainText: 'Hallo Welt.',
      hasAudio: true,
      audioBytes: 3,
      fetchedAt: Date.now(),
    });
    await putAudioBlob('lesson-1', new Blob(['abc']));

    expect(await hasCachedAudio('lesson-1')).toBe(true);
    const cache = await getLessonCache('lesson-1');
    expect(cache?.plainText).toBe('Hallo Welt.');
  });

  it('deleteLessonCache removes both cache metadata and blob (R-缓存-3)', async () => {
    await putLessonCache({ lessonId: 'lesson-1', hasAudio: true, audioBytes: 3, fetchedAt: 1 });
    await putAudioBlob('lesson-1', new Blob(['abc']));

    await deleteLessonCache('lesson-1');

    expect(await getLessonCache('lesson-1')).toBeUndefined();
    expect(await hasCachedAudio('lesson-1')).toBe(false);
  });
});

describe('meta store', () => {
  it('returns defaults when settings unset', async () => {
    const settings = await getSettings();
    expect(settings.newPerDay).toBe(10);
    expect(settings.reviewPerDay).toBe(60);
  });

  it('persists settings overrides', async () => {
    const settings = await getSettings();
    await putSettings({ ...settings, newPerDay: 5 });
    expect((await getSettings()).newPerDay).toBe(5);
  });

  it('stores arbitrary keyed values (e.g. a GitHub token placeholder)', async () => {
    await putMeta('githubToken', 'ghp_fake');
    expect(await getMeta<string>('githubToken')).toBe('ghp_fake');
  });
});

describe('storage persistence (FR-11.16)', () => {
  it('does not throw when navigator.storage is unavailable, and records unsupported', async () => {
    const status = await initStoragePersistence();
    expect(status.unsupported).toBe(true);
    expect(status.persisted).toBe(false);
  });

  it('estimate() reports unsupported rather than throwing', async () => {
    const estimate = await getStorageEstimate();
    expect(estimate.unsupported).toBe(true);
  });
});
