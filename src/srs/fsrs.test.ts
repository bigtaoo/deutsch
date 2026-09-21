// 这个文件是**唯一**知道 ts-fsrs 存在的地方，它的职责是两件事：
//   1. Date ↔ epoch ms 的往返（存进 IndexedDB、走一趟备份 JSON 都不能变形）
//   2. 四档评分的相对次序 —— 复习界面上四个按钮的意义全靠它
// 所以这里不验 FSRS 的具体数值（那是 ts-fsrs 自己的事），只钉这两件。

import { describe, expect, it } from 'vitest';
import { formatInterval, newCard, previewIntervals, review } from './fsrs';

const NOW = new Date('2026-09-21T08:00:00Z');

describe('newCard', () => {
  it('是一张全新的卡：没复习过、没遗忘过、state 0', () => {
    const card = newCard(NOW);
    expect(card).toMatchObject({ reps: 0, lapses: 0, state: 0 });
    expect(card.last_review).toBeUndefined();
  });

  it('时间字段是数字（epoch ms），不是 Date —— 备份 JSON 走一趟不能变形', () => {
    const card = newCard(NOW);
    expect(typeof card.due).toBe('number');
    expect(JSON.parse(JSON.stringify(card))).toEqual(card);
  });

  it('新卡立刻到期 —— 今天导入的生词今天就该出现在队列里', () => {
    expect(newCard(NOW).due).toBeLessThanOrEqual(NOW.getTime());
  });
});

describe('review', () => {
  it('评过之后记下复习时刻与次数', () => {
    const card = review(newCard(NOW), 'good', NOW);
    expect(card.reps).toBe(1);
    expect(card.last_review).toBe(NOW.getTime());
    expect(typeof card.due).toBe('number');
  });

  it('四档的下次到期时间单调不减：again ≤ hard ≤ good ≤ easy', () => {
    const base = review(newCard(NOW), 'good', NOW);
    const later = new Date(base.due);
    const dues = (['again', 'hard', 'good', 'easy'] as const).map(
      (rating) => review(base, rating, later).due,
    );
    expect(dues[0]).toBeLessThanOrEqual(dues[1]);
    expect(dues[1]).toBeLessThanOrEqual(dues[2]);
    expect(dues[2]).toBeLessThanOrEqual(dues[3]);
  });

  it('again 记一次遗忘，good 不记', () => {
    const learned = review(review(review(newCard(NOW), 'good', NOW), 'good', NOW), 'good', NOW);
    expect(review(learned, 'again', NOW).lapses).toBeGreaterThan(learned.lapses);
    expect(review(learned, 'good', NOW).lapses).toBe(learned.lapses);
  });

  it('不改原卡 —— store 里那份要靠引用比较判断有没有变', () => {
    const card = newCard(NOW);
    const snapshot = { ...card };
    review(card, 'good', NOW);
    expect(card).toEqual(snapshot);
  });
});

describe('previewIntervals', () => {
  it('四档一次全算出来，且与真的评一次得到的到期时间一致', () => {
    const card = review(newCard(NOW), 'good', NOW);
    const at = new Date(card.due);
    const preview = previewIntervals(card, at);
    for (const rating of ['again', 'hard', 'good', 'easy'] as const) {
      expect(preview[rating].getTime()).toBe(review(card, rating, at).due);
    }
  });
});

describe('formatInterval', () => {
  const at = (ms: number) => formatInterval(new Date(NOW.getTime() + ms), NOW);

  it('一小时以内说分钟', () => {
    expect(at(10 * 60_000)).toBe('10 分钟');
    expect(at(59 * 60_000)).toBe('59 分钟');
  });

  it('一天以内说小时', () => {
    expect(at(2 * 3600_000)).toBe('2 小时');
    expect(at(23 * 3600_000)).toBe('23 小时');
  });

  it('一个月以内说天', () => {
    expect(at(3 * 86400_000)).toBe('3 天');
    expect(at(29 * 86400_000)).toBe('29 天');
  });

  it('一年以内说月', () => {
    expect(at(60 * 86400_000)).toBe('2 个月');
  });

  it('再久说年，带一位小数', () => {
    expect(at(540 * 86400_000)).toBe('1.5 年');
  });

  it('已经到期（差值 ≤ 0）也说「1 分钟」，不说「0 分钟」或负数', () => {
    expect(at(0)).toBe('1 分钟');
    expect(at(-5 * 60_000)).toBe('1 分钟');
  });
});
