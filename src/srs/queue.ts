// FR-10.6：队列受 newPerDay / reviewPerDay 限制；今日无卡时显示下次到期时间。
//
// 「今天已经学了多少张」不额外记账，从卡片自身的 FSRS 状态推：
//   reps === 1 且 last_review 是今天 → 今天第一次学的新卡
//   reps  > 1 且 last_review 是今天 → 今天的复习
// 这是个近似（同一张新卡今天被 Again 反复重来会被算成复习），但它不需要任何
// 额外的每日计数器 —— 而每日计数器是要跨设备同步的，一同步就要处理时区和合并冲突，
// 为了一个「防爆闸」的软上限不值得。

import type { VocabEntry } from '@/types/models';

export interface QueueOptions {
  newPerDay: number;
  reviewPerDay: number;
  now?: number;
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export interface QueueBreakdown {
  queue: VocabEntry[];
  newCount: number;
  reviewCount: number;
  /** 队列为空时的下一次到期时间；没有任何卡则 null */
  nextDueAt: number | null;
}

export function buildReviewQueue(entries: VocabEntry[], opts: QueueOptions): QueueBreakdown {
  const now = opts.now ?? Date.now();
  const active = entries.filter((e) => !e.suspended);

  const doneToday = active.filter((e) => e.fsrs.last_review !== undefined && isSameDay(e.fsrs.last_review, now));
  const newDoneToday = doneToday.filter((e) => e.fsrs.reps === 1).length;
  const reviewDoneToday = doneToday.length - newDoneToday;

  const isDue = (e: VocabEntry) => e.fsrs.due <= now;

  const newCards = active
    .filter((e) => e.fsrs.state === 0)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, Math.max(0, opts.newPerDay - newDoneToday));

  const reviewCards = active
    .filter((e) => e.fsrs.state !== 0 && isDue(e))
    .sort((a, b) => a.fsrs.due - b.fsrs.due)
    .slice(0, Math.max(0, opts.reviewPerDay - reviewDoneToday));

  // 复习排在新卡前面：到期的卡再不看就真忘了，新卡晚一天没有代价。
  const queue = [...reviewCards, ...newCards];

  const upcoming = active
    .filter((e) => e.fsrs.due > now)
    .reduce<number | null>((min, e) => (min === null || e.fsrs.due < min ? e.fsrs.due : min), null);

  return { queue, newCount: newCards.length, reviewCount: reviewCards.length, nextDueAt: upcoming };
}

/**
 * FR-17.4：今天还缺几张新卡 —— 惰性激活要补的就是这个数。
 *
 * 「缺」= 今天的新卡配额 − 今天已经学掉的新卡 − 手上还没学的新卡。
 * 三项都从卡片自身的状态推，不另设每日计数器（理由见文件头）。
 *
 * 为什么要减「手上还没学的新卡」：课上标的生词也是新卡，它们优先。
 * 不减的话，一篇课文标了 8 个词的那天，预置词库还会再发 10 张 ——
 * 那天就变成 18 张新卡，而 `newPerDay` 存在的理由正是不让这种事发生。
 */
export function newCardShortfall(entries: VocabEntry[], opts: Pick<QueueOptions, 'newPerDay' | 'now'>): number {
  const now = opts.now ?? Date.now();
  const active = entries.filter((e) => !e.suspended);
  const newDoneToday = active.filter(
    (e) => e.fsrs.reps === 1 && e.fsrs.last_review !== undefined && isSameDay(e.fsrs.last_review, now),
  ).length;
  const untouched = active.filter((e) => e.fsrs.state === 0).length;
  return Math.max(0, opts.newPerDay - newDoneToday - untouched);
}

/**
 * FR-10.5：无音频卡要区分原因，给不同出口。
 *
 * `preset-word` 是 FR-17 加的第四种：预置词库的卡没有课、没有原句、也没有真语料音频，
 * 它的声音来自 Wiktionary 的真人录音或系统 TTS（都是**孤立词**发音）。
 * 单独一档而不是并进 'ok'，是因为 FR-10.5 的要求是「不能静默降级」——
 * 卡面必须说清这是孤立词发音、练不到连读，否则用户会以为自己在练真语料。
 */
export type CardAudioStatus = 'ok' | 'no-timestamp' | 'no-material' | 'preset-word';

export function cardAudioStatus(entry: VocabEntry, hasMaterial: boolean): CardAudioStatus {
  if (entry.preset) return 'preset-word';
  if (!entry.hasTimestamp) return 'no-timestamp';
  if (!hasMaterial) return 'no-material';
  return 'ok';
}
