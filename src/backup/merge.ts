// §2.4 合并规则 —— 纯函数，不碰 IndexedDB，方便穷举测试。
//
// 规则原文：
// - Lesson：按 id 匹配，updatedAt 较新者整体胜出。
// - VocabEntry：按 id 匹配，比较 fsrs.last_review，较新者整条胜出（last-write-wins）。
// - Settings：**整体** last-write-wins，比 updatedAt（2026-09-02 新增，§0 变更 28）。
// - 只在本地和导入都存在的 id 上比较；只在一侧存在的 id 直接采用那一侧的版本。

import type { Lesson, Settings, VocabEntry } from '@/types/models';
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

/**
 * §2.4 的第三条（2026-09-02 新增，§0 变更 28）：**Settings 整体 last-write-wins，比 `updatedAt`。**
 *
 * 为什么是「整体」而不是逐字段：逐字段合并需要每个字段各有一个时间戳，
 * 那是把一个十来个布尔和数字的对象变成一张带元数据的表 —— 代价远超收益。
 * 设置是低频改动（一年动几次），整体覆盖丢掉的最多是「另一台设备上同时改的另一项」，
 * 而那一项在界面上看一眼就能改回来；相比之下**永远不同步**丢掉的是「换设备要重设一遍」。
 *
 * `updatedAt` 缺失视为 0（从没改过 / 老库），所以任何一次真实改动都能赢过它。
 * 两边完全同时（同一毫秒）时保留本地 —— 确定性优先于「谁更对」，反正内容大概率一样。
 */
export function mergeSettings(local: Settings, incoming: Settings): { merged: Settings; changed: boolean } {
  const localAt = local.updatedAt ?? 0;
  const incomingAt = incoming.updatedAt ?? 0;
  if (incomingAt > localAt) return { merged: incoming, changed: true };
  return { merged: local, changed: false };
}

export function mergeBackup(
  local: { lessons: Lesson[]; vocab: VocabEntry[]; settings?: Settings },
  incoming: { lessons: Lesson[]; vocab: VocabEntry[]; settings?: Settings },
): MergeResult {
  const summary = emptySummary();
  const { merged: lessons } = mergeLessons(local.lessons, incoming.lessons, summary);
  const { merged: vocab } = mergeVocabEntries(local.vocab, incoming.vocab, summary);

  // 设置是可选的：老备份文件、以及只关心课程/生词的调用方都可以不给。
  let settings: Settings | undefined;
  if (local.settings && incoming.settings) {
    const result = mergeSettings(local.settings, incoming.settings);
    settings = result.merged;
    summary.settingsUpdated = result.changed;
  } else {
    settings = incoming.settings ?? local.settings;
    summary.settingsUpdated = Boolean(incoming.settings && !local.settings);
  }

  return { lessons, vocab, settings, summary };
}
