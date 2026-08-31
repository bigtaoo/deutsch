import { getDB } from './index';
import type { VocabEntry } from '@/types/models';

export async function putVocabEntry(entry: VocabEntry): Promise<void> {
  const db = await getDB();
  await db.put('vocab', entry);
}

export async function getVocabEntry(id: string): Promise<VocabEntry | undefined> {
  const db = await getDB();
  return db.get('vocab', id);
}

export async function getAllVocabEntries(): Promise<VocabEntry[]> {
  const db = await getDB();
  return db.getAll('vocab');
}

export async function getVocabEntriesByLesson(lessonId: string): Promise<VocabEntry[]> {
  const db = await getDB();
  return db.getAllFromIndex('vocab', 'by-lessonId', lessonId);
}

/** FR-9.3 去重降级：按 surface 全库匹配（大小写不敏感）。 */
export async function findVocabEntriesBySurface(surface: string): Promise<VocabEntry[]> {
  const all = await getAllVocabEntries();
  const needle = surface.toLowerCase();
  return all.filter((e) => e.surface.toLowerCase() === needle);
}

export async function deleteVocabEntry(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('vocab', id);
}
