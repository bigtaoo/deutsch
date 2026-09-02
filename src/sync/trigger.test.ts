// 这个文件测的是同步链路上最容易出事的那一段：**409 之后发生了什么**。
//
// 「绝不静默覆盖」（FR-11.8）不是一句口号，它是一段有分支的代码：vocab 要逐条比
// fsrs.last_review 合并再重推，课程与设置要整体比 updatedAt 决定谁让位。写错任何一支，
// 症状都是「在手机上复习完，回桌面发现进度回退了」—— 而且没有任何报错。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import { getAllVocabEntries, putVocabEntry } from '@/db/vocab';
import { DEFAULT_SETTINGS, getSettings, putSettings } from '@/db/meta';
import { getLesson, putLesson } from '@/db/lessons';
import { getQueue } from './queue';
import { getKnownVersion } from './docs';
import type { Lesson, VocabEntry } from '@/types/models';

const getSessionToken = vi.fn<() => Promise<string | undefined>>();
vi.mock('./session', () => ({
  getSessionToken: () => getSessionToken(),
}));

const { syncVocabNow, syncLessonDeletion, drainSyncQueue, setSyncHooks } = await import('./trigger');

function vocab(overrides: Partial<VocabEntry>): VocabEntry {
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
    updatedAt: 0,
    ...overrides,
  };
}

function lesson(overrides: Partial<Lesson>): Lesson {
  return {
    id: 'l1',
    title: '本地标题',
    source: { type: 'manual' },
    sentences: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 依次返回排好的响应；用完之后再有请求就是测试写错了。 */
function respondWith(...responses: Response[]) {
  const queue = [...responses];
  const fetchMock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('没有预备更多响应了');
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof respondWith>, callIndex: number): { baseVersion: number | null; body: unknown } {
  const [, init] = fetchMock.mock.calls[callIndex] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  getSessionToken.mockResolvedValue('tok');
  setSyncHooks({});
});

afterEach(async () => {
  vi.unstubAllGlobals();
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

describe('未登录', () => {
  it('什么都不发，也不排队 —— 一个永远推不出去的队列只会让待推送数无意义地涨', async () => {
    getSessionToken.mockResolvedValue(undefined);
    const fetchMock = respondWith();
    await syncVocabNow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getQueue()).toHaveLength(0);
  });
});

describe('vocab 推送', () => {
  it('成功后记下远端版本号，下次推送带着它', async () => {
    await putVocabEntry(vocab({ id: 'v1' }));
    const fetchMock = respondWith(
      jsonResponse(200, { version: 1, updatedAt: 1 }),
      jsonResponse(200, { version: 2, updatedAt: 2 }),
    );

    await syncVocabNow();
    expect(await getKnownVersion('vocab')).toBe(1);
    expect(bodyOf(fetchMock, 0).baseVersion).toBeNull();

    await syncVocabNow();
    expect(bodyOf(fetchMock, 1).baseVersion).toBe(1);
    expect(await getKnownVersion('vocab')).toBe(2);
  });

  it('409 → 按 fsrs.last_review 合并 → 远端赢的条目写回本地 → 用远端版本号重推', async () => {
    // 本地这条从没复习过；远端那条昨天刚复习过 —— 远端应该赢。
    await putVocabEntry(vocab({ id: 'v1', updatedAt: 5 }));
    const remoteEntry = vocab({ id: 'v1', surface: 'Wort', updatedAt: 50 });
    remoteEntry.fsrs = { ...remoteEntry.fsrs, last_review: 999, reps: 3 };

    const fetchMock = respondWith(
      jsonResponse(409, { code: 'conflict', version: 7, body: [remoteEntry] }),
      jsonResponse(200, { version: 8, updatedAt: 9 }),
    );

    await syncVocabNow();

    // 本地被远端那条覆盖了
    const local = await getAllVocabEntries();
    expect(local).toHaveLength(1);
    expect(local[0].fsrs.reps).toBe(3);

    // 重推用的是远端版本号，推的是合并结果
    const second = bodyOf(fetchMock, 1);
    expect(second.baseVersion).toBe(7);
    expect((second.body as VocabEntry[])[0].fsrs.reps).toBe(3);
    expect(await getKnownVersion('vocab')).toBe(8);
  });

  it('409 时本地更新的条目不会被远端旧值盖掉，而且会推上去', async () => {
    const localEntry = vocab({ id: 'v1', updatedAt: 100 });
    localEntry.fsrs = { ...localEntry.fsrs, last_review: 500, reps: 9 };
    await putVocabEntry(localEntry);

    const remoteEntry = vocab({ id: 'v1', updatedAt: 10 });
    remoteEntry.fsrs = { ...remoteEntry.fsrs, last_review: 1, reps: 1 };

    const fetchMock = respondWith(
      jsonResponse(409, { code: 'conflict', version: 3, body: [remoteEntry] }),
      jsonResponse(200, { version: 4, updatedAt: 9 }),
    );

    await syncVocabNow();

    expect((await getAllVocabEntries())[0].fsrs.reps).toBe(9);
    expect((bodyOf(fetchMock, 1).body as VocabEntry[])[0].fsrs.reps).toBe(9);
  });

  it('409 里远端多出来的生词会被并进本地库（另一台设备新加的词）', async () => {
    await putVocabEntry(vocab({ id: 'mine' }));
    const fetchMock = respondWith(
      jsonResponse(409, { code: 'conflict', version: 1, body: [vocab({ id: 'theirs' })] }),
      jsonResponse(200, { version: 2, updatedAt: 9 }),
    );

    const onRemoteDataWritten = vi.fn();
    setSyncHooks({ onRemoteDataWritten });

    await syncVocabNow();

    expect((await getAllVocabEntries()).map((e) => e.id).sort()).toEqual(['mine', 'theirs']);
    expect(onRemoteDataWritten).toHaveBeenCalled();
    expect((bodyOf(fetchMock, 1).body as VocabEntry[]).map((e) => e.id).sort()).toEqual([
      'mine',
      'theirs',
    ]);
  });
});

describe('课程推送', () => {
  it('409 且远端更新 → 接受远端、不再回推', async () => {
    await putLesson(lesson({ id: 'l1', title: '本地标题', updatedAt: 10 }));
    const remote = lesson({ id: 'l1', title: '远端标题', updatedAt: 999 });
    const fetchMock = respondWith(jsonResponse(409, { code: 'conflict', version: 4, body: remote }));

    // 走队列这条路调 pushLesson（scheduleLessonSync 有 30s 去抖，测试里不等它）
    const { enqueuePush } = await import('./queue');
    await enqueuePush('lesson', 'l1');
    await drainSyncQueue();

    expect((await getLesson('l1'))?.title).toBe('远端标题');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 没有第二次 PUT
    expect(await getKnownVersion('lesson:l1')).toBe(4);
  });

  it('409 但本地更新 → 用远端版本号把本地推上去', async () => {
    await putLesson(lesson({ id: 'l1', title: '本地标题', updatedAt: 999 }));
    const remote = lesson({ id: 'l1', title: '远端标题', updatedAt: 10 });
    const fetchMock = respondWith(
      jsonResponse(409, { code: 'conflict', version: 4, body: remote }),
      jsonResponse(200, { version: 5, updatedAt: 9 }),
    );

    const { enqueuePush } = await import('./queue');
    await enqueuePush('lesson', 'l1');
    await drainSyncQueue();

    expect((await getLesson('l1'))?.title).toBe('本地标题');
    expect(bodyOf(fetchMock, 1).baseVersion).toBe(4);
    expect(await getKnownVersion('lesson:l1')).toBe(5);
  });

  it('删课会发 DELETE，并把本地记的版本号一起忘掉', async () => {
    await putLesson(lesson({ id: 'l1' }));
    const fetchMock = respondWith(
      jsonResponse(200, { version: 1, updatedAt: 1 }),
      jsonResponse(200, { deleted: true }),
    );

    const { enqueuePush } = await import('./queue');
    await enqueuePush('lesson', 'l1');
    await drainSyncQueue();
    expect(await getKnownVersion('lesson:l1')).toBe(1);

    await syncLessonDeletion('l1');
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(await getKnownVersion('lesson:l1')).toBeNull();
  });
});

describe('失败与重试（FR-11.10）', () => {
  it('网络断了 → 进队列；恢复后 drain 一次就推出去并出队', async () => {
    await putVocabEntry(vocab({ id: 'v1' }));

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await syncVocabNow();
    expect(await getQueue()).toHaveLength(1);

    respondWith(jsonResponse(200, { version: 1, updatedAt: 1 }));
    await drainSyncQueue();
    expect(await getQueue()).toHaveLength(0);
  });

  it('401 → 排队 + 通知 UI 会话失效（不能默默重试，重试一万次也是 401）', async () => {
    await putVocabEntry(vocab({ id: 'v1' }));
    respondWith(jsonResponse(401, { error: '会话已过期，请重新登录' }));

    const onSessionExpired = vi.fn();
    setSyncHooks({ onSessionExpired });

    await syncVocabNow();

    expect(onSessionExpired).toHaveBeenCalled();
    expect(await getQueue()).toHaveLength(1);
  });
});

describe('设置推送（§0 变更 28）', () => {
  it('成功后记下远端版本号', async () => {
    await putSettings({ ...DEFAULT_SETTINGS, newPerDay: 25, updatedAt: 100 });
    const fetchMock = respondWith(jsonResponse(200, { version: 1, updatedAt: 9 }));

    const { enqueuePush } = await import('./queue');
    await enqueuePush('settings');
    await drainSyncQueue();

    expect(bodyOf(fetchMock, 0).body).toMatchObject({ newPerDay: 25, updatedAt: 100 });
    expect(await getKnownVersion('settings')).toBe(1);
  });

  it('409 且远端更新 → 写回本地，并用远端版本号重推', async () => {
    await putSettings({ ...DEFAULT_SETTINGS, newPerDay: 10, updatedAt: 10 });
    const remote = { ...DEFAULT_SETTINGS, newPerDay: 42, updatedAt: 999 };
    const fetchMock = respondWith(
      jsonResponse(409, { code: 'conflict', version: 4, body: remote }),
      jsonResponse(200, { version: 5, updatedAt: 9 }),
    );

    const { enqueuePush } = await import('./queue');
    await enqueuePush('settings');
    await drainSyncQueue();

    expect((await getSettings()).newPerDay).toBe(42);
    expect(bodyOf(fetchMock, 1)).toMatchObject({ baseVersion: 4 });
    expect(await getKnownVersion('settings')).toBe(5);
  });

  it('409 但本地更新 → 本地那份原样推上去，不被远端旧值盖掉', async () => {
    await putSettings({ ...DEFAULT_SETTINGS, newPerDay: 10, updatedAt: 999 });
    const remote = { ...DEFAULT_SETTINGS, newPerDay: 42, updatedAt: 10 };
    const fetchMock = respondWith(
      jsonResponse(409, { code: 'conflict', version: 4, body: remote }),
      jsonResponse(200, { version: 5, updatedAt: 9 }),
    );

    const { enqueuePush } = await import('./queue');
    await enqueuePush('settings');
    await drainSyncQueue();

    expect((await getSettings()).newPerDay).toBe(10);
    expect(bodyOf(fetchMock, 1).body).toMatchObject({ newPerDay: 10 });
  });
});
