import type { DBSchema } from 'idb';
import type { Lesson, VocabEntry, LessonCache } from '@/types/models';

export const DB_NAME = 'deutsch-listening-trainer';
export const DB_VERSION = 2;

/**
 * IndexedDB object stores — 见 SPEC.md §6 底部的 store 表。
 *
 * 标注层：lessons / vocab / meta
 * 缓存层：lessonCache / audioBlobs
 *
 * `meta` 是一个通用 KV store，用来放不构成独立集合的东西：
 * Settings 对象、GitHub token、备份队列状态、storage.persist() 的结果等。
 * 之所以不为每一种都单开 store，是因为它们都是"恰好一条记录"的形状。
 *
 * v2（FR-16/FR-17）新增 `wordAudio`：预置卡的发音（Wiktionary 的自由许可录音）。
 * 它是**缓存层** —— 丢了能从 Wiktionary 重新取，所以不进备份。
 * 单开一个 store 而不是塞进 audioBlobs，是因为那个 store 的键是 lessonId，
 * 而这里的键是词元；混在一起会让 FR-3.8 的「按课清缓存」把发音一起删掉。
 */
export interface AppDBSchema extends DBSchema {
  lessons: {
    key: string; // Lesson.id
    value: Lesson;
    indexes: { 'by-updatedAt': number };
  };
  vocab: {
    key: string; // VocabEntry.id
    value: VocabEntry;
    indexes: { 'by-lessonId': string; 'by-due': number };
  };
  meta: {
    key: string;
    value: unknown;
  };
  lessonCache: {
    key: string; // LessonCache.lessonId
    value: LessonCache;
  };
  audioBlobs: {
    key: string; // lessonId
    value: Blob;
  };
  wordAudio: {
    key: string; // 归一化词元键（src/dict/bucket.ts 的 normalizeKey）
    value: WordAudio;
  };
}

/**
 * 一个词的发音。`blob` 为空表示**查过、Wiktionary 上确实没有** ——
 * 这种「否定结果」也要存，否则每次复习到这张卡都要再去问一遍（FR-17.6）。
 */
export interface WordAudio {
  lemma: string;
  blob?: Blob;
  /** 来源文件名，如 `De-Zuversicht.ogg`。CC BY-SA 的署名要求落在这里。 */
  file?: string;
  mime?: string;
  fetchedAt: number;
}

export const META_KEYS = {
  settings: 'settings',
  syncSession: 'syncSession', // { token, expiresAt, account } —— 同步服务器的会话令牌
  syncVersions: 'syncVersions', // { [docId]: version } —— 本地记的远端版本号，做乐观并发
  syncStatus: 'syncStatus', // FR-11.9：常驻可见的状态
  storagePersistence: 'storagePersistence', // FR-11.16
} as const;
