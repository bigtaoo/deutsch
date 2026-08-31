import { getDB } from './index';
import type { LessonCache } from '@/types/models';

// ══════ 缓存层 CRUD（§2.3）：R-缓存-1/2/3 在这里落地 ══════

export async function putLessonCache(cache: LessonCache): Promise<void> {
  const db = await getDB();
  await db.put('lessonCache', cache);
}

export async function getLessonCache(lessonId: string): Promise<LessonCache | undefined> {
  const db = await getDB();
  return db.get('lessonCache', lessonId);
}

export async function getAllLessonCaches(): Promise<LessonCache[]> {
  const db = await getDB();
  return db.getAll('lessonCache');
}

export async function deleteLessonCache(lessonId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['lessonCache', 'audioBlobs'], 'readwrite');
  await Promise.all([
    tx.objectStore('lessonCache').delete(lessonId),
    tx.objectStore('audioBlobs').delete(lessonId),
    tx.done,
  ]);
}

export async function putAudioBlob(lessonId: string, blob: Blob): Promise<void> {
  const db = await getDB();
  await db.put('audioBlobs', blob, lessonId);
}

export async function getAudioBlob(lessonId: string): Promise<Blob | undefined> {
  const db = await getDB();
  return db.get('audioBlobs', lessonId);
}

/** FR-3.2：下载前先查缓存。命中则调用方不应再发任何网络请求。 */
export async function hasCachedAudio(lessonId: string): Promise<boolean> {
  const db = await getDB();
  const key = await db.getKey('audioBlobs', lessonId);
  return key !== undefined;
}

/** FR-3.8：缓存管理页用，只读元数据不载入 Blob。 */
export async function getTotalCacheBytes(): Promise<number> {
  const caches = await getAllLessonCaches();
  return caches.reduce((sum, c) => sum + c.audioBytes, 0);
}
