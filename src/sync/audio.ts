// §0 变更 69：手动导入的课（教材）的音频也上服务器，别的设备自动下载。
//
// 形状照 DW 的课：标注层里记一个地址（`Lesson.audioRef`，服务器上按 SHA-256 定址的那一份），
// 缓存层里放音频本身。有地址的课打开就自动补齐（LessonPage 的 MissingMaterialBanner）。
//
// ── 上传：扫一遍，而不是排队 ──
// 「本机有音频、却还没有 audioRef，或本机这份是自己选的、还没传过（LessonCache.audioPendingUpload）」的手动课就是要传的。
// 不拿「audioRef 和本机字节数对不上」当判据：两台设备本地音频不同时，那样会各传各的、每次同步互相改一遍 audioRef。
// 这个判据本身是幂等的：传到一半关了页面、断了网、服务器 503，下一次扫到它还在那儿，
// 于是不需要一个持久化的队列来记「还有谁没传」—— 状态就在数据里。
// 扫的时机：启动 / 回前台 / 网络恢复（跟着 syncNow），以及导入或绑音频之后（scheduleAudioUpload）。
//
// ── 不做的 ──
// 删课不删服务器上那一份：按内容定址，同一份可能被另一课引用；一本书百来 MB，服务器有 5GB 额度。

import { getAllLessons } from '@/db/lessons';
import { getAllLessonCaches, getAudioBlob } from '@/db/cache';
import { SYNC_API_BASE, isSyncConfigured } from './config';
import { getSessionToken } from './session';
import { SyncApiError, SyncAuthError } from './client';
import type { Lesson } from '@/types/models';

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 这一课能不能从我们的服务器上补齐音频。 */
export function hasServerAudio(lesson: Lesson): boolean {
  return lesson.source.type === 'manual' && lesson.audioRef !== undefined;
}

/** 服务器说「没开音频存储」（503 audio_off）之后本次会话不再试。 */
let serverSaidOff = false;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getSessionToken();
  if (!token) throw new SyncAuthError('没登录同步');
  const res = await fetch(`${SYNC_API_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new SyncAuthError('会话已过期，请重新登录');
  if (res.status === 503) {
    serverSaidOff = true;
    throw new SyncApiError(503, '这台服务器没有开音频存储');
  }
  return res;
}

async function failed(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new SyncApiError(res.status, body.error ?? `请求失败：HTTP ${res.status}`);
}

/** 传一份（服务器上已经有就不传），返回它的地址。 */
export async function uploadAudio(blob: Blob): Promise<{ sha256: string; bytes: number }> {
  const sha256 = await sha256Hex(blob);
  const head = await request(`/v1/audio/${sha256}`, { method: 'HEAD' });
  if (head.status === 404) {
    const put = await request(`/v1/audio/${sha256}`, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    });
    if (!put.ok) await failed(put);
  } else if (!head.ok) {
    await failed(head);
  }
  return { sha256, bytes: blob.size };
}

/** 照 audioRef 下载，逐位校验过才返回 —— 名字就是哈希，对不上就是坏了，宁可报错也不存一份错的。 */
export async function downloadAudio(ref: { sha256: string; bytes: number }): Promise<Blob> {
  const res = await request(`/v1/audio/${ref.sha256}`);
  if (!res.ok) await failed(res);
  const blob = await res.blob();
  if (blob.size !== ref.bytes || (await sha256Hex(blob)) !== ref.sha256) {
    throw new Error('下载下来的音频和服务器记着的对不上（传输中断了？），再试一次');
  }
  return blob;
}

export interface UploadDeps {
  /** 写回 audioRef。由 useLessonStore 注入 —— 这里不直接 import 它，免得循环依赖。 */
  saveAudioRef: (lessonId: string, ref: { sha256: string; bytes: number }) => Promise<void>;
}

let deps: UploadDeps | null = null;
export function registerAudioUploadDeps(d: UploadDeps): void {
  deps = d;
}

/**
 * 要传的课：手动导入、本机有音频，且「还没有 audioRef」或「本机这份是自己后来选的」。
 * audioRef 对不上本机、又不是本机新选的 = 别的设备换过音频，那边的为准，这里不回传。
 */
export async function lessonsNeedingUpload(): Promise<Lesson[]> {
  const cached = new Map((await getAllLessonCaches()).map((c) => [c.lessonId, c]));
  return (await getAllLessons()).filter((l) => {
    const cache = cached.get(l.id);
    return l.source.type === 'manual' && cache?.hasAudio === true && (!l.audioRef || cache.audioPendingUpload === true);
  });
}

let inFlight: Promise<number> | null = null;

/**
 * 扫一遍、逐个传（串行：一次只把一课的音频读进内存）。返回这次传成功了几课。
 * 同一时间只跑一趟；没登录、没配同步、服务器没开时什么都不做。
 */
export function uploadPendingAudio(): Promise<number> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!isSyncConfigured() || serverSaidOff || !deps || !(await getSessionToken())) return 0;
    let done = 0;
    for (const lesson of await lessonsNeedingUpload()) {
      const blob = await getAudioBlob(lesson.id);
      if (!blob) continue;
      try {
        const ref = await uploadAudio(blob);
        await deps.saveAudioRef(lesson.id, ref);
        done++;
      } catch (err) {
        // 登录过期、服务器没开：后面的也一样会失败，停下等下一趟。其它错误只跳过这一课。
        if (err instanceof SyncAuthError || serverSaidOff) break;
        console.warn('[audio] 上传失败', lesson.id, err);
      }
    }
    return done;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** 导入 / 绑音频之后调：等几秒（一次导几十课时只扫一趟）再扫。 */
export function scheduleAudioUpload(delayMs = 3000): void {
  clearTimeout(timer);
  timer = setTimeout(() => void uploadPendingAudio(), delayMs);
}

/** 测试用：清掉模块级状态。 */
export function resetAudioSyncForTests(): void {
  serverSaidOff = false;
  inFlight = null;
  deps = null;
  clearTimeout(timer);
}
