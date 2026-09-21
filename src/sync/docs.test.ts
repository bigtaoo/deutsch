// 「文档」这一层做两件事：给每份数据一个稳定的 id，以及记住「我上次推完是第几版」。
//
// 第二件是乐观并发的**唯一**依据（它取代了 GitHub 方案里的文件 sha）。它错了的症状
// 分两种，都不好看：记多了 → 每次推送先撞 409 再合并，白跑一趟；记漏了或串了 →
// 用一个别的文档的版本号去推，服务器要么拒、要么覆盖掉别人刚写的那一版。
//
// 版本号存在 IndexedDB 里而不是内存里，理由写在被测文件顶部（手机会被系统杀掉）。
// 所以这里连「重开一次库还在不在」也一起验。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME, META_KEYS } from '@/db/schema';
import { getMeta } from '@/db/meta';
import { SyncApiError, SyncConflictError } from './client';
import {
  SETTINGS_DOC_ID,
  STUDY_DOC_ID,
  VOCAB_DOC_ID,
  deleteRemoteDoc,
  forgetAllVersions,
  forgetVersion,
  getKnownVersion,
  getRemoteDoc,
  lessonDocId,
  lessonIdFromDocId,
  listRemoteDocs,
  putRemoteDoc,
  rememberVersion,
} from './docs';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 只关心「发去了哪个路径、用了什么方法、带了什么体」，所以一次只备一个响应。 */
function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof stubFetch>) {
  const [input, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { path: decodeURIComponent(new URL(input, 'http://localhost').pathname), init };
}

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

describe('文档 id', () => {
  it('课程 id 往返不变', () => {
    expect(lessonIdFromDocId(lessonDocId('l-123'))).toBe('l-123');
  });

  it('id 里带冒号也不会被截断 —— 只吃掉第一个前缀', () => {
    expect(lessonIdFromDocId(lessonDocId('dw:45334084'))).toBe('dw:45334084');
  });

  it('三个全局文档不是课程，一律 null', () => {
    for (const id of [VOCAB_DOC_ID, SETTINGS_DOC_ID, STUDY_DOC_ID]) {
      expect(lessonIdFromDocId(id)).toBeNull();
    }
  });

  it('不认识的文档类型也是 null —— 恢复时据此跳过，而不是当成一课写进库', () => {
    expect(lessonIdFromDocId('irgendwas')).toBeNull();
    expect(lessonIdFromDocId('lessons:1')).toBeNull();
  });

  it('四种文档 id 两两不同（撞了就是互相覆盖）', () => {
    const ids = [VOCAB_DOC_ID, SETTINGS_DOC_ID, STUDY_DOC_ID, lessonDocId('l-1')];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('本地记的版本号', () => {
  it('没记过就是 null，不是 0 —— 0 是一个真实的版本号', async () => {
    expect(await getKnownVersion(lessonDocId('l-1'))).toBeNull();
  });

  it('记下来读得回，多个文档各记各的', async () => {
    await rememberVersion(lessonDocId('l-1'), 3);
    await rememberVersion(VOCAB_DOC_ID, 17);
    expect(await getKnownVersion(lessonDocId('l-1'))).toBe(3);
    expect(await getKnownVersion(VOCAB_DOC_ID)).toBe(17);
  });

  it('再记一次是覆盖，不是追加', async () => {
    await rememberVersion(VOCAB_DOC_ID, 1);
    await rememberVersion(VOCAB_DOC_ID, 2);
    expect(await getKnownVersion(VOCAB_DOC_ID)).toBe(2);
    expect(await getMeta<Record<string, number>>(META_KEYS.syncVersions)).toEqual({
      [VOCAB_DOC_ID]: 2,
    });
  });

  it('忘掉一个不碰别的', async () => {
    await rememberVersion(VOCAB_DOC_ID, 1);
    await rememberVersion(SETTINGS_DOC_ID, 2);
    await forgetVersion(VOCAB_DOC_ID);
    expect(await getKnownVersion(VOCAB_DOC_ID)).toBeNull();
    expect(await getKnownVersion(SETTINGS_DOC_ID)).toBe(2);
  });

  it('忘一个本来就没记过的，不抛也不写', async () => {
    await expect(forgetVersion('lesson:nie-gesehen')).resolves.toBeUndefined();
    expect(await getMeta(META_KEYS.syncVersions)).toBeUndefined();
  });

  it('退出登录清空全部 —— 换了账号之后那套版本号毫无意义', async () => {
    await rememberVersion(VOCAB_DOC_ID, 1);
    await rememberVersion(lessonDocId('l-1'), 5);
    await forgetAllVersions();
    expect(await getKnownVersion(VOCAB_DOC_ID)).toBeNull();
    expect(await getKnownVersion(lessonDocId('l-1'))).toBeNull();
  });

  it('关掉库再打开还在 —— 手机被系统杀掉之后不该从头撞一遍 409', async () => {
    await rememberVersion(VOCAB_DOC_ID, 9);
    const db = await getDB();
    db.close();
    _resetDBForTests();
    expect(await getKnownVersion(VOCAB_DOC_ID)).toBe(9);
  });
});

describe('远端读写', () => {
  it('列表把 docs 数组原样交出来', async () => {
    const docs = [{ id: VOCAB_DOC_ID, version: 2, updatedAt: 1, bytes: 10 }];
    const fetchMock = stubFetch(json(200, { docs }));
    expect(await listRemoteDocs('tok')).toEqual(docs);
    expect(lastCall(fetchMock).path).toBe('/v1/docs');
  });

  it('取单个文档：id 走 URL 编码，冒号不会被当成路径分隔', async () => {
    const fetchMock = stubFetch(json(200, { id: 'lesson:l-1', version: 1, updatedAt: 0, body: [] }));
    await getRemoteDoc('tok', lessonDocId('l-1'));
    const [input] = fetchMock.mock.calls.at(-1) as unknown as [string];
    expect(input).toContain('%3A');
    expect(lastCall(fetchMock).path).toBe('/v1/docs/lesson:l-1');
  });

  it('远端没有这个文档时返回 null —— 「还没推过」不是错误', async () => {
    stubFetch(json(404, { error: 'not found' }));
    expect(await getRemoteDoc('tok', VOCAB_DOC_ID)).toBeNull();
  });

  it('404 以外的错照抛 —— 500 当成「没有」会让下一次推送覆盖掉远端', async () => {
    stubFetch(json(500, { error: '服务器炸了' }));
    await expect(getRemoteDoc('tok', VOCAB_DOC_ID)).rejects.toBeInstanceOf(SyncApiError);
  });

  it('推送带上 baseVersion 与令牌', async () => {
    const fetchMock = stubFetch(json(200, { version: 4, updatedAt: 123 }));
    expect(await putRemoteDoc('tok', VOCAB_DOC_ID, 3, [{ id: 'v1' }])).toEqual({
      version: 4,
      updatedAt: 123,
    });
    const { init } = lastCall(fetchMock);
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ baseVersion: 3, body: [{ id: 'v1' }] });
  });

  it('第一次推送的 baseVersion 是 null，不是 0', async () => {
    const fetchMock = stubFetch(json(200, { version: 1, updatedAt: 1 }));
    await putRemoteDoc('tok', VOCAB_DOC_ID, null, []);
    expect(JSON.parse(lastCall(fetchMock).init.body as string).baseVersion).toBeNull();
  });

  it('版本对不上时抛 SyncConflictError，并把远端现值带回来供合并', async () => {
    stubFetch(json(409, { version: 7, body: [{ id: 'remote' }] }));
    const err = await putRemoteDoc('tok', VOCAB_DOC_ID, 3, []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncConflictError);
    expect((err as SyncConflictError).version).toBe(7);
    expect((err as SyncConflictError).body).toEqual([{ id: 'remote' }]);
  });

  it('删除返回服务器说的 deleted，而不是「没抛错就算删了」', async () => {
    stubFetch(json(200, { deleted: false }));
    expect(await deleteRemoteDoc('tok', lessonDocId('l-1'))).toBe(false);
  });
});
