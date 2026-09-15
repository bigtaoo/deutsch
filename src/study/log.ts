// FR-18：学习记录（每天学了多久）。
//
// 这是分享图（FR-18.4）的数据来源，但它本身不是为分享做的：在它之前，整个应用
// 没有任何地方知道「你昨天学没学」—— FSRS 只留每张卡**最后一次**复习的时刻，
// 课程只有 createdAt。也就是说「连续学了几天」在旧数据里是**推不出来**的，
// 所以这份记录从落地那天起攒，不回填（SPEC §0 变更 37）。
//
// ── 形状：日期 → 设备 → 秒数 ──
// 不是 `date → seconds` 一格一个数，而是每台设备在每一天占自己那一格：
//
//   { "2026-09-15": { "a3f1…": 900, "77c2…": 420 } }
//
// 理由是合并。两台设备同一天各学各的，而同步的合并必须**幂等**（同一份远端可能
// 被拉多次、409 之后还会再合一次）。「按天求和」不幂等，会越加越多；「按天取 max」
// 幂等，但会把手机上那 7 分钟直接吞掉。分设备存之后，两条性质同时成立：
// 逐格取 max 是幂等的，而展示时把一天里各格相加，谁也没丢。
//
// 设备 id 存在 meta 里且**不进备份、不进同步** —— 它是「这台机器」的名字，
// 恢复到新设备上就该是一个新名字，否则两台设备会抢同一格。

import { getMeta, putMeta } from '@/db/meta';
import { META_KEYS } from '@/db/schema';
import { generateId } from '@/lib/id';

export interface StudyLog {
  /** `YYYY-MM-DD`（本地日） → 设备 id → 当天在这台设备上的有效学习秒数 */
  days: Record<string, Record<string, number>>;
  /** 合并与同步的定序参考；真正的合并是逐格取 max，这个字段只用来判断「有没有变过」 */
  updatedAt: number;
}

export function emptyStudyLog(): StudyLog {
  return { days: {}, updatedAt: 0 };
}

/**
 * 本地日的键。**刻意用本地时区而不是 UTC**：「今天学了多久」说的是你这边的今天，
 * 而 UTC 会让晚上八点之后（中国）学的东西算进明天 —— 那正是 §2.1 说的主场景。
 */
export function localDateKey(at: number | Date = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 从某天往前/往后数 n 天的键。跨月、跨年、跨夏令时都交给 Date 自己算。 */
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return localDateKey(new Date(y, m - 1, d + days));
}

/** 纯函数：往某一天某台设备的格子里加秒数。不改入参。 */
export function addStudySeconds(
  log: StudyLog,
  date: string,
  deviceId: string,
  seconds: number,
  now = Date.now(),
): StudyLog {
  if (seconds <= 0) return log;
  const day = { ...(log.days[date] ?? {}) };
  day[deviceId] = Math.round((day[deviceId] ?? 0) + seconds);
  return { days: { ...log.days, [date]: day }, updatedAt: now };
}

/**
 * 合并两份记录：**逐格取 max**（§2.4 在这份数据上的落法）。
 *
 * 取 max 而不是求和，是因为同一台设备的同一天会被反复推送与拉取，求和会让
 * 那一格每同步一次就翻一倍。而「两台设备同一天都学了」不靠求和解决 ——
 * 它们本来就在不同的格子里。
 */
export function mergeStudyLogs(
  local: StudyLog,
  incoming: StudyLog,
): { merged: StudyLog; changed: boolean } {
  const days: StudyLog['days'] = {};
  let changed = false;

  for (const date of new Set([...Object.keys(local.days), ...Object.keys(incoming.days)])) {
    const a = local.days[date] ?? {};
    const b = incoming.days[date] ?? {};
    const cell: Record<string, number> = {};
    for (const device of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const av = a[device] ?? 0;
      const bv = b[device] ?? 0;
      cell[device] = Math.max(av, bv);
      if (cell[device] !== av) changed = true;
    }
    days[date] = cell;
  }

  return {
    merged: { days, updatedAt: Math.max(local.updatedAt, incoming.updatedAt) },
    changed,
  };
}

/** 本地是不是有远端没有（或比远端多）的东西 —— 调用方据此决定要不要回推。 */
export function studyLogNeedsPush(local: StudyLog, remote: StudyLog): boolean {
  for (const [date, cell] of Object.entries(local.days)) {
    const other = remote.days[date] ?? {};
    for (const [device, seconds] of Object.entries(cell)) {
      if (seconds > (other[device] ?? 0)) return true;
    }
  }
  return false;
}

// ── 落库 ──────────────────────────────────────────────────────────────────

export async function getStudyLog(): Promise<StudyLog> {
  const stored = await getMeta<StudyLog>(META_KEYS.studyLog);
  if (!stored || typeof stored !== 'object' || !stored.days) return emptyStudyLog();
  return { days: stored.days, updatedAt: stored.updatedAt ?? 0 };
}

export async function putStudyLog(log: StudyLog): Promise<void> {
  await putMeta(META_KEYS.studyLog, log);
}

let deviceIdPromise: Promise<string> | null = null;

/** 这台设备的 id。第一次调用时生成并落库；**不同步、不备份**（见文件头）。 */
export function getStudyDeviceId(): Promise<string> {
  deviceIdPromise ??= (async () => {
    const existing = await getMeta<string>(META_KEYS.studyDevice);
    if (typeof existing === 'string' && existing) return existing;
    const id = generateId();
    await putMeta(META_KEYS.studyDevice, id);
    return id;
  })();
  return deviceIdPromise;
}

/** 测试用：清掉进程内那份设备 id 缓存。 */
export function resetStudyDeviceIdCache(): void {
  deviceIdPromise = null;
}

/** 把一段有效学习时间记进今天（本机那一格）。返回写入后的整份记录。 */
export async function recordStudySeconds(seconds: number, now = Date.now()): Promise<StudyLog> {
  const log = await getStudyLog();
  if (seconds <= 0) return log;
  const deviceId = await getStudyDeviceId();
  const next = addStudySeconds(log, localDateKey(now), deviceId, seconds, now);
  await putStudyLog(next);
  return next;
}
