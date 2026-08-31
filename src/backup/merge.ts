// §2.4 合并规则 —— 纯函数，不碰 IndexedDB，方便穷举测试。
//
// 规则原文：
// - Lesson：按 id 匹配，updatedAt 较新者整体胜出。
// - VocabEntry：按 id 匹配，比较 fsrs.last_review，较新者整条胜出（last-write-wins）。
// - 只在本地和导入都存在的 id 上比较；只在一侧存在的 id 直接采用那一侧的版本。

import type { Lesson, VocabEntry } from '@/types/models';
import type { MergeResult, MergeSummary } from './types';

function emptySummary(): MergeSummary {
  return {
    addedLessons: [],
    updatedLessons: [],
    skippedLessons: [],
    overwrittenLessonTitles: [],
    addedVocab: [],
    updatedVocab: [],
    skippedVocab: [],
  };
}

export function mergeLessons(
  local: Lesson[],
  incoming: Lesson[],
  summary: MergeSummary = emptySummary(),
): { merged: Lesson[]; summary: MergeSummary } {
  const byId = new Map(local.map((l) => [l.id, l]));

  for (const incomingLesson of incoming) {
    const localLesson = byId.get(incomingLesson.id);
    if (!localLesson) {
      byId.set(incomingLesson.id, incomingLesson);
      summary.addedLessons.push(incomingLesson.id);
      continue;
    }
    if (incomingLesson.updatedAt > localLesson.updatedAt) {
      summary.overwrittenLessonTitles.push(localLesson.title);
      summary.updatedLessons.push(incomingLesson.id);
      byId.set(incomingLesson.id, incomingLesson);
    } else {
      // incoming 较旧或相等：本地已经是最新，跳过。
      summary.skippedLessons.push(incomingLesson.id);
    }
  }

  return { merged: [...byId.values()], summary };
}

/** fsrs.last_review 缺失视为"从未复习过"，排在任何有值的时间戳之前。 */
function lastReviewRank(entry: VocabEntry): number {
  return entry.fsrs.last_review ?? -Infinity;
}

export function mergeVocabEntries(
  local: VocabEntry[],
  incoming: VocabEntry[],
  summary: MergeSummary = emptySummary(),
): { merged: VocabEntry[]; summary: MergeSummary } {
  const byId = new Map(local.map((v) => [v.id, v]));

  for (const incomingEntry of incoming) {
    const localEntry = byId.get(incomingEntry.id);
    if (!localEntry) {
      byId.set(incomingEntry.id, incomingEntry);
      summary.addedVocab.push(incomingEntry.id);
      continue;
    }
    const incomingRank = lastReviewRank(incomingEntry);
    const localRank = lastReviewRank(localEntry);
    if (incomingRank > localRank) {
      summary.updatedVocab.push(incomingEntry.id);
      byId.set(incomingEntry.id, incomingEntry);
    } else if (incomingRank === localRank && incomingEntry.updatedAt > localEntry.updatedAt) {
      // 平局（例如两边都从未复习过）：退化到 updatedAt 做确定性 tie-break。
      summary.updatedVocab.push(incomingEntry.id);
      byId.set(incomingEntry.id, incomingEntry);
    } else {
      summary.skippedVocab.push(incomingEntry.id);
    }
  }

  return { merged: [...byId.values()], summary };
}

export function mergeBackup(
  local: { lessons: Lesson[]; vocab: VocabEntry[] },
  incoming: { lessons: Lesson[]; vocab: VocabEntry[] },
): MergeResult {
  const summary = emptySummary();
  const { merged: lessons } = mergeLessons(local.lessons, incoming.lessons, summary);
  const { merged: vocab } = mergeVocabEntries(local.vocab, incoming.vocab, summary);
  return { lessons, vocab, summary };
}
