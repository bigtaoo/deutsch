// FR-11.13：一键从服务器恢复到空设备。
//
// §2.6.5 把它点名成「最容易悄悄坏掉的那条路」—— 平时没人走，等真需要时才发现不通。
// 那正好也是它最难被人工发现的地方，所以这里把四件事全钉住：
//
// ① 四种文档各自落到对的地方（课程 / 生词 / 设置 / 学习记录），认不出的整块跳过；
// ② 恢复走的是 §2.4 的合并规则，**不是清空后覆盖** —— 往一台有数据的设备上恢复
//    （把手机的复习进度拉回桌面）是正常用法，覆盖会把本地更新的那一半抹掉；
// ③ 单个文档坏掉不让整次恢复失败：几十课里有一份坏 JSON，别的课照样要落地；
// ④ 每拉到一份就记下它的版本号，否则恢复完的第一次推送必定撞 409。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import { getAllLessons, putLesson } from '@/db/lessons';
import { getAllVocabEntries, putVocabEntry } from '@/db/vocab';
import { DEFAULT_SETTINGS, getSettings, putSettings } from '@/db/meta';
import { getStudyLog, putStudyLog, type StudyLog } from '@/study/log';
import { SyncAuthError } from './client';
import type { Lesson, Settings, VocabEntry } from '@/types/models';
import type { RemoteDoc, RemoteDocMeta } from './docs';

const getSessionToken = vi.fn<() => Promise<string | undefined>>();
vi.mock('./session', () => ({ getSessionToken: () => getSessionToken() }));

/** 远端那一份：文档列表 + 每个 id 的内容。取不到时按 id 抛，用来演「单份坏掉」。 */
let remote: Record<string, RemoteDoc<unknown> | Error>;
const rememberVersion = vi.fn(async (_id: string, _v: number) => {});

vi.mock('./docs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./docs')>();
  return {
    ...actual,
    listRemoteDocs: vi.fn(
      async (): Promise<RemoteDocMeta[]> =>
        Object.keys(remote).map((id) => ({ id, version: 1, updatedAt: 0, bytes: 0 })),
    ),
    getRemoteDoc: vi.fn(async (_token: string, id: string) => {
      const doc = remote[id];
      if (doc instanceof Error) throw doc;
      return doc ?? null;
    }),
    rememberVersion: (id: string, v: number) => rememberVersion(id, v),
  };
});

const { restoreFromServer } = await import('./restore');

function doc<T>(id: string, body: T, version = 1): RemoteDoc<T> {
  return { id, version, updatedAt: 0, body };
}

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: 'l1',
    title: '远端标题',
    source: { type: 'manual' },
    sentences: [],
    createdAt: 0,
    updatedAt: 1000,
    ...overrides,
  };
}

function vocab(overrides: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id: 'v1',
    surface: 'Wort',
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
    updatedAt: 1000,
    ...overrides,
  };
}

function studyLog(days: StudyLog['days'], updatedAt = 1000): StudyLog {
  return { days, updatedAt };
}

beforeEach(() => {
  getSessionToken.mockResolvedValue('tok');
  remote = {};
});

afterEach(async () => {
  vi.clearAllMocks();
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

describe('前提', () => {
  it('没登录直接抛 SyncAuthError，不发任何请求', async () => {
    getSessionToken.mockResolvedValue(undefined);
    await expect(restoreFromServer()).rejects.toBeInstanceOf(SyncAuthError);
  });
});

describe('恢复到空设备', () => {
  it('四种文档各自落到对的地方', async () => {
    remote = {
      'lesson:l1': doc('lesson:l1', lesson()),
      'lesson:l2': doc('lesson:l2', lesson({ id: 'l2', title: '第二课' })),
      vocab: doc('vocab', [vocab(), vocab({ id: 'v2', surface: 'Zweites' })]),
      settings: doc('settings', { ...DEFAULT_SETTINGS, newPerDay: 42, updatedAt: 5000 } as Settings),
      study: doc('study', studyLog({ '2026-09-20': { 'dev-a': 600 } })),
    };

    const result = await restoreFromServer();

    expect(result.lessonsFetched).toBe(2);
    expect(result.vocabFetched).toBe(2);
    expect(result.settingsRestored).toBe(true);
    expect(result.studyRestored).toBe(true);
    expect(result.failures).toEqual([]);

    expect((await getAllLessons()).map((l) => l.id).sort()).toEqual(['l1', 'l2']);
    expect((await getAllVocabEntries()).map((v) => v.id).sort()).toEqual(['v1', 'v2']);
    expect((await getSettings()).newPerDay).toBe(42);
    expect((await getStudyLog()).days).toEqual({ '2026-09-20': { 'dev-a': 600 } });
  });

  it('每拉到一份都记下版本号 —— 不记的话恢复完第一次推送必撞 409', async () => {
    remote = {
      'lesson:l1': doc('lesson:l1', lesson(), 3),
      vocab: doc('vocab', [], 7),
      settings: doc('settings', DEFAULT_SETTINGS as Settings, 2),
      study: doc('study', studyLog({})),
    };
    await restoreFromServer();
    expect(rememberVersion).toHaveBeenCalledWith('lesson:l1', 3);
    expect(rememberVersion).toHaveBeenCalledWith('vocab', 7);
    expect(rememberVersion).toHaveBeenCalledWith('settings', 2);
  });

  it('认不出的文档类型整块跳过，连取都不取', async () => {
    const docs = await import('./docs');
    remote = { 'lesson:l1': doc('lesson:l1', lesson()), 'irgendwas:1': doc('irgendwas:1', {}) };
    const result = await restoreFromServer();
    expect(result.lessonsFetched).toBe(1);
    expect(result.failures).toEqual([]);
    expect(vi.mocked(docs.getRemoteDoc).mock.calls.map(([, id]) => id)).not.toContain('irgendwas:1');
  });

  it('远端空空如也时不抛，只是什么都没恢复', async () => {
    const result = await restoreFromServer();
    expect(result).toMatchObject({
      lessonsFetched: 0,
      vocabFetched: 0,
      settingsRestored: false,
      studyRestored: false,
      failures: [],
    });
  });
});

describe('恢复到一台已有数据的设备（§2.4 的合并规则，不是覆盖）', () => {
  it('本地更新的那一课留住，远端更新的那一课被覆盖', async () => {
    await putLesson(lesson({ id: 'l1', title: '本地更新过', updatedAt: 9999 }));
    await putLesson(lesson({ id: 'l2', title: '本地旧的', updatedAt: 1 }));
    remote = {
      'lesson:l1': doc('lesson:l1', lesson({ id: 'l1', title: '远端旧的', updatedAt: 1 })),
      'lesson:l2': doc('lesson:l2', lesson({ id: 'l2', title: '远端新的', updatedAt: 9999 })),
    };

    const result = await restoreFromServer();

    const byId = new Map((await getAllLessons()).map((l) => [l.id, l.title]));
    expect(byId.get('l1')).toBe('本地更新过');
    expect(byId.get('l2')).toBe('远端新的');
    expect(result.summary.skippedLessons).toContain('l1');
    expect(result.summary.updatedLessons).toContain('l2');
  });

  it('本地的生词不会因为远端没有就被删掉', async () => {
    await putVocabEntry(vocab({ id: 'nur-lokal' }));
    remote = { vocab: doc('vocab', [vocab({ id: 'v1' })]) };
    await restoreFromServer();
    expect((await getAllVocabEntries()).map((v) => v.id).sort()).toEqual(['nur-lokal', 'v1']);
  });

  it('本地那份设置更新时不写 —— settingsRestored 为 false', async () => {
    await putSettings({ ...DEFAULT_SETTINGS, newPerDay: 5, updatedAt: 9999 } as Settings);
    remote = {
      settings: doc('settings', { ...DEFAULT_SETTINGS, newPerDay: 99, updatedAt: 1 } as Settings),
    };
    const result = await restoreFromServer();
    expect(result.settingsRestored).toBe(false);
    expect((await getSettings()).newPerDay).toBe(5);
  });

  it('学习记录逐格取 max：两台设备同一天的秒数都留着', async () => {
    await putStudyLog(studyLog({ '2026-09-20': { 'dev-a': 900, 'dev-b': 10 } }));
    remote = {
      study: doc('study', studyLog({ '2026-09-20': { 'dev-a': 100, 'dev-b': 600 } })),
    };
    const result = await restoreFromServer();
    expect(result.studyRestored).toBe(true);
    expect((await getStudyLog()).days['2026-09-20']).toEqual({ 'dev-a': 900, 'dev-b': 600 });
  });

  it('远端的学习记录没带来新东西时不写库', async () => {
    await putStudyLog(studyLog({ '2026-09-20': { 'dev-a': 900 } }));
    remote = { study: doc('study', studyLog({ '2026-09-20': { 'dev-a': 100 } })) };
    expect((await restoreFromServer()).studyRestored).toBe(false);
  });

  it('远端的 study 文档形状不对（没有 days）时整块忽略，不炸也不清空本地', async () => {
    await putStudyLog(studyLog({ '2026-09-20': { 'dev-a': 900 } }));
    remote = { study: doc('study', { updatedAt: 1 }) };
    const result = await restoreFromServer();
    expect(result.studyRestored).toBe(false);
    expect((await getStudyLog()).days['2026-09-20']).toEqual({ 'dev-a': 900 });
  });
});

describe('单份坏掉', () => {
  it('坏的那份记进 failures，好的那些照常写进库', async () => {
    remote = {
      'lesson:l1': doc('lesson:l1', lesson({ id: 'l1' })),
      'lesson:kaputt': new Error('JSON 解析失败'),
      'lesson:l3': doc('lesson:l3', lesson({ id: 'l3' })),
      vocab: doc('vocab', [vocab()]),
    };

    const result = await restoreFromServer();

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('lesson:kaputt');
    expect(result.failures[0]).toContain('JSON 解析失败');
    expect((await getAllLessons()).map((l) => l.id).sort()).toEqual(['l1', 'l3']);
    expect(await getAllVocabEntries()).toHaveLength(1);
  });

  it('生词那一份坏掉时课程照样恢复 —— 不是全有或全无', async () => {
    remote = {
      vocab: new Error('超时'),
      'lesson:l1': doc('lesson:l1', lesson()),
    };
    const result = await restoreFromServer();
    expect(result.vocabFetched).toBe(0);
    expect(result.lessonsFetched).toBe(1);
    expect(await getAllLessons()).toHaveLength(1);
  });
});
