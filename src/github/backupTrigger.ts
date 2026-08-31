// FR-11.6 / FR-11.7 / FR-11.10：把「数据变了」接到「推 GitHub」上。
//
// 三条路径：
//   scheduleLessonBackup(id) —— 标注/挖空变更后调用，30s 去抖（FR-11.7）
//   backupVocabNow()         —— 每次复习会话结束调用，不去抖（FR-11.6，不可重建的数据不过夜）
//   drainBackupQueue()       —— 网络恢复或启动时调用，把排队的补推出去（FR-11.10）
//
// 任何一次推送失败都不会抛到调用方：数据已经在 IndexedDB 里，推送只是备份。
// 失败的后果是「进队列 + pendingCount 涨」，由 FR-11.9 的常驻状态条暴露出来。

import { getMeta, putMeta } from '@/db/meta';
import { getLesson } from '@/db/lessons';
import { getAllVocabEntries } from '@/db/vocab';
import { META_KEYS } from '@/db/schema';
import { debounceByKey } from '@/lib/debounce';
import { pushLessonFile, pushVocabFile, lessonPath } from './backupSync';
import { drainQueue, enqueuePush, onNetworkRestored, type QueuedPush } from './queue';
import type { RepoRef } from './repo';

const SHA_META_KEY = 'backupFileShas';
const LESSON_DEBOUNCE_MS = 30_000;

type ShaMap = Record<string, string>;

async function getSha(path: string): Promise<string | undefined> {
  return (await getMeta<ShaMap>(SHA_META_KEY))?.[path];
}

async function rememberSha(path: string, sha: string): Promise<void> {
  const map = (await getMeta<ShaMap>(SHA_META_KEY)) ?? {};
  await putMeta(SHA_META_KEY, { ...map, [path]: sha });
}

interface Connection {
  token: string;
  repo: RepoRef;
}

async function getConnection(): Promise<Connection | null> {
  const [token, repo] = await Promise.all([
    getMeta<string>(META_KEYS.githubToken),
    getMeta<RepoRef>(META_KEYS.githubRepo),
  ]);
  return token && repo ? { token, repo } : null;
}

/** 推送成功后更新 FR-11.9 用的「上次成功时间」。store 也读这个 key。 */
async function recordSuccess(): Promise<void> {
  const existing = (await getMeta<{ lastSuccessAt?: number }>(META_KEYS.backupStatus)) ?? {};
  await putMeta(META_KEYS.backupStatus, { ...existing, lastSuccessAt: Date.now() });
}

export interface BackupHooks {
  /** UI 用来刷新 pendingCount / lastSuccessAt / 错误横幅 */
  onChange?: () => void;
}

let hooks: BackupHooks = {};

export function setBackupHooks(next: BackupHooks): void {
  hooks = next;
}

async function pushLessonNow(lessonId: string): Promise<void> {
  const connection = await getConnection();
  if (!connection) return; // 没连 GitHub：手动导出仍是第二道保险（FR-11.11），不排队
  const lesson = await getLesson(lessonId);
  if (!lesson) return;

  const path = lessonPath(lessonId);
  const { sha } = await pushLessonFile(connection.token, connection.repo, lesson, await getSha(path));
  await rememberSha(path, sha);
  await recordSuccess();
}

async function pushVocab(): Promise<void> {
  const connection = await getConnection();
  if (!connection) return;
  const vocab = await getAllVocabEntries();
  const { sha } = await pushVocabFile(connection.token, connection.repo, vocab, await getSha('vocab.json'));
  await rememberSha('vocab.json', sha);
  await recordSuccess();
}

async function attempt(kind: 'lesson' | 'vocab', lessonId?: string): Promise<void> {
  try {
    if (kind === 'lesson') await pushLessonNow(lessonId!);
    else await pushVocab();
  } catch {
    await enqueuePush(kind, lessonId);
  } finally {
    hooks.onChange?.();
  }
}

const lessonDebouncer = debounceByKey<string, []>((lessonId) => attempt('lesson', lessonId), LESSON_DEBOUNCE_MS);

/** FR-11.7：该课导入完成、或标注/挖空变更后触发，去抖 30s。 */
export function scheduleLessonBackup(lessonId: string): void {
  lessonDebouncer.schedule(lessonId);
}

/** 测试与卸载用；正常流程让去抖自然到期。 */
export function cancelScheduledBackups(): void {
  lessonDebouncer.cancelAll();
}

/** FR-11.6：每次复习会话结束触发。 */
export async function backupVocabNow(): Promise<void> {
  await attempt('vocab');
}

/** FR-11.10：把排队的推送重新试一遍。成功的出队，失败的留着。 */
export async function drainBackupQueue(): Promise<void> {
  const connection = await getConnection();
  if (!connection) return;
  await drainQueue(async (item: QueuedPush) => {
    if (item.kind === 'lesson' && item.lessonId) await pushLessonNow(item.lessonId);
    else if (item.kind === 'vocab') await pushVocab();
  });
  hooks.onChange?.();
}

/** 启动时调一次：网络恢复即自动重试。返回取消订阅函数。 */
export function startBackupAutoRetry(): () => void {
  return onNetworkRestored(() => void drainBackupQueue());
}
