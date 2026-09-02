// 「文档」是同步的最小单位，和后端 docs 表一一对应：
//   vocab        —— 全部生词，一次全量。FSRS 状态不可重建，是整个应用最要命的数据。
//   lesson:<id>  —— 单课的标注层。按课分片，改一课不用重推全部。
//   settings     —— 设置，整体一份（2026-09-02 起，§0 变更 28）。
//
// **设置以前不同步**，理由是「对齐档位、跟读间隔这些跟机器走，跨设备覆盖只会互相打架」。
// 那条理由被推翻了：用户要求「除了音频和原始文稿，其他都备份和同步」，而且细看之下
// 真正跟机器走的东西**压根不在 Settings 里** —— 「这台设备跑不动对齐」记在黑匣子
// （localStorage，见 align/journal.ts）里，不受这个开关影响；手机就算把
// autoAlignOnImport 同步成 true，两档都崩过之后照样自己停。
// 剩下的（每日新词量、跟读间隔、判分严格度、词频档）本来就该跟人走。
//
// 版本号取代了 GitHub 方案里的文件 sha：本地记着「我上次推完是第几版」，
// 推的时候带上去，对不上就是 409。语义一模一样，只是不用再解析 GitHub 的响应结构。

import { getMeta, putMeta } from '@/db/meta';
import { META_KEYS } from '@/db/schema';
import { syncFetch, SyncApiError } from './client';

export const VOCAB_DOC_ID = 'vocab';
export const SETTINGS_DOC_ID = 'settings';

export function lessonDocId(lessonId: string): string {
  return `lesson:${lessonId}`;
}

export function lessonIdFromDocId(docId: string): string | null {
  return docId.startsWith('lesson:') ? docId.slice('lesson:'.length) : null;
}

export interface RemoteDocMeta {
  id: string;
  version: number;
  updatedAt: number;
  bytes: number;
}

export interface RemoteDoc<T> {
  id: string;
  version: number;
  updatedAt: number;
  body: T;
}

export async function listRemoteDocs(token: string): Promise<RemoteDocMeta[]> {
  const { docs } = await syncFetch<{ docs: RemoteDocMeta[] }>('/v1/docs', { token });
  return docs;
}

/** 远端没有这个文档时返回 null —— 「还没推过」是正常状态，不是错误。 */
export async function getRemoteDoc<T>(token: string, docId: string): Promise<RemoteDoc<T> | null> {
  try {
    return await syncFetch<RemoteDoc<T>>(`/v1/docs/${encodeURIComponent(docId)}`, { token });
  } catch (err) {
    if (err instanceof SyncApiError && err.status === 404) return null;
    throw err;
  }
}

/** 版本对不上时抛 SyncConflictError（里面带着远端现值）。 */
export async function putRemoteDoc(
  token: string,
  docId: string,
  baseVersion: number | null,
  body: unknown,
): Promise<{ version: number; updatedAt: number }> {
  return syncFetch<{ version: number; updatedAt: number }>(
    `/v1/docs/${encodeURIComponent(docId)}`,
    { method: 'PUT', token, body: { baseVersion, body } },
  );
}

export async function deleteRemoteDoc(token: string, docId: string): Promise<boolean> {
  const { deleted } = await syncFetch<{ deleted: boolean }>(
    `/v1/docs/${encodeURIComponent(docId)}`,
    { method: 'DELETE', token },
  );
  return deleted;
}

// ── 本地记的版本号 ────────────────────────────────────────────────────────
// 存在 meta 里而不是内存里：手机在弱网下被系统杀掉之后，下次启动如果版本号全丢了，
// 每一次推送都会先撞一个 409 再合并 —— 能自愈，但白跑一趟。

type VersionMap = Record<string, number>;

export async function getKnownVersion(docId: string): Promise<number | null> {
  const map = await getMeta<VersionMap>(META_KEYS.syncVersions);
  return map?.[docId] ?? null;
}

export async function rememberVersion(docId: string, version: number): Promise<void> {
  const map = (await getMeta<VersionMap>(META_KEYS.syncVersions)) ?? {};
  await putMeta<VersionMap>(META_KEYS.syncVersions, { ...map, [docId]: version });
}

export async function forgetVersion(docId: string): Promise<void> {
  const map = (await getMeta<VersionMap>(META_KEYS.syncVersions)) ?? {};
  if (!(docId in map)) return;
  const next = { ...map };
  delete next[docId];
  await putMeta<VersionMap>(META_KEYS.syncVersions, next);
}

/** 退出登录时调用：换了账号之后本地那套版本号毫无意义，留着只会平白撞 409。 */
export async function forgetAllVersions(): Promise<void> {
  await putMeta<VersionMap>(META_KEYS.syncVersions, {});
}
