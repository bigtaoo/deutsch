import { getDB } from './index';
import type { Lesson } from '@/types/models';

export async function putLesson(lesson: Lesson): Promise<void> {
  const db = await getDB();
  await db.put('lessons', lesson);
}

export async function getLesson(id: string): Promise<Lesson | undefined> {
  const db = await getDB();
  return db.get('lessons', id);
}

export async function getAllLessons(): Promise<Lesson[]> {
  const db = await getDB();
  return db.getAll('lessons');
}

export async function deleteLesson(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('lessons', id);
}
