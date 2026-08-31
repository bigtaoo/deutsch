import { getDB } from './index';
import { META_KEYS } from './schema';
import type { Settings } from '@/types/models';

export const DEFAULT_SETTINGS: Settings = {
  newPerDay: 10,
  reviewPerDay: 60,
  shadowingGapRatio: 1.2,
  shadowingRepeat: 2,
  playbackRate: 1.0,
  dictationStrictCase: true,
};

export async function getSettings(): Promise<Settings> {
  const db = await getDB();
  const stored = await db.get('meta', META_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings> | undefined) };
}

export async function putSettings(settings: Settings): Promise<void> {
  const db = await getDB();
  await db.put('meta', settings, META_KEYS.settings);
}

/** 通用 meta 读写：GitHub token、仓库信息、备份状态等都走这两个函数。 */
export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  return db.get('meta', key) as Promise<T | undefined>;
}

export async function putMeta<T>(key: string, value: T): Promise<void> {
  const db = await getDB();
  await db.put('meta', value, key);
}

export async function deleteMeta(key: string): Promise<void> {
  const db = await getDB();
  await db.delete('meta', key);
}
