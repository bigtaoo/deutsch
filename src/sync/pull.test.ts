// FR-11.19 的三个要点，每个都对应一种「跨设备静默出错」：
//
// ① 增量：版本号没变的文档一个字节都不拉。写错的症状不是数据错，而是每次启动、
//    每次回前台都把整个标注层重下一遍 —— 在弱网下就是「App 一打开就转半天」。
// ② 「拉」不等于「远端赢」：本地更新的那部分必须留住**并且回推**（§2.4）。
//    写错的症状是这个应用最要命的那一种：在手机上复习完，回桌面发现进度回退了。
// ③ 一个文档坏掉不能让整次拉取失败：几十课里有一份坏 JSON，别的课照样要能下来。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME, META_KEYS } from '@/db/schema';
import { getLesson, putLesson } from '@/db/lessons';
import { getAllVocabEntries, putVocabEntry } from '@/db/vocab';
import { DEFAULT_SETTINGS, getMeta, getSettings, putSettings } from '@/db/meta';
import { getKnownVersion, rememberVersion } from './docs';
import { SyncAuthError } from './client';
import type { Lesson, VocabEntry } from '@/types/models';

const getSessionToken = vi.fn<() => Promise<string | undefined>>();
vi.mock('./session', () => ({
  getSessionToken: () => getSessionToken(),
}));

const { pullFromServer } = await import('./pull');

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 按 URL 路由的 fetch 假件。这里刻意不用「按顺序返回」那一套：
 * 这条链路的关键正是**哪些 URL 被请求了**，顺序反而是实现细节。
 */
function routeFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // docId 里那个冒号在 URL 里是 %3A（docs.ts 用 encodeURIComponent 拼的）——
    // 解回来，好让下面的路由表照人读的样子写。
    const path = decodeURIComponent(new URL(url).pathname);
    const handler = routes[path];
    if (!handler) throw new Error(`测试里没有为 ${path} 准备响应`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestedPaths(fetchMock: ReturnType<typeof routeFetch>): string[] {
  return fetchMock.mock.calls.map(([input]) => decodeURIComponent(new URL(String(input)).pathname));
}

const DOC_LIST = '/v1/docs';

beforeEach(() => {
  getSessionToken.mockResolvedValue('tok');
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
  it('抛 SyncAuthError，一个请求都不发', async () => {
    getSessionToken.mockResolvedValue(undefined);
    const fetchMock = routeFetch({});
    await expect(pullFromServer()).rejects.toBeInstanceOf(SyncAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('增量', () => {
  it('版本号和本地记的一致 → 不拉全文，只有一次列表请求', async () => {
    await putLesson(lesson({ id: 'l1', updatedAt: 100 }));
    await rememberVersion('lesson:l1', 3);

    const fetchMock = routeFetch({
      [DOC_LIST]: () => json(200, { docs: [{ id: 'lesson:l1', version: 3, updatedAt: 1, bytes: 10 }] }),
    });

    const result = await pullFromServer();
    expect(requestedPaths(fetchMock)).toEqual([DOC_LIST]);
    expect(result.fetched).toBe(0);
    expect(result.checked).toBe(1);
  });

  it('版本号变了 → 拉全文', async () => {
    await putLesson(lesson({ id: 'l1', updatedAt: 100 }));
    await rememberVersion('lesson:l1', 3);

    const fetchMock = routeFetch({
      [DOC_LIST]: () => json(200, { docs: [{ id: 'lesson:l1', version: 4, updatedAt: 1, bytes: 10 }] }),
      '/v1/docs/lesson:l1': () =>
        json(200, { id: 'lesson:l1', version: 4, updatedAt: 1, body: lesson({ id: 'l1', title: '远端标题', updatedAt: 200 }) }),
    });

    const result = await pullFromServer();
    expect(requestedPaths(fetchMock)).toEqual([DOC_LIST, '/v1/docs/lesson:l1']);
    expect(result.fetched).toBe(1);
    expect((await getLesson('l1'))?.title).toBe('远端标题');
    expect(await getKnownVersion('lesson:l1')).toBe(4);
  });

  it('空设备（一个版本号都没记过）→ 全部拉下来', async () => {
    routeFetch({
      [DOC_LIST]: () =>
        json(200, {
          docs: [
            { id: 'lesson:l1', version: 1, updatedAt: 1, bytes: 10 },
            { id: 'vocab', version: 1, updatedAt: 1, bytes: 10 },
          ],
        }),
      '/v1/docs/lesson:l1': () =>
        json(200, { id: 'lesson:l1', version: 1, updatedAt: 1, body: lesson({ id: 'l1', updatedAt: 5 }) }),
      '/v1/docs/vocab': () =>
        json(200, { id: 'vocab', version: 1, updatedAt: 1, body: [vocab({ id: 'v1' })] }),
    });

    const result = await pullFromServer();
    expect(result.lessonsWritten).toBe(1);
    expect(result.vocabWritten).toBe(1);
    expect(await getLesson('l1')).toBeDefined();
    expect(await getAllVocabEntries()).toHaveLength(1);
  });
});

describe('合并（§2.4，「拉」不等于「远端赢」）', () => {
  it('本地那一课更新 → 不被覆盖，并且要求回推', async () => {
    await putLesson(lesson({ id: 'l1', title: '本地标题', updatedAt: 300 }));

    routeFetch({
      [DOC_LIST]: () => json(200, { docs: [{ id: 'lesson:l1', version: 9, updatedAt: 1, bytes: 10 }] }),
      '/v1/docs/lesson:l1': () =>
        json(200, { id: 'lesson:l1', version: 9, updatedAt: 1, body: lesson({ id: 'l1', title: '远端旧标题', updatedAt: 100 }) }),
    });

    const result = await pullFromServer();
    expect((await getLesson('l1'))?.title).toBe('本地标题');
    expect(result.lessonsWritten).toBe(0);
    expect(result.lessonsNeedPush).toEqual(['l1']);
    // 版本号照记：回推那一次要带着它，否则白撞一个 409。
    expect(await getKnownVersion('lesson:l1')).toBe(9);
  });

  it('生词逐条比 fsrs.last_review：远端赢的写回本地，本地赢的留着并要求回推', async () => {
    // v1：本地从没复习过，远端昨天复习过 → 远端赢。
    await putVocabEntry(vocab({ id: 'v1', updatedAt: 1 }));
    // v2：只有本地有 → 要回推，不能被这次拉取弄丢。
    await putVocabEntry(vocab({ id: 'v2', surface: 'nur-lokal', updatedAt: 1 }));

    const remoteV1 = vocab({ id: 'v1', surface: '远端', updatedAt: 50 });
    remoteV1.fsrs = { ...remoteV1.fsrs, last_review: 999, reps: 3 };

    routeFetch({
      [DOC_LIST]: () => json(200, { docs: [{ id: 'vocab', version: 2, updatedAt: 1, bytes: 10 }] }),
      '/v1/docs/vocab': () => json(200, { id: 'vocab', version: 2, updatedAt: 1, body: [remoteV1] }),
    });

    const result = await pullFromServer();
    const all = await getAllVocabEntries();
    expect(all.find((e) => e.id === 'v1')?.surface).toBe('远端');
    expect(all.find((e) => e.id === 'v2')?.surface).toBe('nur-lokal');
    expect(result.vocabWritten).toBe(1);
    expect(result.vocabNeedsPush).toBe(true);
  });

  it('设置整体比 updatedAt：远端更新就写进本地', async () => {
    await putSettings({ ...DEFAULT_SETTINGS, newPerDay: 10, updatedAt: 100 });

    routeFetch({
      [DOC_LIST]: () => json(200, { docs: [{ id: 'settings', version: 5, updatedAt: 1, bytes: 10 }] }),
      '/v1/docs/settings': () =>
        json(200, {
          id: 'settings',
          version: 5,
          updatedAt: 1,
          body: { ...DEFAULT_SETTINGS, newPerDay: 42, updatedAt: 200 },
        }),
    });

    const result = await pullFromServer();
    expect((await getSettings()).newPerDay).toBe(42);
    expect(result.settingsWritten).toBe(true);
    expect(result.settingsNeedsPush).toBe(false);
  });

  it('本地设置更新 → 不动本地，要求回推', async () => {
    await putSettings({ ...DEFAULT_SETTINGS, newPerDay: 7, updatedAt: 300 });

    routeFetch({
      [DOC_LIST]: () => json(200, { docs: [{ id: 'settings', version: 5, updatedAt: 1, bytes: 10 }] }),
      '/v1/docs/settings': () =>
        json(200, {
          id: 'settings',
          version: 5,
          updatedAt: 1,
          body: { ...DEFAULT_SETTINGS, newPerDay: 42, updatedAt: 100 },
        }),
    });

    const result = await pullFromServer();
    expect((await getSettings()).newPerDay).toBe(7);
    expect(result.settingsWritten).toBe(false);
    expect(result.settingsNeedsPush).toBe(true);
  });
});

describe('坏掉的文档', () => {
  it('一个 500 不影响别的文档，坏的记进 failures', async () => {
    routeFetch({
      [DOC_LIST]: () =>
        json(200, {
          docs: [
            { id: 'lesson:bad', version: 1, updatedAt: 1, bytes: 10 },
            { id: 'lesson:ok', version: 1, updatedAt: 1, bytes: 10 },
          ],
        }),
      '/v1/docs/lesson:bad': () => json(500, { code: 'boom' }),
      '/v1/docs/lesson:ok': () =>
        json(200, { id: 'lesson:ok', version: 1, updatedAt: 1, body: lesson({ id: 'ok', updatedAt: 5 }) }),
    });

    const result = await pullFromServer();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('lesson:bad');
    expect(await getLesson('ok')).toBeDefined();
  });

  it('远端 404（拉之前刚被别的设备删掉）→ 不算失败', async () => {
    routeFetch({
      [DOC_LIST]: () => json(200, { docs: [{ id: 'lesson:gone', version: 1, updatedAt: 1, bytes: 10 }] }),
      '/v1/docs/lesson:gone': () => json(404, { code: 'not_found' }),
    });

    const result = await pullFromServer();
    expect(result.failures).toHaveLength(0);
    expect(result.fetched).toBe(0);
  });
});

describe('状态可见性', () => {
  it('跑通之后记下「上次拉取」的时刻 —— 状态条靠它暴露「拉悄悄停了」', async () => {
    routeFetch({ [DOC_LIST]: () => json(200, { docs: [] }) });

    const before = Date.now();
    await pullFromServer();
    const persisted = await getMeta<{ lastPullAt?: number }>(META_KEYS.syncStatus);
    expect(persisted?.lastPullAt).toBeGreaterThanOrEqual(before);
  });
});
