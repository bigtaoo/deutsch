// FR-22.6′ / 22.13 / 22.17：每天 200 个怎么排、做没做完怎么判（变更 84）。全是纯函数。
//
// 写错的症状都是「数不对」：分母随着背而缩（永远背不完）、两台设备各背一半合起来只算一半、
// 斩掉的词明天又出来。

import { describe, expect, it } from 'vitest';
import { newCard } from '@/srs/fsrs';
import type { FSRSCard } from '@/types/models';
import { dayCandidates, dayProgress, doneToday, localDate, planDay, remainingToday, startOfLocalDay, unifiedCard } from './daily';
import { emptyDrillState, withDay, withMark, withProgress } from './state';
import type { DrillState, PoolItem } from './types';

const NOW = new Date(2026, 10, 9, 15, 0, 0).getTime();
const TODAY = startOfLocalDay(NOW);
const DAY = 86_400_000;

function item(id: string, extra: Partial<PoolItem> = {}): PoolItem {
  return { id, w: id, p: 'noun', zh: `zh-${id}`, category: 'daily', ...extra };
}

function card(due: number, lastReview?: number): FSRSCard {
  return { ...newCard(new Date(0)), state: 2, reps: 1, due, ...(lastReview !== undefined ? { last_review: lastReview } : {}) };
}

describe('localDate / startOfLocalDay', () => {
  it('按本地时区算「今天」', () => {
    expect(localDate(NOW)).toBe('2026-11-09');
    expect(new Date(TODAY).getHours()).toBe(0);
    expect(localDate(TODAY - 1)).toBe('2026-11-08');
  });
});

describe('unifiedCard：两种旧模式合成一份进度（FR-22.4′）', () => {
  it('只有 audio: 时拿它当起点', () => {
    const s = withProgress(emptyDrillState(), 'audio', 'a', card(5, 1), 1);
    expect(unifiedCard(s, 'a')?.due).toBe(5);
  });

  it('两个都有时取最近复习过的那张', () => {
    let s = withProgress(emptyDrillState(), 'word', 'a', card(5, 10), 1);
    s = withProgress(s, 'audio', 'a', card(9, 20), 2);
    expect(unifiedCard(s, 'a')?.due).toBe(9);
    s = withProgress(s, 'word', 'a', card(7, 30), 3);
    expect(unifiedCard(s, 'a')?.due).toBe(7);
  });

  it('没学过是 undefined', () => {
    expect(unifiedCard(emptyDrillState(), 'a')).toBeUndefined();
  });
});

describe('doneToday', () => {
  it('今天复习过的算做完，昨天的不算', () => {
    let s = withProgress(emptyDrillState(), 'word', 'a', card(NOW + DAY, TODAY + 1000), 1);
    s = withProgress(s, 'word', 'b', card(NOW + DAY, TODAY - 1000), 1);
    expect(doneToday(s, 'a', NOW)).toBe(true);
    expect(doneToday(s, 'b', NOW)).toBe(false);
  });

  it('斩掉的算做完', () => {
    const s = withMark(emptyDrillState(), 'a', { known: true }, 1);
    expect(doneToday(s, 'a', NOW)).toBe(true);
  });
});

describe('dayCandidates：到期在前，新词按来源排', () => {
  it('到期判到今天结束为止、按到期先后；明天才到期的不排', () => {
    let s = withProgress(emptyDrillState(), 'word', 'late', card(TODAY + 20 * 3600_000, TODAY - DAY), 1);
    s = withProgress(s, 'word', 'early', card(TODAY - DAY, TODAY - 2 * DAY), 1);
    s = withProgress(s, 'word', 'tomorrow', card(TODAY + DAY + 1000, TODAY - DAY), 1);
    const { due } = dayCandidates([item('late'), item('early'), item('tomorrow')], s, NOW);
    expect(due.map((i) => i.id)).toEqual(['early', 'late']);
  });

  it('今天已经复习过的不再排（不做当日重复）', () => {
    const s = withProgress(emptyDrillState(), 'word', 'a', card(TODAY + 3600_000, TODAY + 1000), 1);
    expect(dayCandidates([item('a')], s, NOW).due).toEqual([]);
  });

  it('斩掉的、没中文的不进候选', () => {
    const s = withMark(emptyDrillState(), 'k', { known: true }, 1);
    const { fresh } = dayCandidates([item('k'), item('nozh', { zh: ' ' }), item('ok')], s, NOW);
    expect(fresh.map((i) => i.id)).toEqual(['ok']);
  });

  it('新词：课程词（新加的在前）→ 查词 → 其余手动词（先加的在前）→ 词库', () => {
    const pool = [
      item('bank1'),
      item('mine-old', { category: 'mine', addedAt: 1 }),
      item('mine-new', { category: 'mine', addedAt: 2 }),
      item('lookup', { category: 'mine', src: 'lookup', addedAt: 5 }),
      item('lesson-old', { category: 'mine', src: 'lesson', addedAt: 3 }),
      item('lesson-new', { category: 'mine', src: 'lesson', addedAt: 4 }),
    ];
    const { fresh } = dayCandidates(pool, emptyDrillState(), NOW);
    expect(fresh.map((i) => i.id)).toEqual(['lesson-new', 'lesson-old', 'lookup', 'mine-old', 'mine-new', 'bank1']);
  });
});

describe('planDay：只补不换', () => {
  const pool = Array.from({ length: 10 }, (_, i) => item(`w${i}`));

  it('第一次：先到期、再新词，凑够 target', () => {
    const s = withProgress(emptyDrillState(), 'word', 'w9', card(TODAY - DAY, TODAY - 2 * DAY), 1);
    const ids = planDay(pool, s, NOW, 4)!;
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe('w9');
  });

  it('今天的已经满了：不改（返回 null）—— 分母不随着背而缩', () => {
    const s = withDay(emptyDrillState(), { date: localDate(NOW), ids: ['w0', 'w1', 'w2', 'w3'] }, 1);
    expect(planDay(pool, s, NOW, 4)).toBeNull();
  });

  it('没满：原来的顺序不动，新出现的接在后面（当天自动加入的课程词由此进来）', () => {
    const s = withDay(emptyDrillState(), { date: localDate(NOW), ids: ['w5', 'w6'] }, 1);
    const ids = planDay([...pool, item('lesson', { category: 'mine', src: 'lesson', addedAt: 9 })], s, NOW, 4)!;
    expect(ids.slice(0, 3)).toEqual(['w5', 'w6', 'lesson']);
    expect(ids).toHaveLength(4);
  });

  it('没满但也没有新东西可补：null', () => {
    const s = withDay(emptyDrillState(), { date: localDate(NOW), ids: pool.map((p) => p.id) }, 1);
    expect(planDay(pool, s, NOW, 20)).toBeNull();
  });

  it('昨天的计划不算：重新排', () => {
    const s = withDay(emptyDrillState(), { date: localDate(NOW - DAY), ids: ['w0'] }, 1);
    expect(planDay(pool, s, NOW, 3)).toHaveLength(3);
  });
});

describe('dayProgress / remainingToday', () => {
  const pool = ['a', 'b', 'c', 'd'].map((id) => item(id));
  const ids = new Set(pool.map((p) => p.id));

  function planned(): DrillState {
    let s = withDay(emptyDrillState(), { date: localDate(NOW), ids: ['a', 'b', 'c', 'd'] }, 1);
    s = withProgress(s, 'word', 'a', card(NOW + DAY, TODAY + 1000), 2); // 今天背过
    s = withProgress(s, 'word', 'b', card(TODAY, TODAY - DAY), 2); // 到期复习，今天还没背
    s = withMark(s, 'c', { known: true }, 3); // 斩了
    return s;
  }

  it('做完 = 今天复习过 + 斩掉的；剩下的分「复习 / 新词」', () => {
    expect(dayProgress(planned(), ids, NOW)).toMatchObject({
      total: 4,
      done: 2,
      remaining: ['b', 'd'],
      remainingReview: 1,
      remainingNew: 1,
    });
    expect(remainingToday(pool, planned(), NOW)).toBe(2);
  });

  it('池子里已经没有的词（范围取消了）跳过', () => {
    expect(dayProgress(planned(), new Set(['a', 'b', 'c']), NOW)?.remaining).toEqual(['b']);
  });

  it('不是今天的计划：null；角标退回估算', () => {
    const s = withDay(emptyDrillState(), { date: localDate(NOW - DAY), ids: ['a'] }, 1);
    expect(dayProgress(s, ids, NOW)).toBeNull();
    expect(remainingToday(pool, s, NOW)).toBe(4);
  });

  it('两台设备各背一部分：进度逐键合并后计数是两边之和（做完不靠一份整份 LWW 的列表）', () => {
    let s = withDay(emptyDrillState(), { date: localDate(NOW), ids: ['a', 'b', 'c', 'd'] }, 1);
    s = withProgress(s, 'word', 'a', card(NOW + DAY, TODAY + 1), 2);
    s = withProgress(s, 'word', 'b', card(NOW + DAY, TODAY + 2), 3);
    s = withProgress(s, 'word', 'c', card(NOW + DAY, TODAY + 3), 4);
    expect(dayProgress(s, ids, NOW)?.done).toBe(3);
  });
});
