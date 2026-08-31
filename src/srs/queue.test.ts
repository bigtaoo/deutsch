import { describe, it, expect } from 'vitest';
import { buildReviewQueue, cardAudioStatus } from './queue';
import type { FSRSCard, VocabEntry } from '@/types/models';

const NOW = new Date('2026-08-31T12:00:00Z').getTime();
const DAY = 86_400_000;

function card(partial: Partial<FSRSCard> = {}): FSRSCard {
  return {
    due: NOW,
    stability: 1,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    ...partial,
  };
}

function entry(id: string, partial: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id,
    surface: id,
    contextSentence: `Satz mit ${id}.`,
    lessonId: 'L1',
    sentenceIndex: 0,
    hasTimestamp: true,
    suspended: false,
    fsrs: card(),
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ...partial,
  };
}

describe('buildReviewQueue', () => {
  it('到期的复习卡排在新卡前面', () => {
    const entries = [
      entry('neu'),
      entry('alt', { fsrs: card({ state: 2, reps: 5, due: NOW - DAY }) }),
    ];
    const { queue } = buildReviewQueue(entries, { newPerDay: 10, reviewPerDay: 60, now: NOW });
    expect(queue.map((e) => e.id)).toEqual(['alt', 'neu']);
  });

  it('未到期的复习卡不进队列', () => {
    const entries = [entry('spaeter', { fsrs: card({ state: 2, reps: 3, due: NOW + DAY }) })];
    const { queue, nextDueAt } = buildReviewQueue(entries, { newPerDay: 10, reviewPerDay: 60, now: NOW });
    expect(queue).toEqual([]);
    expect(nextDueAt).toBe(NOW + DAY);
  });

  it('newPerDay 限制新卡数量', () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry(`n${i}`));
    const { queue, newCount } = buildReviewQueue(entries, { newPerDay: 10, reviewPerDay: 60, now: NOW });
    expect(newCount).toBe(10);
    expect(queue).toHaveLength(10);
  });

  it('今天已经学过的新卡从额度里扣掉', () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) => entry(`n${i}`)),
      ...Array.from({ length: 3 }, (_, i) =>
        entry(`heute${i}`, { fsrs: card({ state: 1, reps: 1, last_review: NOW - 3600_000, due: NOW + DAY }) }),
      ),
    ];
    const { newCount } = buildReviewQueue(entries, { newPerDay: 5, reviewPerDay: 60, now: NOW });
    expect(newCount).toBe(2);
  });

  it('reviewPerDay 同样按今日已完成量扣减', () => {
    const entries = [
      ...Array.from({ length: 4 }, (_, i) =>
        entry(`due${i}`, { fsrs: card({ state: 2, reps: 4, due: NOW - DAY }) }),
      ),
      entry('erledigt', { fsrs: card({ state: 2, reps: 9, last_review: NOW - 3600_000, due: NOW + DAY }) }),
    ];
    const { reviewCount } = buildReviewQueue(entries, { newPerDay: 10, reviewPerDay: 3, now: NOW });
    expect(reviewCount).toBe(2);
  });

  it('suspended 的条目完全不参与', () => {
    const entries = [entry('pausiert', { suspended: true, fsrs: card({ state: 2, reps: 2, due: NOW - DAY }) })];
    const { queue, nextDueAt } = buildReviewQueue(entries, { newPerDay: 10, reviewPerDay: 60, now: NOW });
    expect(queue).toEqual([]);
    expect(nextDueAt).toBeNull();
  });

  it('复习卡按到期时间从早到晚', () => {
    const entries = [
      entry('spaet', { fsrs: card({ state: 2, reps: 2, due: NOW - 1000 }) }),
      entry('frueh', { fsrs: card({ state: 2, reps: 2, due: NOW - DAY }) }),
    ];
    const { queue } = buildReviewQueue(entries, { newPerDay: 10, reviewPerDay: 60, now: NOW });
    expect(queue.map((e) => e.id)).toEqual(['frueh', 'spaet']);
  });
});

describe('cardAudioStatus', () => {
  it('区分「没标注」和「本机没素材」两种无音频（FR-10.5）', () => {
    expect(cardAudioStatus(entry('a'), true)).toBe('ok');
    expect(cardAudioStatus(entry('b', { hasTimestamp: false }), true)).toBe('no-timestamp');
    expect(cardAudioStatus(entry('c'), false)).toBe('no-material');
  });

  it('没标注时优先报「没标注」—— 它才是根因，补素材也解决不了', () => {
    expect(cardAudioStatus(entry('d', { hasTimestamp: false }), false)).toBe('no-timestamp');
  });
});
