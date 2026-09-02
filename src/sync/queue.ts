// FR-11.10：推送失败 → 显式报警；离线时排队、恢复网络后自动重试。
// 队列落在 IndexedDB 的 meta store 里，不是纯内存 —— 手机在弱网下复习到一半被系统杀掉，
// 排队的推送不能跟着消失。
//
// 这个文件是 GitHub 方案留下来的原物（只多了一种 kind）：队列语义跟后端是谁无关。

import { getMeta, putMeta } from '@/db/meta';
import { generateId } from '@/lib/id';

export type QueuedPushKind = 'vocab' | 'lesson' | 'lesson-delete' | 'settings';

export interface QueuedPush {
  id: string;
  kind: QueuedPushKind;
  /** vocab / settings 推送忽略此字段；lesson 推送时是 Lesson.id，用于同一课多次入队时去重取最新一条 */
  lessonId?: string;
  enqueuedAt: number;
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
