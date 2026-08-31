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

/** FR-10.5：无音频卡要区分两种原因，给不同出口。 */
export type CardAudioStatus = 'ok' | 'no-timestamp' | 'no-material';

export function cardAudioStatus(entry: VocabEntry, hasMaterial: boolean): CardAudioStatus {
  if (!entry.hasTimestamp) return 'no-timestamp';
  if (!hasMaterial) return 'no-material';
  return 'ok';
}
