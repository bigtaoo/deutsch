import { afterEach, describe, expect, it } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import { putLesson } from '@/db/lessons';
import { putVocabEntry } from '@/db/vocab';
import { buildBackupJson, backupFileName, BACKUP_WARNING } from './export';
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

const lesson: Lesson = {
  id: 'l1',
  title: 'T',
  source: { type: 'manual' },
  sentences: [],
  createdAt: 0,
  updatedAt: 0,
};

const vocab: VocabEntry = {
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
};

describe('buildBackupJson', () => {
  it('includes the copyright warning and all lessons/vocab', async () => {
    await putLesson(lesson);
    await putVocabEntry(vocab);

    const backup = await buildBackupJson();

    expect(backup._warning).toBe(BACKUP_WARNING);
    expect(backup.formatVersion).toBe(1);
    expect(backup.lessons).toEqual([lesson]);
    expect(backup.vocab).toEqual([vocab]);
    expect(backup.settings.newPerDay).toBe(10);
  });

  it('never mentions cache-layer fields', async () => {
    await putLesson(lesson);
    const backup = await buildBackupJson();
    const json = JSON.stringify(backup);
    expect(json).not.toContain('manuscriptHtml');
    expect(json).not.toContain('audioBytes');
    expect(json).not.toContain('plainText');
  });
});

describe('backupFileName', () => {
  it('formats as backup-YYYY-MM-DD.json', () => {
    expect(backupFileName(new Date(2026, 7, 31))).toBe('backup-2026-08-31.json');
  });
});
