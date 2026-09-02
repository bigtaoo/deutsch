// FR-11.6 / FR-11.7 / FR-11.10：把「数据变了」接到「推同步服务器」上。
//
// 四条路径：
//   scheduleLessonSync(id)  —— 标注/挖空变更后调用，30s 去抖（FR-11.7）
//   syncVocabNow()          —— 每次复习会话结束调用，不去抖（FR-11.6，不可重建的数据不过夜）
//   scheduleSettingsSync()  —— 改过设置后调用，5s 去抖（§0 变更 28）
//   syncLessonDeletion(id)  —— 本地删掉一课，远端也删掉
//   drainSyncQueue()        —— 网络恢复、回前台或启动时调用，把排队的补推出去（FR-11.10）
//
// 任何一次推送失败都不会抛到调用方：数据已经在 IndexedDB 里，推送只是备份。
// 失败的后果是「进队列 + pendingCount 涨」，由 FR-11.9 的常驻状态条暴露出来。
//
// ── 409 怎么处理 ──
// 「绝不静默覆盖」（FR-11.8）在这里的落地：撞版本冲突时后端把远端现值一起带回来，
// 于是就地按 §2.4 的合并规则算出胜者，**写回本地**，再用远端版本号重推一次。
// vocab 是逐条 last-write-wins（比 fsrs.last_review），课程与设置是整体比 updatedAt。

import { getMeta, getSettings, putMeta, putSettings } from '@/db/meta';
import { getLesson, putLesson } from '@/db/lessons';
import { getAllVocabEntries, putVocabEntry } from '@/db/vocab';
import { META_KEYS } from '@/db/schema';
import { debounceByKey } from '@/lib/debounce';
import { mergeSettings, mergeVocabEntries } from '@/backup/merge';
import type { Lesson, Settings, VocabEntry } from '@/types/models';
import { SyncAuthError, SyncConflictError } from './client';
import { getSessionToken } from './session';
import {
  SETTINGS_DOC_ID,
  VOCAB_DOC_ID,
  deleteRemoteDoc,
  forgetVersion,
  getKnownVersion,
  lessonDocId,
  putRemoteDoc,
  rememberVersion,
} from './docs';
import { drainQueue, enqueuePush, onNetworkRestored, type QueuedPush } from './queue';

const LESSON_DEBOUNCE_MS = 30_000;
/**
 * 设置的去抖比课程短得多：改设置是「拖一下滑块、点一下开关」的连续操作，
 * 几秒就停手，而且改完之后人很可能立刻换设备（这正是要同步它的场景）。
 * 30 秒在这里只会让「在桌面上改完、马上拿起手机」拿不到新值。
 */
const SETTINGS_DEBOUNCE_MS = 5_000;

export interface SyncHooks {
  /** UI 用来刷新 pendingCount / lastSuccessAt / 错误横幅。 */
  onChange?: () => void;
  /** 合并把远端数据写进了本地库 —— 内存里的 store 得重新读一遍，否则界面还是旧的。 */
  onRemoteDataWritten?: () => void;
  /** 会话失效（令牌过期或账号被移出白名单）：要把 UI 切回「未登录」并提示。 */
  onSessionExpired?: () => void;
}

let hooks: SyncHooks = {};

export function setSyncHooks(next: SyncHooks): void {
  hooks = next;
}

async function recordSuccess(): Promise<void> {
  const existing = (await getMeta<{ lastSuccessAt?: number }>(META_KEYS.syncStatus)) ?? {};
  await putMeta(META_KEYS.syncStatus, { ...existing, lastSuccessAt: Date.now() });
}

// ── vocab ────────────────────────────────────────────────────────────────

async function pushVocab(token: string): Promise<void> {
  const local = await getAllVocabEntries();
  const docId = VOCAB_DOC_ID;

  try {
    const { version } = await putRemoteDoc(token, docId, await getKnownVersion(docId), local);
    await rememberVersion(docId, version);
  } catch (err) {
    if (!(err instanceof SyncConflictError)) throw err;

    const remote = Array.isArray(err.body) ? (err.body as VocabEntry[]) : [];
    const { merged, summary } = mergeVocabEntries(local, remote);
    // 只写远端赢了的那几条，不是整库回写 —— 生词上千条时那是一次没必要的全表写入。
    const changed = new Set([...summary.addedVocab, ...summary.updatedVocab]);
    await Promise.all(merged.filter((e) => changed.has(e.id)).map((e) => putVocabEntry(e)));
    if (changed.size > 0) hooks.onRemoteDataWritten?.();

    const { version } = await putRemoteDoc(token, docId, err.version, merged);
    await rememberVersion(docId, version);
  }

  await recordSuccess();
}

// ── 单课 ─────────────────────────────────────────────────────────────────

async function pushLesson(token: string, lessonId: string): Promise<void> {
  const lesson = await getLesson(lessonId);
  if (!lesson) return; // 已经被删了：删除走 syncLessonDeletion，这里什么都不做
  const docId = lessonDocId(lessonId);

  try {
    const { version } = await putRemoteDoc(token, docId, await getKnownVersion(docId), lesson);
    await rememberVersion(docId, version);
  } catch (err) {
    if (!(err instanceof SyncConflictError)) throw err;

    const remote = (err.body ?? null) as Lesson | null;
    if (remote && remote.updatedAt > lesson.updatedAt) {
      // 远端更新（另一台设备刚改过这一课）：接受远端，本地这份让位。
      // 不再回推 —— 远端已经是胜者，重推只会白涨一个版本号。
      await putLesson(remote);
      await rememberVersion(docId, err.version);
      hooks.onRemoteDataWritten?.();
    } else {
      const { version } = await putRemoteDoc(token, docId, err.version, lesson);
      await rememberVersion(docId, version);
    }
  }

  await recordSuccess();
}

async function pushLessonDeletion(token: string, lessonId: string): Promise<void> {
  const docId = lessonDocId(lessonId);
  await deleteRemoteDoc(token, docId);
  await forgetVersion(docId);
  await recordSuccess();
}

// ── settings ─────────────────────────────────────────────────────────────

async function pushSettings(token: string): Promise<void> {
  const local = await getSettings();
  const docId = SETTINGS_DOC_ID;

  try {
    const { version } = await putRemoteDoc(token, docId, await getKnownVersion(docId), local);
    await rememberVersion(docId, version);
  } catch (err) {
    if (!(err instanceof SyncConflictError)) throw err;

    // 409：另一台设备也改过设置。整体比 updatedAt，远端赢就写回本地（§2.4）。
    const remote = (err.body ?? null) as Settings | null;
    const { merged, changed } = remote ? mergeSettings(local, remote) : { merged: local, changed: false };
    if (changed) {
      await putSettings(merged);
      hooks.onRemoteDataWritten?.();
    }
    const { version } = await putRemoteDoc(token, docId, err.version, merged);
    await rememberVersion(docId, version);
  }

  await recordSuccess();
}

// ── 统一的「试一次，失败就进队列」外壳 ───────────────────────────────────

async function runPush(item: QueuedPush): Promise<void> {
  const token = await getSessionToken();
  if (!token) throw new SyncAuthError('尚未登录');
  if (item.kind === 'vocab') return pushVocab(token);
  if (item.kind === 'settings') return pushSettings(token);
  if (!item.lessonId) return;
  if (item.kind === 'lesson') return pushLesson(token, item.lessonId);
  return pushLessonDeletion(token, item.lessonId);
}

async function attempt(kind: QueuedPush['kind'], lessonId?: string): Promise<void> {
  // 没登录：不排队。手动导出（FR-11.11）仍然是随时可用的第二道保险，
  // 而一个永远推不出去的队列只会让 pendingCount 无意义地涨。
  const token = await getSessionToken();
  if (!token) return;

  try {
    await runPush({ id: '', kind, lessonId, enqueuedAt: Date.now() });
  } catch (err) {
    if (err instanceof SyncAuthError) {
      // 会话没了：排队等重新登录之后一起补推，同时让 UI 立刻说清楚。
      await enqueuePush(kind, lessonId);
      hooks.onSessionExpired?.();
    } else {
      await enqueuePush(kind, lessonId);
    }
  } finally {
    hooks.onChange?.();
  }
}

const lessonDebouncer = debounceByKey<string, []>(
  (lessonId) => attempt('lesson', lessonId),
  LESSON_DEBOUNCE_MS,
);

// 设置只有一份，所以 key 是个常量 —— 借同一个去抖器只是为了不再写一遍计时器逻辑。
const settingsDebouncer = debounceByKey<'settings', []>(
  () => attempt('settings'),
  SETTINGS_DEBOUNCE_MS,
);

/** FR-11.7：该课导入完成、或标注/挖空变更后触发，去抖 30s。 */
export function scheduleLessonSync(lessonId: string): void {
  lessonDebouncer.schedule(lessonId);
}

/** §0 变更 28：改过设置后触发，去抖 5s。 */
export function scheduleSettingsSync(): void {
  settingsDebouncer.schedule('settings');
}

/** 测试与卸载用；正常流程让去抖自然到期。 */
export function cancelScheduledSyncs(): void {
  lessonDebouncer.cancelAll();
  settingsDebouncer.cancelAll();
}

/** FR-11.6：每次复习会话结束触发。 */
export async function syncVocabNow(): Promise<void> {
  await attempt('vocab');
}

/** 本地删课之后调用，让远端也别留着。 */
export async function syncLessonDeletion(lessonId: string): Promise<void> {
  lessonDebouncer.cancelAll();
  await attempt('lesson-delete', lessonId);
}

/** FR-11.10：把排队的推送重新试一遍。成功的出队，失败的留着。 */
export async function drainSyncQueue(): Promise<void> {
  const token = await getSessionToken();
  if (!token) return;
  await drainQueue(runPush);
  hooks.onChange?.();
}

/** 启动时调一次：网络恢复即自动重试。返回取消订阅函数。 */
export function startSyncAutoRetry(): () => void {
  return onNetworkRestored(() => void drainSyncQueue());
}
