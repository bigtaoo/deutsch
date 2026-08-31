// 把 §2.4 合并规则接到 GitHub 推送上：vocab.json 与 lessons/<id>.json 各自的推送策略。
// FR-11.6：vocab.json 每次复习会话结束就推。
// FR-11.7：lessons/<id>.json 在导入/标注变更后触发，调用方负责做 30s 去抖（见 src/lib/debounce.ts）。

import { mergeLessons, mergeVocabEntries } from '@/backup/merge';
import { putFile } from './sync';
import type { RepoRef } from './repo';
import type { Lesson, VocabEntry } from '@/types/models';

const VOCAB_PATH = 'vocab.json';
export const lessonPath = (lessonId: string): string => `lessons/${lessonId}.json`;

export async function pushVocabFile(
  token: string,
  ref: RepoRef,
  allVocab: VocabEntry[],
  sha?: string,
): Promise<{ sha: string }> {
  return putFile(token, ref, VOCAB_PATH, JSON.stringify(allVocab, null, 2), {
    message: `vocab: ${allVocab.length} 条`,
    sha,
    onConflict: (remoteContent) => {
      const remoteVocab = remoteContent ? (JSON.parse(remoteContent) as VocabEntry[]) : [];
      const { merged } = mergeVocabEntries(remoteVocab, allVocab);
      return JSON.stringify(merged, null, 2);
    },
  });
}

export async function pushLessonFile(
  token: string,
  ref: RepoRef,
  lesson: Lesson,
  sha?: string,
): Promise<{ sha: string }> {
  return putFile(token, ref, lessonPath(lesson.id), JSON.stringify(lesson, null, 2), {
    message: `lesson: ${lesson.title}`,
    sha,
    onConflict: (remoteContent) => {
      if (!remoteContent) return JSON.stringify(lesson, null, 2);
      const remoteLesson = JSON.parse(remoteContent) as Lesson;
      const { merged } = mergeLessons([remoteLesson], [lesson]);
      return JSON.stringify(merged[0], null, 2);
    },
  });
}
