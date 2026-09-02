import { getDB } from './index';
import type { WordAudio } from './schema';

// 预置卡发音的缓存层 CRUD（FR-17.6）。键是**归一化词元键**，与 src/dict/bucket.ts 一致。
//
// 这一整个 store 属于缓存层：丢了能从 Wiktionary 重新取，所以
//   · 不进 backup-*.json（FR-11）
//   · 不进 ShareablePackage（§3.1 —— 何况它本来就是自由许可的公开录音）
//   · 清缓存时可以整块删

export async function getWordAudio(key: string): Promise<WordAudio | undefined> {
  const db = await getDB();
  return db.get('wordAudio', key);
}

export async function putWordAudio(key: string, value: WordAudio): Promise<void> {
  const db = await getDB();
  await db.put('wordAudio', value, key);
}

/** 已经问过的键（含否定结果）。批量预取时用来跳过。 */
export async function knownWordAudioKeys(): Promise<Set<string>> {
  const db = await getDB();
  return new Set(await db.getAllKeys('wordAudio'));
}

/** FR-3.8 的用量统计要把这一块算进去，否则「占了多少」是错的。 */
export async function getWordAudioBytes(): Promise<{ count: number; bytes: number }> {
  const db = await getDB();
  const all = await db.getAll('wordAudio');
  return {
    count: all.filter((a) => a.blob).length,
    bytes: all.reduce((sum, a) => sum + (a.blob?.size ?? 0), 0),
  };
}

export async function clearWordAudio(): Promise<void> {
  const db = await getDB();
  await db.clear('wordAudio');
}
