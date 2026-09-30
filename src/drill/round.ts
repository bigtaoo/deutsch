// FR-22.5 ~ FR-22.7：一轮怎么排、一道题怎么出、错了怎么再出。全是纯函数。

import type { FSRSCard } from '@/types/models';
import { progressKey } from './state';
import type { DrillMode, DrillState, PoolItem } from './types';

// ── 排一轮（FR-22.6）────────────────────────────────────────────────────

/** FNV-1a。新词按它排：看着随机、两台设备上顺序一致，而且不随每次打开变。 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export interface PoolSplit {
  /** 这个模式里到期的，按到期时间从早到晚。 */
  due: PoolItem[];
  /** 这个模式里还没学过的：我加的在前（按加入先后），其余按 id 哈希。 */
  fresh: PoolItem[];
}

export function splitPool(pool: readonly PoolItem[], state: DrillState, mode: DrillMode, now: number): PoolSplit {
  const due: { item: PoolItem; at: number }[] = [];
  const mine: { item: PoolItem; at: number }[] = [];
  const rest: { item: PoolItem; h: number }[] = [];
  for (const item of pool) {
    const p = state.progress[progressKey(mode, item.id)];
    if (p) {
      if (p.card.due <= now) due.push({ item, at: p.card.due });
    } else if (item.category === 'mine') {
      mine.push({ item, at: state.custom[item.id]?.ts ?? 0 });
    } else {
      rest.push({ item, h: hash(item.id) });
    }
  }
  due.sort((a, b) => a.at - b.at);
  mine.sort((a, b) => a.at - b.at);
  rest.sort((a, b) => a.h - b.h);
  return {
    due: due.map((d) => d.item),
    fresh: [...mine.map((d) => d.item), ...rest.map((d) => d.item)],
  };
}

/** 先到期、再新词，凑够 `size` 个。 */
export function planRound(
  pool: readonly PoolItem[],
  state: DrillState,
  mode: DrillMode,
  size: number,
  now: number,
): PoolItem[] {
  const { due, fresh } = splitPool(pool, state, mode, now);
  return [...due, ...fresh].slice(0, Math.max(1, size));
}

// ── 出题（FR-22.5）──────────────────────────────────────────────────────

export interface DrillChoice {
  /** 选项的来源词 id —— 中文可能重复，不能拿中文当 id。 */
  id: string;
  text: string;
  correct: boolean;
}

/** 主义项：`；` 前那一段，去掉括号里的补充。「（银行）扣款；直接借记」→「扣款」。 */
export function primaryZh(zh: string): string {
  return zh
    .split(/[；;]/)[0]
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim();
}

/**
 * 两条中文算不算「同一个意思」—— 算的话不能同时出现在一道题里，
 * 否则那是一道没有唯一正确答案的题。整句相同、主义项相同、或者一个主义项包含另一个，都算。
 */
export function sameMeaning(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const pa = primaryZh(a);
  const pb = primaryZh(b);
  if (!pa || !pb) return false;
  return pa === pb || pa.includes(pb) || pb.includes(pa);
}

export type Rng = () => number;

/**
 * 四个中文选项：正确的那条 + 三条干扰。干扰取**同词性**（不够再放宽到任意词性），
 * 与正确答案、以及彼此之间都不能「同一个意思」。
 *
 * 池子有六千个词，不整个洗牌：随机抽下标，抽够为止（上限几百次，池子太小就少给几个）。
 */
export function buildDrillChoices(item: PoolItem, pool: readonly PoolItem[], rng: Rng = Math.random): DrillChoice[] {
  const picked: PoolItem[] = [];
  const ok = (c: PoolItem) =>
    c.id !== item.id &&
    c.zh.trim() !== '' &&
    !sameMeaning(c.zh, item.zh) &&
    !picked.some((p) => p.id === c.id || sameMeaning(p.zh, c.zh));

  const samePos = pool.filter((c) => c.p === item.p);
  for (const source of [samePos, pool]) {
    for (let tries = 0; picked.length < 3 && tries < 400 && source.length > 0; tries++) {
      const c = source[Math.floor(rng() * source.length)];
      if (ok(c)) picked.push(c);
    }
    if (picked.length >= 3) break;
  }

  const choices: DrillChoice[] = [
    { id: item.id, text: item.zh, correct: true },
    ...picked.map((c) => ({ id: c.id, text: c.zh, correct: false })),
  ];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return choices;
}

// ── 一轮之内（FR-22.7）──────────────────────────────────────────────────

/** 错了的词插回几张之后。太近是背答案，太远一轮就结束了。 */
export const RETRY_GAP = 3;

export interface RoundRun {
  /** 这一轮要出的题，按顺序；错题会被插进来，所以同一个 id 可能出现多次。 */
  queue: string[];
  position: number;
  /** 每个词**第一次**作答的结果。只有这一次进调度。 */
  first: Record<string, boolean>;
}

export function startRun(items: readonly PoolItem[]): RoundRun {
  return { queue: items.map((i) => i.id), position: 0, first: {} };
}

/** 这一张是不是本轮里的重做（已经答过一次了）。 */
export function isRetry(run: RoundRun): boolean {
  const id = run.queue[run.position];
  return id !== undefined && id in run.first;
}

/** 记下这一次作答，并决定错题插回哪里。返回新的 run（position 还没前进）。 */
export function recordAnswer(run: RoundRun, correct: boolean): RoundRun {
  const id = run.queue[run.position];
  if (id === undefined) return run;
  const first = id in run.first ? run.first : { ...run.first, [id]: correct };
  if (correct) return { ...run, first };
  const queue = [...run.queue];
  const at = Math.min(queue.length, run.position + 1 + RETRY_GAP);
  queue.splice(at, 0, id);
  return { ...run, queue, first };
}

export function advanceRun(run: RoundRun): RoundRun {
  return { ...run, position: run.position + 1 };
}

export function runFinished(run: RoundRun): boolean {
  return run.position >= run.queue.length;
}

/** 一轮结束时的小结：一共几个词、一次答对几个、错过的是哪些。 */
export function summarizeRun(run: RoundRun): { total: number; firstTry: number; missed: string[] } {
  const ids = Object.keys(run.first);
  return {
    total: ids.length,
    firstTry: ids.filter((id) => run.first[id]).length,
    missed: ids.filter((id) => !run.first[id]),
  };
}

/** 这个词在这个模式下的调度卡；没学过是 undefined（调用方用 newCard()）。 */
export function cardOf(state: DrillState, mode: DrillMode, itemId: string): FSRSCard | undefined {
  return state.progress[progressKey(mode, itemId)]?.card;
}
