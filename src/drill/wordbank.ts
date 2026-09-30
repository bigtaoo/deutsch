// FR-22.2 / FR-22.3：词库从同步服务器来，本机留一份副本。
//
// 请求是 `GET /v1/wordbank?have=<version>`：手上那一版没变时服务器只回
// `{ unchanged: true }`，几十字节。**不要求登录** —— 词库没有个人数据，
// 没登录的新设备也该能练（进度同步才要登录）。
//
// 这里不用 syncFetch 的 token，但仍然走它：同一个 base、同一套错误类型。
// 没配服务器地址（本地开发、e2e）时直接说拿不到，由页面说清楚。

import { getMeta, putMeta } from '@/db/meta';
import { META_KEYS } from '@/db/schema';
import { normalizeKey } from '@/dict/bucket';
import { syncFetch } from '@/sync/client';
import { isSyncConfigured } from '@/sync/config';
import { CATEGORY_OF, type CachedWordbank, type DrillCategory, type DrillState, type PoolItem, type Wordbank } from './types';

type WordbankResponse = { unchanged: true; version: string } | (Wordbank & { unchanged?: false });

export async function getCachedWordbank(): Promise<CachedWordbank | undefined> {
  const stored = await getMeta<CachedWordbank>(META_KEYS.drillWordbank);
  if (!stored || !Array.isArray(stored.items)) return undefined;
  return stored;
}

let inflight: Promise<CachedWordbank | undefined> | null = null;

/**
 * 问服务器要一次最新的词库；失败不抛，返回手上那一份（可能是 undefined）。
 * 单飞：页面打开和 syncNow 可能同时调进来。
 */
export function refreshWordbank(): Promise<CachedWordbank | undefined> {
  inflight ??= (async () => {
    const cached = await getCachedWordbank();
    if (!isSyncConfigured()) return cached;
    try {
      const have = cached ? `?have=${encodeURIComponent(cached.version)}` : '';
      const res = await syncFetch<WordbankResponse>(`/v1/wordbank${have}`);
      if (res.unchanged) {
        if (!cached) return undefined;
        const touched = { ...cached, fetchedAt: Date.now() };
        await putMeta(META_KEYS.drillWordbank, touched);
        return touched;
      }
      if (!Array.isArray(res.items)) return cached;
      const next: CachedWordbank = { version: res.version, items: res.items, fetchedAt: Date.now() };
      await putMeta(META_KEYS.drillWordbank, next);
      return next;
    } catch {
      return cached;
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 手动词的 id：前缀 `u:`，永远不会和词库 id 撞上。 */
export function customItemId(word: string): string {
  return `u:${normalizeKey(word.trim())}`;
}

/** 这个词在不在词库里（按归一化词形比，不管词性）。 */
export function findInWordbank(wordbank: Wordbank | undefined, word: string): string | undefined {
  if (!wordbank) return undefined;
  const key = normalizeKey(word.trim());
  return wordbank.items.find((it) => normalizeKey(it.w) === key)?.id;
}

/**
 * 练习池 = 词库（按勾选的三大类）+ 我加的（没删掉的）。
 * 中文**已经套上我改过的那一版**（FR-22.9），出题和干扰项都读这里。
 */
export function buildPool(
  wordbank: Wordbank | undefined,
  state: DrillState,
  categories: readonly DrillCategory[] = state.prefs.categories,
): PoolItem[] {
  const want = new Set(categories);
  const zhOf = (id: string, base: string) => state.marks[id]?.zh?.trim() || base;
  const pool: PoolItem[] = [];
  for (const it of wordbank?.items ?? []) {
    const category = CATEGORY_OF[it.t] ?? 'daily';
    if (!want.has(category)) continue;
    pool.push({ id: it.id, w: it.w, p: it.p, g: it.g, zh: zhOf(it.id, it.zh), n: it.n, category });
  }
  if (want.has('mine')) {
    for (const it of Object.values(state.custom)) {
      if (it.deleted) continue;
      pool.push({ id: it.id, w: it.w, p: it.p, g: it.g, zh: zhOf(it.id, it.zh), n: it.n, category: 'mine' });
    }
  }
  return pool;
}

/** 每一类有多少个词 —— 首页的 Chip 上要写。 */
export function countByCategory(wordbank: Wordbank | undefined, state: DrillState): Record<DrillCategory, number> {
  const counts: Record<DrillCategory, number> = { daily: 0, work: 0, it: 0, mine: 0 };
  for (const it of wordbank?.items ?? []) counts[CATEGORY_OF[it.t] ?? 'daily']++;
  for (const it of Object.values(state.custom)) if (!it.deleted) counts.mine++;
  return counts;
}
