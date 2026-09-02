// 查内置词典（FR-16）。
//
// ── 为什么是「取一个桶」而不是「载入一本词典」 ──
// 词典有 26MB。§7.10 记着手机端真正的硬约束是**内存**（对齐权重就是在
// 「加载模型」这一步被 iOS 杀掉的），所以一次 JSON.parse 26MB 是不能做的事。
// 分 256 桶之后，查一个词解析约 105KB，且相邻查询大多命中同一个桶。
//
// ── 缓存策略：缓存**词条**，不缓存桶 ──
// 桶缓存看着更省事，但一次复习会话会摸到上百个桶 —— 全留着就是几十 MB，
// 正是上面要避开的那个数。所以桶用一个很小的 LRU（连续查同一个桶的场景吃得到），
// 而查出来的词条永久留在内存里 —— 它们只有几百字节，且真正会被反复读。
//
// ── 判「文件在不在」不能看 res.ok ──
// 与 src/align/config.ts 里那段同一个坑：wrangler.jsonc 的 not_found_handling
// 是 single-page-application，缺失路径返回 **200 + index.html**。
// 所以判据是「真的 parse 一遍」。这个判据在静态托管、Capacitor 原生壳
// （`capacitor://` scheme handler 读本地文件，响应头不保证）、`vite preview`
// 三种托管方式下都成立。

import { bucketHex, normalizeKey } from './bucket';
import type { DictDeck, DictEntry, DictLookup, DictMeta } from './types';

/** 站点根下的词典目录。`base` 保持 `'/'`（§7.10 约束 1），所以原样就对。 */
const DICT_BASE = '/dict';

/** 桶的 LRU 上限。6 × 105KB ≈ 630KB —— 够连续查同桶受益，又不至于攒成几十 MB。 */
const SHARD_LRU = 6;

type Shard = Record<string, unknown>;

const shardLru = new Map<string, Shard>();
/** 已查过的词条。`null` 表示「查过、词典里确实没有」—— 也要缓存，否则重复取桶。 */
const entryCache = new Map<string, DictEntry | null>();
/** 词形→词元的结果缓存，同上。 */
const formCache = new Map<string, string[]>();

let metaPromise: Promise<DictMeta | null> | null = null;
const deckPromises = new Map<number, Promise<DictDeck | null>>();

/** 正在飞的桶请求。同一个桶被并发查两次时只发一次请求。 */
const inflight = new Map<string, Promise<Shard | null>>();

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path);
    // 不看 res.ok（见文件头）：SPA fallback 会给 200 + HTML。
    const text = await res.text();
    return JSON.parse(text) as T;
  } catch {
    // JSON.parse 失败 = 拿到的是 index.html 或别的东西 = 这份数据没随包带上。
    // 网络失败也走这里。两种情况的处置一样：当作「内置词典查不到」，
    // 由调用方决定要不要退到在线查（FR-16.5）。
    return null;
  }
}

async function loadShard(dir: 'w' | 'f', key: string): Promise<Shard | null> {
  const hex = bucketHex(key);
  const id = `${dir}/${hex}`;

  const cached = shardLru.get(id);
  if (cached) {
    // LRU：重新插入以刷新顺序。
    shardLru.delete(id);
    shardLru.set(id, cached);
    return cached;
  }

  const existing = inflight.get(id);
  if (existing) return existing;

  const p = (async () => {
    const shard = await fetchJson<Shard>(`${DICT_BASE}/${dir}/${hex}.json`);
    if (shard) {
      shardLru.set(id, shard);
      while (shardLru.size > SHARD_LRU) shardLru.delete(shardLru.keys().next().value as string);
    }
    inflight.delete(id);
    return shard;
  })();
  inflight.set(id, p);
  return p;
}

async function rawEntry(key: string): Promise<DictEntry | null> {
  if (entryCache.has(key)) return entryCache.get(key) ?? null;
  const shard = await loadShard('w', key);
  // 桶都没取到时**不要写进缓存**：那通常是「词典没部署」或断网，
  // 缓存下来会让之后补上了也一直查不到。
  if (!shard) return null;
  const entry = (shard[key] as DictEntry | undefined) ?? null;
  entryCache.set(key, entry);
  return entry;
}

/** 词形还原：`gelaufen` → `laufen`。返回的是**归一化**词元键。 */
export async function resolveForms(surface: string): Promise<string[]> {
  const key = normalizeKey(surface);
  const cached = formCache.get(key);
  if (cached) return cached;
  const shard = await loadShard('f', key);
  if (!shard) return [];
  const list = (shard[key] as string[] | undefined) ?? [];
  formCache.set(key, list);
  return list;
}

/**
 * 查一个词。先按原形查，查不到再走词形还原。
 *
 * 传进来的应该是**单个词**（`Plattformen`）。多词搭配（`hing ... ab`）查不到是
 * 预期行为 —— FR-9.4 鼓励按搭配建词条，而搭配的释义得人来写或走在线查。
 */
export async function lookupDict(surface: string): Promise<DictLookup | null> {
  const trimmed = surface.trim();
  if (!trimmed) return null;

  const key = normalizeKey(trimmed);
  const exact = await rawEntry(key);
  if (exact) return { entry: exact, via: 'exact' };

  const lemmaKeys = await resolveForms(trimmed);
  for (const lemmaKey of lemmaKeys) {
    const entry = await rawEntry(lemmaKey);
    if (entry) return { entry, via: 'form', queried: trimmed };
  }
  return null;
}

/**
 * FR-9.3 的去重键：同一个词的不同变形应该得到同一个键。
 * `gelaufen` 与 `laufen` 都返回 `laufen` —— 这正是 V1 那条已知局限
 * （「V1 无 lemma，只能靠 surface 匹配」）被修掉的地方。
 * 查不到时退回归一化的 surface，行为与 V1 相同。
 */
export async function dedupeKey(surface: string): Promise<string> {
  const hit = await lookupDict(surface);
  if (!hit) return normalizeKey(surface);
  return normalizeKey(hit.entry.w);
}

export function dictMeta(): Promise<DictMeta | null> {
  metaPromise ??= fetchJson<DictMeta>(`${DICT_BASE}/meta.json`);
  return metaPromise;
}

export function loadDeck(id: number): Promise<DictDeck | null> {
  let p = deckPromises.get(id);
  if (!p) {
    p = fetchJson<DictDeck>(`${DICT_BASE}/deck/band-${id}.json`);
    deckPromises.set(id, p);
  }
  return p;
}

/** 测试用：把所有缓存清掉。 */
export function __resetDictCaches(): void {
  shardLru.clear();
  entryCache.clear();
  formCache.clear();
  inflight.clear();
  metaPromise = null;
  deckPromises.clear();
}
