import { afterEach, describe, expect, it } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import { putLesson } from '@/db/lessons';
import { getLesson } from '@/db/lessons';
import { prepareImport, commitImport, importBackup } from './import';
import { BACKUP_WARNING } from './export';
import type { BackupFile } from './types';
import type { Lesson } from '@/types/models';
import { DEFAULT_SETTINGS } from '@/db/meta';

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

function backupWith(lessons: Lesson[]): BackupFile {
  return {
    _warning: BACKUP_WARNING,
    formatVersion: 1,
    exportedAt: 0,
    lessons,
    vocab: [],
    settings: DEFAULT_SETTINGS,
  };
}

describe('prepareImport / commitImport', () => {
  it('returns a pre-import safety snapshot of the current state', async () => {
    await putLesson({
      id: 'existing',
      title: 'Existing',
      source: { type: 'manual' },
      sentences: [],
      createdAt: 0,
      updatedAt: 0,
    });

    const { safetySnapshot } = await prepareImport(backupWith([]));

    expect(safetySnapshot.lessons.map((l) => l.id)).toEqual(['existing']);
    expect(safetySnapshot._warning).toBe(BACKUP_WARNING);
  });

  it('does not write anything until commitImport is called', async () => {
    const incoming = backupWith([
      { id: 'new', title: 'New', source: { type: 'manual' }, sentences: [], createdAt: 0, updatedAt: 0 },
    ]);

    const { result } = await prepareImport(incoming);
    expect(await getLesson('new')).toBeUndefined();

    await commitImport(result);
    expect((await getLesson('new'))?.title).toBe('New');
  });
});

describe('importBackup (one-shot convenience)', () => {
  it('merges and writes in one call, applying §2.4 last-write-wins', async () => {
    await putLesson({
      id: 'l1',
      title: 'Old local',
      source: { type: 'manual' },
      sentences: [],
      createdAt: 0,
      updatedAt: 1,
    });

    const summary = await importBackup(
      backupWith([
        { id: 'l1', title: 'New from backup', source: { type: 'manual' }, sentences: [], createdAt: 0, updatedAt: 2 },
      ]),
    );

    expect(summary.summary.overwrittenLessonTitles).toEqual(['Old local']);
    expect((await getLesson('l1'))?.title).toBe('New from backup');
  });
});
