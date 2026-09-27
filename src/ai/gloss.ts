// FR-9.15：课上加的词，加完就在后台问一次 AI 要一句话中文，写进 `meaningZh`。
// 服务端那一半是 `POST /v1/ai/gloss`（server/src/ai.ts 的 gloss）。
//
// ── 为什么是一个攒批的队列，而不是加一个词问一次 ──
// 两种加法都是「一下子来一串」：候选列表一次加二三十个；点词秒加是几秒一个地连着点。
// 逐个问就是几十次往返、几十份重复的提示词开销。所以进队列、等 `GLOSS_DELAY_MS` 没有新词进来
// 再发，一批最多 `GLOSS_BATCH` 个（与服务端 GLOSS_MAX_ITEMS 一致）。
//
// ── 失败就算了 ──
// 没登录、服务器没开 AI、网络断了：什么都不做，不提示。中文不是这个词条成立的前提 ——
// 德语释义词典已经填了，FR-21.9 的「外面翻、粘回来」照旧能补。出错时不重试、也不把这批
// 留在队列里等下一次：服务器长期没开 AI 时，留着的词每一批都会被白带一遍。

import { syncFetch } from '@/sync/client';
import { getSessionToken } from '@/sync/session';
import { useVocabStore } from '@/state/useVocabStore';
import { aiAvailable } from './explain';
import type { VocabEntry } from '@/types/models';

export const GLOSS_BATCH = 40;
export const GLOSS_DELAY_MS = 1500;

export interface GlossItem {
  word: string;
  context?: string;
}

/** 问一批。返回与输入一一对应的中文，认不出的是空串。 */
export async function glossWithAi(items: GlossItem[]): Promise<string[]> {
  const token = await getSessionToken();
  if (!token) throw new Error('尚未登录，无法使用 AI');
  const { glosses } = await syncFetch<{ glosses: string[] }>('/v1/ai/gloss', { method: 'POST', body: { items }, token });
  return glosses;
}

/** 这个词条值不值得问：还没有中文，且有原句（没有原句就谈不上「按语境译」）。 */
function wantsGloss(entry: VocabEntry | undefined): entry is VocabEntry {
  return !!entry && !entry.meaningZh && !!entry.contextSentence;
}

const pendingIds = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;

/** 把刚加的词条排进去。几秒内连着排的会合成一批。 */
export function queueZhGloss(entryIds: readonly string[]): void {
  for (const id of entryIds) pendingIds.add(id);
  if (pendingIds.size === 0) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushZhGloss();
  }, GLOSS_DELAY_MS);
}

/** 立刻把队列里的问掉。测试与「正在跑的那批结束后还有新的」时用。 */
export async function flushZhGloss(): Promise<void> {
  // 同一时间只跑一批：两批并发写 updateEntries 没问题，但会让同一个词被问两遍
  if (running) {
    await running;
    if (pendingIds.size === 0) return;
  }
  running = (async () => {
    const ids = [...pendingIds];
    pendingIds.clear();
    if (!(await aiAvailable())) return;
    const store = useVocabStore.getState();
    const targets = ids.map((id) => store.entries.find((e) => e.id === id)).filter(wantsGloss);
    for (let i = 0; i < targets.length; i += GLOSS_BATCH) {
      const batch = targets.slice(i, i + GLOSS_BATCH);
      let glosses: string[];
      try {
        glosses = await glossWithAi(
          batch.map((e) => ({ word: e.lemma ?? e.surface, context: e.contextSentence })),
        );
      } catch {
        return; // 见文件头「失败就算了」
      }
      // 问的这几秒里词条可能被改过、删过：按 id 重读最新的那一份再写，只写仍然缺中文的
      const latest = useVocabStore.getState().entries;
      const now = Date.now();
      const updated: VocabEntry[] = [];
      for (const [j, entry] of batch.entries()) {
        const zh = glosses[j]?.trim();
        const current = latest.find((e) => e.id === entry.id);
        if (!zh || !current || current.meaningZh) continue;
        updated.push({ ...current, meaningZh: zh, updatedAt: now });
      }
      await useVocabStore.getState().updateEntries(updated);
    }
  })();
  try {
    await running;
  } finally {
    running = null;
  }
}

/** 测试用。 */
export function __resetZhGloss(): void {
  pendingIds.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  running = null;
}
