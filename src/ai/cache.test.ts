// 变更 49：AI 补充解释缓存。合并规则是这份数据唯一有风险的地方 ——
// 写错的症状是「明明问过这个词，换台设备又要再问一次」（漏合并）或者
// 「重新问过的新答案被旧答案顶掉」（合并方向反了）。

import { afterEach, describe, expect, it } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import {
  aiCacheNeedsPush,
  emptyAiCache,
  getAiCache,
  getCachedAiNote,
  mergeAiCaches,
  normalizeAiCacheKey,
  putAiCache,
  rememberAiNote,
  type AiCache,
} from './cache';

function cache(entries: AiCache['entries'], updatedAt = 1): AiCache {
  return { entries, updatedAt };
}

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

describe('normalizeAiCacheKey', () => {
  it('大小写、前后空格都不影响命中', () => {
    expect(normalizeAiCacheKey(' Zug ')).toBe('zug');
    expect(normalizeAiCacheKey('ZUG')).toBe(normalizeAiCacheKey('zug'));
  });
});

describe('mergeAiCaches', () => {
  it('只有一边有的词照单全收', () => {
    const local = cache({ zug: { note: '本地', ts: 100 } });
    const incoming = cache({ haus: { note: '远端', ts: 100 } });
    const { merged, changed } = mergeAiCaches(local, incoming);
    expect(merged.entries).toEqual({
      zug: { note: '本地', ts: 100 },
      haus: { note: '远端', ts: 100 },
    });
    expect(changed).toBe(true);
  });

  it('两边都有：ts 更新的那条赢，不是「远端总赢」也不是「本地总赢」', () => {
    const local = cache({ zug: { note: '本地旧的', ts: 100 } });
    const incoming = cache({ zug: { note: '远端新的', ts: 200 } });
    expect(mergeAiCaches(local, incoming).merged.entries.zug.note).toBe('远端新的');
    expect(mergeAiCaches(incoming, local).merged.entries.zug.note).toBe('远端新的');
  });

  it('ts 相等时保留本地那份 —— 确定性优先，不是「远端赢」', () => {
    const local = cache({ zug: { note: '本地', ts: 100 } });
    const incoming = cache({ zug: { note: '远端', ts: 100 } });
    const { merged, changed } = mergeAiCaches(local, incoming);
    expect(merged.entries.zug.note).toBe('本地');
    expect(changed).toBe(false);
  });

  it('没有任何变化时 changed 为 false', () => {
    const a = cache({ zug: { note: '一样', ts: 100 } });
    const b = cache({ zug: { note: '一样', ts: 100 } });
    expect(mergeAiCaches(a, b).changed).toBe(false);
  });
});

describe('aiCacheNeedsPush', () => {
  it('本地有远端没有的词 → true', () => {
    const local = cache({ zug: { note: '本地', ts: 100 } });
    expect(aiCacheNeedsPush(local, emptyAiCache())).toBe(true);
  });

  it('本地的 ts 比远端新 → true', () => {
    const local = cache({ zug: { note: '重新问过', ts: 200 } });
    const remote = cache({ zug: { note: '旧答案', ts: 100 } });
    expect(aiCacheNeedsPush(local, remote)).toBe(true);
  });

  it('远端已经有一样新（或更新）的 → false', () => {
    const local = cache({ zug: { note: '本地', ts: 100 } });
    const remote = cache({ zug: { note: '远端', ts: 200 } });
    expect(aiCacheNeedsPush(local, remote)).toBe(false);
  });
});

describe('落库', () => {
  it('没查过时给空缓存，不是 undefined', async () => {
    expect(await getAiCache()).toEqual(emptyAiCache());
    expect(await getCachedAiNote('Zug')).toBeUndefined();
  });

  it('rememberAiNote 写入之后，换大小写/换前后空格也能查到', async () => {
    await rememberAiNote('Zug', '一列火车');
    expect(await getCachedAiNote('zug')).toBe('一列火车');
    expect(await getCachedAiNote(' ZUG ')).toBe('一列火车');
    expect(await getCachedAiNote('Haus')).toBeUndefined();
  });

  it('重新问一次会覆盖旧答案，不是叠加', async () => {
    await rememberAiNote('Zug', '第一次的答案', 100);
    await rememberAiNote('Zug', '重新问过的答案', 200);
    const c = await getAiCache();
    expect(c.entries.zug).toEqual({ note: '重新问过的答案', ts: 200 });
  });

  it('put/get 往返形状不对（旧数据、坏数据）时按空缓存处理，不炸', async () => {
    await putAiCache({ entries: undefined, updatedAt: 1 } as unknown as AiCache);
    expect(await getAiCache()).toEqual(emptyAiCache());
  });
});
