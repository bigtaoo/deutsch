// FR-10.1：调度用 ts-fsrs，不用 SM-2。
//
// 这个文件是**唯一**知道 ts-fsrs 存在的地方。数据模型里的 FSRSCard 用 epoch ms
// 存时间（IndexedDB 里 Date 也能存，但备份 JSON 走一趟 JSON.stringify 就变字符串了，
// 合并规则要拿 last_review 比大小，统一成数字最省事），ts-fsrs 用 Date，
// 两边在这里对接，别的地方一律只碰我们自己的 FSRSCard。

import { createEmptyCard, fsrs, Rating, type Card, type Grade } from 'ts-fsrs';
import type { FSRSCard } from '@/types/models';

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

const RATING_MAP: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const scheduler = fsrs();

function toCard(card: FSRSCard): Card {
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    learning_steps: card.learning_steps ?? 0,
    last_review: card.last_review === undefined ? undefined : new Date(card.last_review),
  } as Card;
}

function fromCard(card: Card): FSRSCard {
  return {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as FSRSCard['state'],
    learning_steps: (card as Card & { learning_steps?: number }).learning_steps ?? 0,
    last_review: card.last_review ? card.last_review.getTime() : undefined,
  };
}

export function newCard(now: Date = new Date()): FSRSCard {
  return fromCard(createEmptyCard(now));
}

export function review(card: FSRSCard, rating: ReviewRating, now: Date = new Date()): FSRSCard {
  return fromCard(scheduler.next(toCard(card), now, RATING_MAP[rating]).card);
}

/** 评分按钮上的「下次什么时候再见」预览。四档一次全算出来，UI 直接显示。 */
export function previewIntervals(card: FSRSCard, now: Date = new Date()): Record<ReviewRating, Date> {
  const scheduled = scheduler.repeat(toCard(card), now);
  return {
    again: scheduled[Rating.Again].card.due,
    hard: scheduled[Rating.Hard].card.due,
    good: scheduled[Rating.Good].card.due,
    easy: scheduled[Rating.Easy].card.due,
  };
}

/** 人类可读的间隔，用在评分按钮下方。 */
export function formatInterval(due: Date, now: Date = new Date()): string {
  const minutes = Math.round((due.getTime() - now.getTime()) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months} 个月` : `${(months / 12).toFixed(1)} 年`;
}
