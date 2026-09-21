import { afterEach, describe, expect, it } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import { putLesson } from '@/db/lessons';
import { getAllVocabEntries } from '@/db/vocab';
import { pendingReadCards } from '@/srs/queue';
import { getLesson } from '@/db/lessons';
import { prepareImport, commitImport, importBackup } from './import';
import { BACKUP_WARNING } from './export';
import type { BackupFile } from './types';
import type { Lesson } from '@/types/models';
import { DEFAULT_SETTINGS, getSettings, putSettings } from '@/db/meta';

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

describe('FR-21：早于识词卡的老备份', () => {
  it('没有 fsrsRead 的备份照常导入，恢复出来就是「读卡还没开」', async () => {
    const alt: BackupFile = {
      ...backupWith([]),
      vocab: [
        {
          id: 'v-alt',
          surface: 'Wort',
          meaning: 'ein Wort',
          hasTimestamp: false,
          suspended: false,
          fsrs: {
            due: 0, stability: 0, difficulty: 0, elapsed_days: 0,
            scheduled_days: 0, reps: 0, lapses: 0, state: 0,
          },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };

    const { result } = await prepareImport(alt);
    await commitImport(result);

    const [stored] = await getAllVocabEntries();
    expect(stored.fsrsRead).toBeUndefined();
    expect(stored.examples).toBeUndefined();
    // 「还没开」不需要额外的开关字段，也就不需要迁移 —— DB_VERSION 没动正是因为这个
    expect(pendingReadCards([stored])).toHaveLength(0); // 听卡还没进 Review
  });
});

describe('设置也走导入（§0 变更 28 补上的缺口）', () => {
  it('备份里的设置更新时写进本地 —— 以前只导出、从不导入', async () => {
    await putSettings({ ...DEFAULT_SETTINGS, newPerDay: 10, updatedAt: 100 });

    await importBackup({
      _warning: BACKUP_WARNING,
      formatVersion: 1,
      exportedAt: 0,
      lessons: [],
      vocab: [],
      settings: { ...DEFAULT_SETTINGS, newPerDay: 42, updatedAt: 200 },
    });

    expect((await getSettings()).newPerDay).toBe(42);
  });

  it('本地那份更新时一个字段都不动，也不刷新 updatedAt', async () => {
    await putSettings({ ...DEFAULT_SETTINGS, newPerDay: 10, updatedAt: 300 });

    const result = await importBackup({
      _warning: BACKUP_WARNING,
      formatVersion: 1,
      exportedAt: 0,
      lessons: [],
      vocab: [],
      settings: { ...DEFAULT_SETTINGS, newPerDay: 42, updatedAt: 200 },
    });

    expect(result.summary.settingsUpdated).toBe(false);
    const stored = await getSettings();
    expect(stored.newPerDay).toBe(10);
    expect(stored.updatedAt).toBe(300);
  });
});
