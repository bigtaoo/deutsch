// 变更 84：旧生词本（VocabEntry）迁进速背。
//
// 复习撤掉以后，生词本里那些词只剩速背这一条路能背到。每台设备启动时跑一次（本机 meta 记「迁过了」）：
//   · 词：词库里有就用词库那一条，没有就加成手动词（查词来的 `src:'lookup'`，课程来的 `src:'lesson'` 带出处）；
//   · 中文：词条上的 `meaningZh` → 内置词典第一条 → 都没有的不迁（出不了中文四选一）。这里不问 AI；
//   · 进度：听卡 / 读卡里最近复习过的那张，折算成 `word:` 进度。**速背里已经有进度的不覆盖** ——
//     那是更近的判断；没复习过的（state 0）不写进度，就是一个新词。
// 旧数据只是不再展示，不删：VocabEntry 还在库里、还在备份和同步里。
//
// 两台设备各迁一次：写的是同一批 id、同一张卡（都从同步过来的 VocabEntry 折算），合并后一样。

import { getAllVocabEntries } from '@/db/vocab';
import { getMeta, putMeta } from '@/db/meta';
import { lookupDict } from '@/dict/lookup';
import type { DictLookup } from '@/dict/types';
import type { FSRSCard, VocabEntry } from '@/types/models';
import { unifiedCard } from './daily';
import { toDrillPos } from './harvest';
import { updateDrillState, withCustom, withProgress } from './state';
import type { DrillState, Wordbank } from './types';
import { customItemId, findInWordbank, getCachedWordbank } from './wordbank';

const MIGRATED_KEY = 'drillMigratedVocab';

function latestCard(e: VocabEntry): FSRSCard | undefined {
  const cards = [e.fsrs, e.fsrsRead].filter((c): c is FSRSCard => Boolean(c && c.state !== 0 && c.last_review));
  return cards.sort((a, b) => (b.last_review ?? 0) - (a.last_review ?? 0))[0];
}

export interface MigrateRow {
  entry: VocabEntry;
  zh: string;
  dict: DictLookup | null;
}

/** 纯函数：把一批旧词条套到速背状态上。 */
export function applyVocabMigration(
  state: DrillState,
  rows: readonly MigrateRow[],
  wordbank: Wordbank | undefined,
  now: number,
): DrillState {
  let s = state;
  rows.forEach(({ entry, zh, dict }, i) => {
    const word = (entry.lemma ?? entry.surface).trim();
    if (!word) return;
    let id = findInWordbank(wordbank, word);
    if (!id) {
      id = customItemId(word);
      const mine = s.custom[id];
      if (!zh) return;
      if (!mine || mine.deleted) {
        const fromLesson = !entry.lookup && !entry.preset && entry.lessonId !== undefined;
        s = withCustom(
          s,
          {
            id,
            w: word,
            p: toDrillPos(dict?.entry.s[0]?.p),
            g: entry.gender,
            zh,
            ...(entry.lookup ? { src: 'lookup' as const } : {}),
            ...(fromLesson ? { src: 'lesson' as const, lessonId: entry.lessonId, si: entry.sentenceIndex } : {}),
          },
          now + i,
        );
      }
    }
    const card = latestCard(entry);
    if (card && !unifiedCard(s, id)) s = withProgress(s, 'word', id, card, now + i);
  });
  return s;
}

/** 启动时调一次。词库还没下载时先不迁（否则词库里有的词会被加成重复的手动词），下次再试。 */
export async function migrateVocabToDrill(now: number = Date.now()): Promise<number | null> {
  if (await getMeta<boolean>(MIGRATED_KEY)) return null;
  const bank = await getCachedWordbank();
  if (!bank) return null;
  const entries = await getAllVocabEntries();
  const rows: MigrateRow[] = [];
  for (const entry of entries) {
    const word = entry.lemma ?? entry.surface;
    const dict = await lookupDict(word).catch(() => null);
    rows.push({ entry, dict, zh: entry.meaningZh?.trim() || dict?.entry.s[0]?.zh?.[0]?.trim() || '' });
  }
  if (rows.length > 0) await updateDrillState((s) => applyVocabMigration(s, rows, bank, now));
  await putMeta(MIGRATED_KEY, true);
  return rows.length;
}
