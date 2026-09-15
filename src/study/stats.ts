// FR-18.2：从逐日记录派生出要给人看的三个数 —— 今天多久、连续几天、一共几天。
//
// 纯函数，不碰 IndexedDB：这三个数会出现在分享图上发给别人，所以它们必须是
// 能穷举测试的东西，而不是散在组件里的几行 `filter().length`。

import { localDateKey, shiftDateKey, type StudyLog } from './log';

/**
 * 一天要学到多少秒才算「学过这一天」。
 *
 * 门槛存在的理由：打开应用看一眼到期张数、听半句就锁屏，这些都会留下十几秒的记录。
 * 把它们算成「连续学习的一天」是在骗自己，而这个数字要发给别人看。
 * 60 秒不是精确的界限，只是**明确低于任何一次真实练习**的一个值。
 */
export const MIN_STUDY_SECONDS = 60;

export interface StudyStats {
  /** 今天已经学了多少秒（未必过门槛） */
  todaySeconds: number;
  /** 连续学习天数（含今天；今天还没到门槛时，数到昨天为止） */
  streakDays: number;
  /** 一共学过多少天（过门槛的天数） */
  totalDays: number;
  /** 有记录以来的总秒数（所有天，不管过没过门槛） */
  totalSeconds: number;
}

/** 把「日期 → 设备 → 秒」压成「日期 → 秒」：同一天里各设备相加（见 log.ts 文件头）。 */
export function dailySeconds(log: StudyLog): Map<string, number> {
  const out = new Map<string, number>();
  for (const [date, cell] of Object.entries(log.days)) {
    let sum = 0;
    for (const seconds of Object.values(cell)) sum += seconds;
    if (sum > 0) out.set(date, sum);
  }
  return out;
}

/**
 * 连续天数。
 *
 * 今天还没学够时**不归零** —— 从昨天往回数。理由：一天还没过完，而「今天早上
 * 打开应用发现连续记录已经是 0」会让人觉得记录坏了。真的断了是在第二天体现的：
 * 昨天没学够，那时无论从今天还是昨天数，都数不出那一段。
 */
function computeStreak(byDay: Map<string, number>, today: string): number {
  const counts = (date: string) => (byDay.get(date) ?? 0) >= MIN_STUDY_SECONDS;

  let cursor = counts(today) ? today : shiftDateKey(today, -1);
  if (!counts(cursor)) return 0;

  let streak = 0;
  while (counts(cursor)) {
    streak++;
    cursor = shiftDateKey(cursor, -1);
  }
  return streak;
}

export function computeStudyStats(log: StudyLog, now: number = Date.now()): StudyStats {
  const byDay = dailySeconds(log);
  const today = localDateKey(now);

  let totalDays = 0;
  let totalSeconds = 0;
  for (const seconds of byDay.values()) {
    totalSeconds += seconds;
    if (seconds >= MIN_STUDY_SECONDS) totalDays++;
  }

  return {
    todaySeconds: byDay.get(today) ?? 0,
    streakDays: computeStreak(byDay, today),
    totalDays,
    totalSeconds,
  };
}

/** 最近 n 天（含今天）的每日秒数，从旧到新 —— 记录页上那排小柱子用。 */
export function recentDays(
  log: StudyLog,
  days: number,
  now: number = Date.now(),
): Array<{ date: string; seconds: number }> {
  const byDay = dailySeconds(log);
  const today = localDateKey(now);
  const out: Array<{ date: string; seconds: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = shiftDateKey(today, -i);
    out.push({ date, seconds: byDay.get(date) ?? 0 });
  }
  return out;
}

/**
 * 时长的中文写法。分享图和记录页共用同一个函数 —— 两处写法不一样的话，
 * 截图发出去之后对不上的是同一个人的同一天。
 *
 * 不足一分钟说「不到 1 分钟」而不是「0 分钟」：后者看起来像没记上。
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return '不到 1 分钟';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

/** 分享图上那种紧凑写法：`23 分钟` / `1 小时 05 分`（数字位数固定，不左右抖）。 */
export function formatDurationCompact(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  return `${h} 小时 ${String(minutes % 60).padStart(2, '0')} 分`;
}

/** 分享图上的日期：`2026 年 9 月 15 日`。 */
export function formatCardDate(now: number | Date = Date.now()): string {
  const d = now instanceof Date ? now : new Date(now);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
