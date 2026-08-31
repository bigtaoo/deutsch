import type { DBSchema } from 'idb';
import type { Lesson, VocabEntry, LessonCache } from '@/types/models';

export const DB_NAME = 'deutsch-listening-trainer';
export const DB_VERSION = 1;

/**
 * IndexedDB object stores — 见 SPEC.md §6 底部的 store 表。
 *
 * 标注层：lessons / vocab / meta
 * 缓存层：lessonCache / audioBlobs
 *
 * `meta` 是一个通用 KV store，用来放不构成独立集合的东西：
 * Settings 对象、GitHub token、备份队列状态、storage.persist() 的结果等。
 * 之所以不为每一种都单开 store，是因为它们都是"恰好一条记录"的形状。
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
}

export const META_KEYS = {
  settings: 'settings',
  githubToken: 'githubToken',
  githubRepo: 'githubRepo', // { owner, repo, defaultBranch }
  backupStatus: 'backupStatus', // FR-11.9：常驻可见的状态
  storagePersistence: 'storagePersistence', // FR-11.16
} as const;
