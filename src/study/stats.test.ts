import { describe, expect, it } from 'vitest';
import {
  MIN_STUDY_SECONDS,
  computeStudyStats,
  dailySeconds,
  formatCardDate,
  formatDuration,
  formatDurationCompact,
  recentDays,
} from './stats';
import type { StudyLog } from './log';

const NOW = new Date(2026, 8, 15, 21, 0).getTime(); // 2026-09-15

function logOf(days: Record<string, number>): StudyLog {
  return {
    days: Object.fromEntries(Object.entries(days).map(([d, s]) => [d, { 'dev-a': s }])),
    updatedAt: NOW,
  };
}

describe('dailySeconds', () => {
  it('同一天的多台设备相加', () => {
    const log: StudyLog = { days: { '2026-09-15': { a: 900, b: 420 } }, updatedAt: NOW };
    expect(dailySeconds(log).get('2026-09-15')).toBe(1320);
  });
});

describe('computeStudyStats', () => {
  it('空记录全是 0', () => {
    expect(computeStudyStats({ days: {}, updatedAt: 0 }, NOW)).toEqual({
      todaySeconds: 0,
      streakDays: 0,
      totalDays: 0,
      totalSeconds: 0,
    });
  });

  it('连着三天都学够了 —— 连续 3 天', () => {
    const stats = computeStudyStats(
      logOf({ '2026-09-13': 600, '2026-09-14': 600, '2026-09-15': 600 }),
      NOW,
    );
    expect(stats.streakDays).toBe(3);
    expect(stats.totalDays).toBe(3);
    expect(stats.todaySeconds).toBe(600);
  });

  it('今天还没学够时不归零，数到昨天为止', () => {
    const stats = computeStudyStats(logOf({ '2026-09-13': 600, '2026-09-14': 600 }), NOW);
    expect(stats.streakDays).toBe(2);
    expect(stats.todaySeconds).toBe(0);
  });

  it('昨天断了就是断了 —— 今天学了也只算 1 天', () => {
    const stats = computeStudyStats(logOf({ '2026-09-12': 600, '2026-09-15': 600 }), NOW);
    expect(stats.streakDays).toBe(1);
    expect(stats.totalDays).toBe(2);
  });

  it('不到门槛的那天不算「学过的一天」，也会断掉连续', () => {
    const stats = computeStudyStats(
      logOf({ '2026-09-13': 600, '2026-09-14': MIN_STUDY_SECONDS - 1, '2026-09-15': 600 }),
      NOW,
    );
    expect(stats.streakDays).toBe(1);
    expect(stats.totalDays).toBe(2);
    // 但那 59 秒仍然记在总时长里 —— 它确实发生过
    expect(stats.totalSeconds).toBe(600 + MIN_STUDY_SECONDS - 1 + 600);
  });

  it('未来的日期不影响今天的连续（钟差导致的记录）', () => {
    const stats = computeStudyStats(logOf({ '2026-09-16': 600, '2026-09-15': 600 }), NOW);
    expect(stats.streakDays).toBe(1);
  });
});

describe('recentDays', () => {
  it('长度固定、末位是今天、缺的天补 0', () => {
    const days = recentDays(logOf({ '2026-09-15': 600, '2026-09-10': 300 }), 7, NOW);
    expect(days).toHaveLength(7);
    expect(days[6]).toEqual({ date: '2026-09-15', seconds: 600 });
    expect(days[1]).toEqual({ date: '2026-09-10', seconds: 300 });
    expect(days[2].seconds).toBe(0);
  });
});

describe('formatDuration', () => {
  it('不足一分钟不说「0 分钟」', () => {
    expect(formatDuration(0)).toBe('不到 1 分钟');
    expect(formatDuration(59)).toBe('不到 1 分钟');
  });

  it('分钟与小时', () => {
    expect(formatDuration(60)).toBe('1 分钟');
    expect(formatDuration(23 * 60 + 40)).toBe('23 分钟');
    expect(formatDuration(3600)).toBe('1 小时');
    expect(formatDuration(3600 + 5 * 60)).toBe('1 小时 5 分');
  });

  it('图上那种紧凑写法分钟数补零', () => {
    expect(formatDurationCompact(0)).toBe('0 分钟');
    expect(formatDurationCompact(3600 + 5 * 60)).toBe('1 小时 05 分');
  });
});

describe('formatCardDate', () => {
  it('中文日期', () => {
    expect(formatCardDate(new Date(2026, 8, 15))).toBe('2026 年 9 月 15 日');
  });
});
