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

describe('FR-21：读卡那一半也要进备份', () => {
  it('fsrsRead / examples / meaningZh 原样出现在备份里 —— 它们在标注层', async () => {
    await putVocabEntry({
      ...vocab,
      fsrsRead: { ...vocab.fsrs, state: 2, reps: 5, last_review: 1700 },
      examples: ['Der Vorhang fiel.'],
      meaningZh: '窗帘',
    });

    const [entry] = (await buildBackupJson()).vocab;

    // fsrsRead 是复习历史，不可重建 —— 漏掉它等于那一半的记忆曲线归零
    expect(entry.fsrsRead?.reps).toBe(5);
    // examples 看着像可重建（词典里就有），但拷进来之后它就是那张卡的一部分（§2.3）
    expect(entry.examples).toEqual(['Der Vorhang fiel.']);
    // 中译是人在外面翻好贴回来的，重建不出来
    expect(entry.meaningZh).toBe('窗帘');
  });

  it('走一趟真的 JSON 序列化也不掉字段（备份是文本文件，不是内存对象）', async () => {
    await putVocabEntry({ ...vocab, fsrsRead: { ...vocab.fsrs, reps: 2 }, meaningZh: '窗帘' });
    const roundTrip = JSON.parse(JSON.stringify(await buildBackupJson()));
    expect(roundTrip.vocab[0].fsrsRead.reps).toBe(2);
    expect(roundTrip.vocab[0].meaningZh).toBe('窗帘');
  });
});

describe('backupFileName', () => {
  it('formats as backup-YYYY-MM-DD.json', () => {
    expect(backupFileName(new Date(2026, 7, 31))).toBe('backup-2026-08-31.json');
  });
});
