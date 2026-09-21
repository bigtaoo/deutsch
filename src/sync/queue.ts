// FR-11.10：推送失败 → 显式报警；离线时排队、恢复网络后自动重试。
// 队列落在 IndexedDB 的 meta store 里，不是纯内存 —— 手机在弱网下复习到一半被系统杀掉，
// 排队的推送不能跟着消失。
//
// 这个文件是 GitHub 方案留下来的原物（只多了一种 kind）：队列语义跟后端是谁无关。

import { getMeta, putMeta } from '@/db/meta';
import { generateId } from '@/lib/id';

export type QueuedPushKind = 'vocab' | 'lesson' | 'lesson-delete' | 'settings' | 'study';

export interface QueuedPush {
  id: string;
  kind: QueuedPushKind;
  /** vocab / settings / study 推送忽略此字段；lesson 推送时是 Lesson.id，用于同一课多次入队时去重取最新一条 */
  lessonId?: string;
  enqueuedAt: number;
  /**
   * 「去抖窗口还没到」而不是「推失败了」（§0 变更 43，见 markPending）。
   *
   * 两者在队列里长得一样、drain 起来也一样，区别只在**要不要报警**：
   * 失败项是故障（FR-11.9 的「待推送 N 项」数的就是它），标脏项是每次改动后
   * 都会出现几十秒的正常状态，数进去只会让那个数字一直黄着。
   */
  deferred?: boolean;
}

const QUEUE_META_KEY = 'syncPushQueue';

export async function getQueue(): Promise<QueuedPush[]> {
  return (await getMeta<QueuedPush[]>(QUEUE_META_KEY)) ?? [];
}

/** 'lesson' 与 'lesson-delete' 是同一课的两种互斥意图，后来的那个作废前面的。 */
function conflicts(item: QueuedPush, kind: QueuedPushKind, lessonId?: string): boolean {
  if (item.lessonId !== lessonId) return false;
  if (item.kind === kind) return true;
  return (
    (kind === 'lesson-delete' && item.kind === 'lesson') ||
    (kind === 'lesson' && item.kind === 'lesson-delete')
  );
}

/**
 * 入队。同一 lessonId 的旧排队项会被替换掉 —— 只需要推最新状态，
 * 排队多条旧版本毫无意义，还会在恢复网络后按错误顺序覆盖。
 *
 * 「删掉一课」和「这课刚改过」尤其不能同时留在队列里：那样一次 drain 会先删再建，
 * 把删掉的课在远端复活。
 */
export async function enqueuePush(kind: QueuedPushKind, lessonId?: string): Promise<void> {
  const queue = await getQueue();
  const withoutStale = queue.filter((item) => !conflicts(item, kind, lessonId));
  withoutStale.push({ id: generateId(), kind, lessonId, enqueuedAt: Date.now() });
  await putMeta(QUEUE_META_KEY, withoutStale);
}

/**
 * 标脏：这一项本地改过、还没推上去。
 *
 * **为什么要落库**：去抖的定时器只活在内存里（trigger.ts，课程 30 秒、学习记录 60 秒）。
 * 窗口没到就关掉页面 / 切走被系统回收，那次推送整个蒸发，而且**以后也补不回来** ——
 * 拉取那条「本地比远端新就回推」的兜底看不见它：远端那份没被别人改过，
 * 版本号一致，pull.ts 连全文都不会取，自然无从比较 updatedAt。
 * 真实症状是「桌面上对齐完就关掉，手机上拉下来还是空的，于是又对一遍」（§0 变更 43）。
 *
 * 落了库就有人管：启动、回前台、网络恢复各会 drain 一次。
 *
 * 幂等 —— 同一项已经在队列里就不再写库。打点时每敲一次回车都会调到这里。
 */
export async function markPending(kind: QueuedPushKind, lessonId?: string): Promise<void> {
  const queue = await getQueue();
  if (queue.some((item) => item.kind === kind && item.lessonId === lessonId)) return;
  const withoutStale = queue.filter((item) => !conflicts(item, kind, lessonId));
  withoutStale.push({ id: generateId(), kind, lessonId, enqueuedAt: Date.now(), deferred: true });
  await putMeta(QUEUE_META_KEY, withoutStale);
}

/**
 * 推成功之后把对应的标脏项清掉。
 *
 * 残留窗口说清楚：推送**进行中**又改了一次的话，那次改动不会新写一条（上面是幂等的），
 * 于是这里会把它的标脏项一起清掉 —— 它仍然由内存里的去抖定时器负责推。
 * 也就是说「改动落在一次 PUT 的往返里 + 紧接着杀掉应用」仍会丢一次推送。
 * 没有为它再加一层记账：窗口从 30 秒缩到了几百毫秒，而下一次改动会把它一起带上去。
 */
export async function clearPending(kind: QueuedPushKind, lessonId?: string): Promise<void> {
  const queue = await getQueue();
  const next = queue.filter((item) => !(item.kind === kind && item.lessonId === lessonId));
  if (next.length === queue.length) return;
  await putMeta(QUEUE_META_KEY, next);
}

/** FR-11.9 的「待推送 N 项」：只数要报警的那些，标脏项是正常状态。 */
export function alarmingCount(queue: QueuedPush[]): number {
  return queue.filter((item) => !item.deferred).length;
}

async function removeFromQueue(id: string): Promise<void> {
  const queue = await getQueue();
  await putMeta(QUEUE_META_KEY, queue.filter((item) => item.id !== id));
}

export interface DrainResult {
  succeeded: string[];
  failed: string[];
}

/**
 * 依次尝试把队列里的每一项真正推送出去；失败的留在队列里等下一次重试。
 * `pushOne` 由调用方注入，负责按 kind/lessonId 找到实际数据并推上去。
 */
export async function drainQueue(
  pushOne: (item: QueuedPush) => Promise<void>,
): Promise<DrainResult> {
  const queue = await getQueue();
  const result: DrainResult = { succeeded: [], failed: [] };

  for (const item of queue) {
    try {
      await pushOne(item);
      await removeFromQueue(item.id);
      result.succeeded.push(item.id);
    } catch {
      result.failed.push(item.id);
    }
  }

  return result;
}

/** 监听网络恢复，返回取消订阅函数。SSR / 测试环境没有 window 时安全地什么都不做。 */
export function onNetworkRestored(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', callback);
  return () => window.removeEventListener('online', callback);
}
