import { openDB, type IDBPDatabase } from 'idb';
import { AppDBSchema, DB_NAME, DB_VERSION, META_KEYS } from './schema';

let dbPromise: Promise<IDBPDatabase<AppDBSchema>> | null = null;

/** 单例：全应用共用同一个数据库连接。 */
export function getDB(): Promise<IDBPDatabase<AppDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<AppDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('lessons')) {
          const lessons = db.createObjectStore('lessons', { keyPath: 'id' });
          lessons.createIndex('by-updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('vocab')) {
          const vocab = db.createObjectStore('vocab', { keyPath: 'id' });
          vocab.createIndex('by-lessonId', 'lessonId');
          vocab.createIndex('by-due', 'fsrs.due');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
        if (!db.objectStoreNames.contains('lessonCache')) {
          db.createObjectStore('lessonCache', { keyPath: 'lessonId' });
        }
        if (!db.objectStoreNames.contains('audioBlobs')) {
          db.createObjectStore('audioBlobs');
        }
      },
    });
  }
  return dbPromise;
}

/** 仅供测试使用：丢弃单例，强制下次 getDB() 重新打开连接。 */
export function _resetDBForTests(): void {
  dbPromise = null;
}

export interface StoragePersistenceStatus {
  persisted: boolean;
  requestedAt: number;
  /** true 表示浏览器不支持 navigator.storage.persist（如旧 Safari），不算失败 */
  unsupported: boolean;
}

/**
 * FR-11.16：启动时申请持久化配额，结果记录在 meta store，供设置页展示。
 * navigator.storage 在部分测试环境 / 极旧浏览器下不存在，必须判空。
 */
export async function initStoragePersistence(): Promise<StoragePersistenceStatus> {
  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.persist === 'function';

  const status: StoragePersistenceStatus = supported
    ? {
        persisted: await navigator.storage.persist(),
        requestedAt: Date.now(),
        unsupported: false,
      }
    : { persisted: false, requestedAt: Date.now(), unsupported: true };

  const db = await getDB();
  await db.put('meta', status, META_KEYS.storagePersistence);
  return status;
}

export interface StorageEstimateResult {
  usageBytes: number;
  quotaBytes: number;
  /** navigator.storage.estimate() 在部分浏览器下不可用 */
  unsupported: boolean;
}

/** 设置页展示用量/配额（§2.2）。不落库，每次现查。 */
export async function getStorageEstimate(): Promise<StorageEstimateResult> {
  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.estimate === 'function';
  if (!supported) {
    return { usageBytes: 0, quotaBytes: 0, unsupported: true };
  }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usageBytes: usage, quotaBytes: quota, unsupported: false };
}
