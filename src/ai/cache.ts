// AI 补充解释缓存（变更 49，2026-09-22 晚）。
//
// ── 为什么要缓存 ──
// 变更 48 把「问 AI」从剪贴板改成服务器实时调用，但只在两个词典都查不到时自动问一次；
// 查到的词完全没有 AI 入口。补上入口之后就有了一个新问题：同一个词可能被反复查
// （这一课学一次、复习时又查一次），每次都再问模型一遍既要花钱，答案大概率还一样。
// 所以问到的结果存起来、跟着账号同步，下次查到同一个词直接显示，不用再点一次。
//
// ── 形状：归一化词 → 解释 ──
// 键用 normalizeAiCacheKey（trim + 小写）：查词时大小写、前后空格不该影响命中，
// 跟 dict/bucket.ts 的 normalizeKey 是同一个理由。
//
// ── 合并：逐词取时间戳更新的那条 ──
// 不是像学习记录（study/log.ts）那样逐格求和/取 max —— 一个词只需要一份解释，
// 没有「两台设备的版本都要保留」这回事，谁问得更晚谁的答案更可能是「重新问」之后
// 更满意的那版，直接覆盖旧的。

import { getMeta, putMeta } from '@/db/meta';
import { META_KEYS } from '@/db/schema';

export interface AiCacheEntry {
  note: string;
  ts: number;
}

export interface AiCache {
  /** 归一化词 → 缓存的解释 */
  entries: Record<string, AiCacheEntry>;
  /** 合并与同步的定序参考；真正的合并是逐词比 ts，这个字段只用来判断「有没有变过」 */
  updatedAt: number;
}

export function emptyAiCache(): AiCache {
  return { entries: {}, updatedAt: 0 };
}

/** 查词不分大小写、不介意前后空格——缓存的键也不该介意。 */
export function normalizeAiCacheKey(word: string): string {
  return word.trim().toLowerCase();
}

/**
 * 合并两份缓存：逐词取 ts 更新的那条。
 * 两边都没有的词不出现在结果里；只有一边有的词照单全收。
 */
export function mergeAiCaches(local: AiCache, incoming: AiCache): { merged: AiCache; changed: boolean } {
  const entries: AiCache['entries'] = {};
  let changed = false;

  for (const key of new Set([...Object.keys(local.entries), ...Object.keys(incoming.entries)])) {
    const a = local.entries[key];
    const b = incoming.entries[key];
    if (a && (!b || a.ts >= b.ts)) {
      entries[key] = a;
    } else {
      entries[key] = b;
      changed = true;
    }
  }

  return {
    merged: { entries, updatedAt: Math.max(local.updatedAt, incoming.updatedAt) },
    changed,
  };
}

/** 本地是不是有远端没有（或比远端新）的词条 —— 调用方据此决定要不要回推。 */
export function aiCacheNeedsPush(local: AiCache, remote: AiCache): boolean {
  for (const [key, entry] of Object.entries(local.entries)) {
    const other = remote.entries[key];
    if (!other || entry.ts > other.ts) return true;
  }
  return false;
}

// ── 落库 ──────────────────────────────────────────────────────────────────

export async function getAiCache(): Promise<AiCache> {
  const stored = await getMeta<AiCache>(META_KEYS.aiCache);
  if (!stored || typeof stored !== 'object' || !stored.entries) return emptyAiCache();
  return { entries: stored.entries, updatedAt: stored.updatedAt ?? 0 };
}

export async function putAiCache(cache: AiCache): Promise<void> {
  await putMeta(META_KEYS.aiCache, cache);
}

/** 查一个词有没有缓存过的解释；没有就是 `undefined`，调用方决定要不要真的去问一次。 */
export async function getCachedAiNote(word: string): Promise<string | undefined> {
  const cache = await getAiCache();
  return cache.entries[normalizeAiCacheKey(word)]?.note;
}

/** 记一条新解释（覆盖旧的）。调用方负责在这之后触发同步（scheduleAiCacheSync）。 */
export async function rememberAiNote(word: string, note: string, now = Date.now()): Promise<void> {
  const cache = await getAiCache();
  const key = normalizeAiCacheKey(word);
  await putAiCache({
    entries: { ...cache.entries, [key]: { note, ts: now } },
    updatedAt: now,
  });
}
