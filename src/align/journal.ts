// 自动对齐的「黑匣子」。存在的理由是一件具体的事故：
//
// 2026-09-01，iPhone（TestFlight 原生壳）上导入一课后自动对齐，进度条走到
// 「加载对齐模型 181 MB / 187.6 MB」，然后**整个应用直接消失** —— 没有报错、
// 没有 Banner、下次打开一切正常。这种失败方式是 try/catch 抓不到的：
// 进程被系统杀掉（jetsam）或原生层崩溃时，JS 根本没有机会跑任何一行收尾代码。
//
// 所以唯一能拿到证据的办法是**边跑边把面包屑落盘**：每次阶段变化就同步写一条，
// 下次启动看见「上一次运行的状态还是 running」就等于「上次是被杀掉的」，
// 而记录里的 stage / loaded / total / plan 直接说明它死在哪一步、用的哪套后端。
//
// ── 为什么用 localStorage 而不是 IndexedDB ──
// IndexedDB 是异步的：事务还没落盘进程就被杀了，写进去的东西可能整批丢。
// localStorage 的 setItem 是同步的，返回时数据已经交给存储层了 —— 这正是黑匣子要的性质。
// 代价是它只在主线程存在（Worker 里没有 localStorage），所以打点必须在主线程做，
// 对齐后端的选择也因此挪到主线程（见 client.ts 把 plan 传进 Worker 的那段）。

import type { RunPlan } from './config';

const KEY = 'align:journal';
const HISTORY_LIMIT = 6;

export type AlignStage = 'decode' | 'model' | 'infer' | 'align' | 'apply';

export interface AlignRunRecord {
  lessonId: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  plan: RunPlan;
  /**
   * PLAN_LADDER 里的第几档 —— 崩溃后降档要靠它。
   * 原生那一档是 `NATIVE_PLAN_STEP`（-1）：它不在阶梯上，也就不参与降档。
   */
  planStep: number;
  platform: string;
  weights: 'local' | 'cdn';
  /**
   * 随包权重是不是走了「按 Range 分片」那条路（rangedFetch.ts）。
   *
   * 这一位是那次 iPhone 崩溃修复的验收凭据：修好了它应该是 true。
   * 手边没有那台设备，只能让设备自己把答案写下来。
   */
  ranged?: boolean;
  stage: AlignStage;
  loaded?: number;
  total?: number;
  fraction?: number;
  /** Chromium 才有 performance.memory；Safari 没有，这里就是 undefined */
  heapMB?: number;
  status: 'running' | 'done' | 'error' | 'crashed';
  error?: string;
  finishedAt?: number;
}

interface Journal {
  /** 正在跑的那一次。它**没被正常收尾**就等于上次是崩溃退出 */
  active?: AlignRunRecord;
  history: AlignRunRecord[];
}

function read(): Journal {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { history: [] };
    const parsed = JSON.parse(raw) as Journal;
    return { active: parsed.active, history: parsed.history ?? [] };
  } catch {
    return { history: [] };
  }
}

function write(journal: Journal): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(journal));
  } catch {
    // 隐私模式 / 配额满 —— 黑匣子写不进去不该让对齐本身失败。
  }
}

function heapMB(): number | undefined {
  const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / 1048576) : undefined;
}

let active: AlignRunRecord | null = null;
let lastWriteAt = 0;

/** 一次运行开始。立刻落盘 —— 崩溃可能发生在下一毫秒。 */
export function beginRun(info: {
  lessonId: string;
  title: string;
  plan: RunPlan;
  planStep: number;
  platform: string;
  weights: 'local' | 'cdn';
  ranged?: boolean;
}): void {
  const now = Date.now();
  active = { ...info, startedAt: now, updatedAt: now, stage: 'decode', status: 'running', heapMB: heapMB() };
  const journal = read();
  write({ active, history: journal.history });
  lastWriteAt = now;
}

/**
 * 记一条进度。
 *
 * 进度回调在 model 阶段每几十 KB 就来一次，全写一遍 localStorage 会把主线程拖住，
 * 所以**阶段变化必写、其余节流 800ms**。节流的代价只是「死亡时刻的 loaded 值最多差 800ms」，
 * 而要的答案是「死在哪个阶段、大概多少字节」，这个精度足够。
 */
export function noteStage(patch: Partial<AlignRunRecord> & { stage: AlignStage }): void {
  if (!active) return;
  const stageChanged = patch.stage !== active.stage;
  active = { ...active, ...patch, updatedAt: Date.now(), heapMB: heapMB() };
  if (!stageChanged && Date.now() - lastWriteAt < 800) return;
  const journal = read();
  write({ active, history: journal.history });
  lastWriteAt = Date.now();
}

/**
 * 收尾。清掉 active 就等于告诉下次启动「这次不用当成被杀的来判」。
 *
 * `crashed` 也从这里进：Worker 被杀而主线程活着时，JS 是有机会收尾的
 * （见 client.ts 的 AlignWorkerDeath），但性质仍然是崩溃 —— 必须进 crashed 计数，
 * 否则 nextPlanStep() 不会降档，那一档会被无限重试。
 * 只有「整个 tab 一起死」才走 detectCrash() 那条路。
 */
export function finishRun(status: 'done' | 'error' | 'crashed', error?: string): void {
  if (!active) return;
  const record: AlignRunRecord = { ...active, status, error, finishedAt: Date.now(), updatedAt: Date.now() };
  active = null;
  const journal = read();
  write({ history: [record, ...journal.history].slice(0, HISTORY_LIMIT) });
}

/**
 * 启动时调一次：上一次运行有没有被系统杀掉。
 *
 * 返回非空就说明「上次跑到 stage 那一步时进程消失了」。这条记录同时被 nextPlanStep()
 * 用来降档 —— 同一套后端连崩两次就没有理由再试第三次。
 */
export function detectCrash(): AlignRunRecord | null {
  const journal = read();
  const stale = journal.active;
  if (!stale) return null;
  const record: AlignRunRecord = { ...stale, status: 'crashed', finishedAt: Date.now() };
  write({ history: [record, ...journal.history].slice(0, HISTORY_LIMIT) });
  return record;
}

export function readHistory(): AlignRunRecord[] {
  return read().history;
}

export function clearJournal(): void {
  active = null;
  write({ history: [] });
}

/** 崩过的档位（按 planStep 计数）。 */
export function crashedSteps(): Map<number, number> {
  const out = new Map<number, number>();
  for (const run of read().history) {
    if (run.status !== 'crashed') continue;
    out.set(run.planStep, (out.get(run.planStep) ?? 0) + 1);
  }
  return out;
}

/**
 * 下一次该用第几档后端。
 *
 * 规则很直白：某一档崩过就跳过它。全都崩过就回到第 0 档 ——
 * 那时候真正该做的是「换台设备预处理」，而不是在这里无限降档；
 * UI 会把崩溃记录摆出来说这句话。
 */
export function nextPlanStep(ladderLength: number): number {
  const crashed = crashedSteps();
  for (let step = 0; step < ladderLength; step++) {
    if (!crashed.has(step)) return step;
  }
  return 0;
}

/**
 * 两档都被系统杀过 —— 这台设备就是跑不动，不该再自动重试。
 *
 * 没有这条判断，「导入后自动对齐」会变成一个每次导入都把应用杀掉一次的循环：
 * 降档能救一次，救不了「两档都不行」。这时唯一诚实的话是「换台设备预处理，
 * 句级时间戳会跟着备份同步回来」—— 那句话由 UI 说，这里只给出判据。
 */
export function allPlansCrashed(ladderLength: number): boolean {
  const crashed = crashedSteps();
  for (let step = 0; step < ladderLength; step++) {
    if (!crashed.has(step)) return false;
  }
  return true;
}
