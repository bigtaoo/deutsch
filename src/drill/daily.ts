// FR-22.6′ / FR-22.13 / FR-22.17：每天 200 个，到期先排、新词补满（变更 84）。全是纯函数。
//
// ── 为什么计划要存下来 ──
// 到期的词一答完就不再到期。现算的话，「今天 x / 200」的分母会随着背而缩，
// 背完 50 个复习之后新词又被补进来 —— 永远背不完。所以每天第一次打开时排一份，存进 `drill.day`。
//
// ── 为什么「做完没有」不存在计划里 ──
// 看那个词进度的 `last_review` 是不是今天。进度逐键合并，桌面背前一百个、手机背后一百个，
// 两边合起来的数是对的；而一份「做完列表」整份 LWW 会让后推的那台把另一台的抹掉。

import type { FSRSCard } from '@/types/models';
import { progressKey } from './state';
import type { DrillState, PoolItem } from './types';

export const DAILY_TARGET = 200;

/** 本地日期 `YYYY-MM-DD`。「今天」按人所在的时区算，不按 UTC。 */
export function localDate(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfNextDay(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * 这个词的进度（FR-22.4′ 两种模式合并）：`word:` 键优先；只有 `audio:` 旧进度时拿它当起点。
 * 两个都有时取最近复习过的那张 —— 那是对这个词最新的判断。
 */
export function unifiedCard(state: DrillState, id: string): FSRSCard | undefined {
  const w = state.progress[progressKey('word', id)]?.card;
  const a = state.progress[progressKey('audio', id)]?.card;
  if (!w) return a;
  if (!a) return w;
  return (a.last_review ?? 0) > (w.last_review ?? 0) ? a : w;
}

export function isKnown(state: DrillState, id: string): boolean {
  return state.marks[id]?.known === true;
}

/** 今天做过没有：斩掉了，或者进度的 last_review 落在今天。 */
export function doneToday(state: DrillState, id: string, now: number): boolean {
  if (isKnown(state, id)) return true;
  const card = unifiedCard(state, id);
  return Boolean(card?.last_review && card.last_review >= startOfLocalDay(now));
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 新词的出场档位：课程来的 → 查词来的 → 其余手动词 → 词库。 */
function freshTier(item: PoolItem): number {
  if (item.category !== 'mine') return 3;
  if (item.src === 'lesson') return 0;
  if (item.src === 'lookup') return 1;
  return 2;
}

export interface DayCandidates {
  /** 今天之内到期的，按到期时间从早到晚。 */
  due: PoolItem[];
  /** 从没学过的，按 FR-22.6′ 的优先级。 */
  fresh: PoolItem[];
}

/**
 * 能进今天计划的词。斩掉的、没有中文的（出不了四选一）不算。
 * 到期判到「今天结束」为止：早上排计划时，下午才到期的词也该在今天背。
 */
export function dayCandidates(pool: readonly PoolItem[], state: DrillState, now: number): DayCandidates {
  const horizon = startOfNextDay(now);
  const today = startOfLocalDay(now);
  const due: { item: PoolItem; at: number }[] = [];
  const fresh: PoolItem[] = [];
  for (const item of pool) {
    if (!item.zh.trim() || isKnown(state, item.id)) continue;
    const card = unifiedCard(state, item.id);
    if (card) {
      // 今天已经复习过的不再排（FSRS 不做当日重复）
      if (card.due < horizon && !(card.last_review && card.last_review >= today)) due.push({ item, at: card.due });
    } else {
      fresh.push(item);
    }
  }
  due.sort((a, b) => a.at - b.at);
  fresh.sort((a, b) => {
    const ta = freshTier(a);
    const tb = freshTier(b);
    if (ta !== tb) return ta - tb;
    // 课程词与查词：新加的在前（「最近课程的词」）；其余手动词按加入先后；词库按哈希
    if (ta <= 1) return (b.addedAt ?? 0) - (a.addedAt ?? 0);
    if (ta === 2) return (a.addedAt ?? 0) - (b.addedAt ?? 0);
    return hash(a.id) - hash(b.id);
  });
  return { due: due.map((d) => d.item), fresh };
}

/**
 * 今天的计划。已经有今天的就**只补不换**：不满 200 时把新出现的到期词 / 新词接在后面
 * （当天自动加入的课程词由此进来）；满了原样返回。返回 null = 不用改。
 */
export function planDay(
  pool: readonly PoolItem[],
  state: DrillState,
  now: number,
  target: number = DAILY_TARGET,
): string[] | null {
  const date = localDate(now);
  const existing = state.day?.date === date ? state.day.ids : null;
  if (existing && existing.length >= target) return null;
  const { due, fresh } = dayCandidates(pool, state, now);
  const taken = new Set(existing ?? []);
  const ids = [...(existing ?? [])];
  for (const item of [...due, ...fresh]) {
    if (ids.length >= target) break;
    if (taken.has(item.id)) continue;
    ids.push(item.id);
    taken.add(item.id);
  }
  if (existing && ids.length === existing.length) return null;
  return ids;
}

export interface DayProgress {
  /** 计划里的个数（通常 200；词不够时更少）。 */
  total: number;
  done: number;
  /** 还没做的，按计划顺序；池子里已经没有的词（删了、范围取消了）跳过。 */
  remaining: string[];
  /** 剩下的里面有多少是复习（有进度的）、多少是新词 —— 今日卡片那一行 `text-note`。 */
  remainingReview: number;
  remainingNew: number;
}

export function dayProgress(state: DrillState, poolIds: ReadonlySet<string>, now: number): DayProgress | null {
  if (!state.day || state.day.date !== localDate(now)) return null;
  const remaining: string[] = [];
  let remainingReview = 0;
  for (const id of state.day.ids) {
    if (doneToday(state, id, now) || !poolIds.has(id)) continue;
    remaining.push(id);
    if (unifiedCard(state, id)) remainingReview++;
  }
  const total = state.day.ids.length;
  return {
    total,
    done: total - remaining.length,
    remaining,
    remainingReview,
    remainingNew: remaining.length - remainingReview,
  };
}

/** 角标（FR-22.17）：有今天的计划就数剩下的；还没排就估一个。 */
export function remainingToday(pool: readonly PoolItem[], state: DrillState, now: number): number {
  const progress = dayProgress(state, new Set(pool.map((p) => p.id)), now);
  if (progress) return progress.remaining.length;
  const { due, fresh } = dayCandidates(pool, state, now);
  return Math.min(DAILY_TARGET, due.length + fresh.length);
}
