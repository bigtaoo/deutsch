// FR-22.11：速背的标注层 —— 进度、我加的词、标记、偏好。
//
// ── 合并：逐键 last-write-wins ──
// 不是整份比 updatedAt：桌面上练音频、手机上练单词，整份覆盖会让后推的那台
// 把前一台一整轮的进度抹掉。四个部分各自按键比 `ts`，相等时保留本地（确定性优先）。
// 删掉的手动词留墓碑（deleted + ts），墓碑也参与比较 —— 否则另一台设备会把它复活。

import { getMeta, putMeta } from '@/db/meta';
import { META_KEYS } from '@/db/schema';
import type {
  DrillCategory,
  DrillCustomItem,
  DrillMark,
  DrillMode,
  DrillPrefs,
  DrillProgress,
  DrillState,
} from './types';
import type { FSRSCard } from '@/types/models';

export const ROUND_SIZES = [10, 20, 30, 50] as const;

export function defaultPrefs(): DrillPrefs {
  return { mode: 'audio', roundSize: 20, categories: ['daily', 'work', 'it', 'mine'], ts: 0 };
}

export function emptyDrillState(): DrillState {
  return { progress: {}, custom: {}, marks: {}, prefs: defaultPrefs(), updatedAt: 0 };
}

export function progressKey(mode: DrillMode, itemId: string): string {
  return `${mode}:${itemId}`;
}

/** 老数据 / 坏数据补齐成完整形状。同步拉下来的、备份里读出来的都先过一遍这里。 */
export function normalizeDrillState(raw: unknown): DrillState {
  const base = emptyDrillState();
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Partial<DrillState>;
  const prefs = s.prefs && typeof s.prefs === 'object' ? { ...base.prefs, ...s.prefs } : base.prefs;
  return {
    progress: s.progress && typeof s.progress === 'object' ? s.progress : {},
    custom: s.custom && typeof s.custom === 'object' ? s.custom : {},
    marks: s.marks && typeof s.marks === 'object' ? s.marks : {},
    prefs,
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
  };
}

function mergeMap<T extends { ts: number }>(
  local: Record<string, T>,
  incoming: Record<string, T>,
): { merged: Record<string, T>; changed: boolean } {
  const merged: Record<string, T> = { ...local };
  let changed = false;
  for (const [key, b] of Object.entries(incoming)) {
    const a = local[key];
    if (!a || b.ts > a.ts) {
      merged[key] = b;
      changed = true;
    }
  }
  return { merged, changed };
}

/** 合并两份速背状态。`changed` = 远端有本地没有（或更新）的东西，本地要写回。 */
export function mergeDrillStates(local: DrillState, incoming: DrillState): { merged: DrillState; changed: boolean } {
  const a = normalizeDrillState(local);
  const b = normalizeDrillState(incoming);
  const progress = mergeMap(a.progress, b.progress);
  const custom = mergeMap(a.custom, b.custom);
  const marks = mergeMap(a.marks, b.marks);
  const prefsChanged = b.prefs.ts > a.prefs.ts;
  const changed = progress.changed || custom.changed || marks.changed || prefsChanged;
  return {
    merged: {
      progress: progress.merged,
      custom: custom.merged,
      marks: marks.merged,
      prefs: prefsChanged ? b.prefs : a.prefs,
      updatedAt: Math.max(a.updatedAt, b.updatedAt),
    },
    changed,
  };
}

function hasNewer<T extends { ts: number }>(local: Record<string, T>, remote: Record<string, T>): boolean {
  for (const [key, entry] of Object.entries(local)) {
    const other = remote[key];
    if (!other || entry.ts > other.ts) return true;
  }
  return false;
}

/** 本地是不是有远端没有（或比远端新）的东西 —— 有就要回推。 */
export function drillNeedsPush(local: DrillState, remote: DrillState): boolean {
  const a = normalizeDrillState(local);
  const b = normalizeDrillState(remote);
  return (
    hasNewer(a.progress, b.progress) ||
    hasNewer(a.custom, b.custom) ||
    hasNewer(a.marks, b.marks) ||
    a.prefs.ts > b.prefs.ts
  );
}

// ── 纯变换：每一种改动都盖上 ts ─────────────────────────────────────────

export function withProgress(state: DrillState, mode: DrillMode, itemId: string, card: FSRSCard, now: number): DrillState {
  const entry: DrillProgress = { card, ts: now };
  return { ...state, progress: { ...state.progress, [progressKey(mode, itemId)]: entry }, updatedAt: now };
}

export function withMark(state: DrillState, itemId: string, patch: Partial<Omit<DrillMark, 'ts'>>, now: number): DrillState {
  const prev = state.marks[itemId];
  const next: DrillMark = { flagged: prev?.flagged ?? false, zh: prev?.zh, ...patch, ts: now };
  return { ...state, marks: { ...state.marks, [itemId]: next }, updatedAt: now };
}

export function withCustom(state: DrillState, item: Omit<DrillCustomItem, 'ts'>, now: number): DrillState {
  return { ...state, custom: { ...state.custom, [item.id]: { ...item, ts: now } }, updatedAt: now };
}

export function withoutCustom(state: DrillState, itemId: string, now: number): DrillState {
  const prev = state.custom[itemId];
  if (!prev) return state;
  return {
    ...state,
    custom: { ...state.custom, [itemId]: { ...prev, deleted: true, ts: now } },
    updatedAt: now,
  };
}

export function withPrefs(state: DrillState, patch: Partial<Omit<DrillPrefs, 'ts'>>, now: number): DrillState {
  let categories: DrillCategory[] = patch.categories ?? state.prefs.categories;
  if (categories.length === 0) categories = state.prefs.categories; // 至少留一个（§12.21）
  return { ...state, prefs: { ...state.prefs, ...patch, categories, ts: now }, updatedAt: now };
}

// ── 落库 ──────────────────────────────────────────────────────────────────

export async function getDrillState(): Promise<DrillState> {
  return normalizeDrillState(await getMeta<DrillState>(META_KEYS.drill));
}

export async function putDrillState(state: DrillState): Promise<void> {
  await putMeta(META_KEYS.drill, state);
}

/**
 * 读 → 改 → 写，一次完成。调用方负责之后触发同步（scheduleDrillSync）。
 *
 * **串行化**：连着答两题时两次更新可能交错（都读到旧的那份，后写的把先写的覆盖掉）。
 * 所有写都排进同一条 promise 链。
 */
let chain: Promise<unknown> = Promise.resolve();

export function updateDrillState(fn: (state: DrillState) => DrillState): Promise<DrillState> {
  const run = chain.then(async () => {
    const next = fn(await getDrillState());
    await putDrillState(next);
    return next;
  });
  chain = run.catch(() => undefined);
  return run;
}
