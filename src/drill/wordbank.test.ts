// FR-22.2 / FR-22.3：词库从服务器来、本机留副本；练习池 = 词库（按三大类）+ 我加的。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import { emptyDrillState, withCustom, withMark, withoutCustom, withPrefs } from './state';
import type { Wordbank } from './types';

vi.mock('@/sync/config', () => ({ SYNC_API_BASE: 'https://sync.test', isSyncConfigured: () => true }));

const { buildPool, countByCategory, customItemId, findInWordbank, getCachedWordbank, refreshWordbank } = await import(
  './wordbank'
);

const BANK: Wordbank = {
  version: 'v1',
  items: [
    { id: 'kaution', w: 'Kaution', p: 'noun', g: 'f', zh: '押金', t: 'wohnen' },
    { id: 'probezeit', w: 'Probezeit', p: 'noun', g: 'f', zh: '试用期', t: 'beruf' },
    { id: 'schnittstelle', w: 'Schnittstelle', p: 'noun', g: 'f', zh: '接口', t: 'entwicklung' },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(async () => {
  vi.unstubAllGlobals();
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

describe('buildPool', () => {
  it('按三大类筛，中文套上我改过的那一版', () => {
    let s = withPrefs(emptyDrillState(), { categories: ['daily', 'it'] }, 1);
    s = withMark(s, 'kaution', { flagged: true, zh: '租房押金' }, 2);
    const pool = buildPool(BANK, s);
    expect(pool.map((i) => i.id)).toEqual(['kaution', 'schnittstelle']);
    expect(pool[0].zh).toBe('租房押金');
    expect(pool[0].category).toBe('daily');
  });

  it('改过的中文是空白时退回词库那一版，不出空选项', () => {
    const s = withMark(emptyDrillState(), 'kaution', { zh: '   ' }, 2);
    expect(buildPool(BANK, s)[0].zh).toBe('押金');
  });

  it('我加的词进池子；删掉的（墓碑）不进；「我加的」没勾就不进', () => {
    let s = withCustom(emptyDrillState(), { id: 'u:zuversicht', w: 'Zuversicht', p: 'noun', g: 'f', zh: '信心' }, 1);
    s = withCustom(s, { id: 'u:weg', w: 'weg', p: 'adv', zh: '走开' }, 1);
    s = withoutCustom(s, 'u:weg', 2);
    expect(buildPool(BANK, s).filter((i) => i.category === 'mine').map((i) => i.id)).toEqual(['u:zuversicht']);
    expect(buildPool(BANK, s, ['daily']).some((i) => i.category === 'mine')).toBe(false);
    expect(countByCategory(BANK, s)).toEqual({ daily: 1, work: 1, it: 1, mine: 1 });
  });

  it('没有词库时，只剩我加的', () => {
    const s = withCustom(emptyDrillState(), { id: 'u:a', w: 'a', p: 'noun', zh: '甲' }, 1);
    expect(buildPool(undefined, s).map((i) => i.id)).toEqual(['u:a']);
  });
});

describe('customItemId / findInWordbank', () => {
  it('手动词 id 带前缀，永远不撞词库 id；查词库不分大小写', () => {
    expect(customItemId(' Kaution ')).toBe('u:kaution');
    expect(findInWordbank(BANK, 'KAUTION')).toBe('kaution');
    expect(findInWordbank(BANK, 'Zuversicht')).toBeUndefined();
    expect(findInWordbank(undefined, 'Kaution')).toBeUndefined();
  });
});

describe('refreshWordbank', () => {
  it('第一次：不带 have，拿到整份并存下来', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(BANK));
    const got = await refreshWordbank();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://sync.test/v1/wordbank');
    expect(got?.items).toHaveLength(3);
    expect((await getCachedWordbank())?.version).toBe('v1');
  });

  it('手上那一版没变：带着 have 去问，服务器只回 unchanged，本机那份原样留着', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(BANK));
    await refreshWordbank();
    vi.mocked(fetch).mockResolvedValueOnce(json({ unchanged: true, version: 'v1' }));
    const got = await refreshWordbank();
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://sync.test/v1/wordbank?have=v1');
    expect(got?.items).toHaveLength(3);
  });

  it('服务器上换了新版：替换掉本机那份', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(BANK));
    await refreshWordbank();
    vi.mocked(fetch).mockResolvedValueOnce(json({ version: 'v2', items: BANK.items.slice(0, 1) }));
    const got = await refreshWordbank();
    expect(got?.version).toBe('v2');
    expect((await getCachedWordbank())?.items).toHaveLength(1);
  });

  it('断网：不抛，退回手上那一份（地铁里照练，FR-22.3）', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(BANK));
    await refreshWordbank();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await refreshWordbank())?.version).toBe('v1');
  });

  it('从没拿到过、又断网：返回 undefined，不抛', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await refreshWordbank()).toBeUndefined();
  });

  it('并发调两次只发一个请求（页面打开和 syncNow 可能同时调进来）', async () => {
    vi.mocked(fetch).mockResolvedValue(json(BANK));
    await Promise.all([refreshWordbank(), refreshWordbank()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
