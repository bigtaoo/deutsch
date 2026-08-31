// FR-11.13：一键从仓库恢复到空设备。
//
// 恢复路径是**最容易悄悄坏掉**的那条 —— 平时没人走，等真需要时才发现它早就不通了（§2.6.5）。
// 所以它必须是一个按钮，而不是一段「先 clone 仓库再手动导入 JSON」的说明。
//
// 恢复只写标注层。课程会显示「素材未下载」，音频靠 FR-3.5 按 lesson id 重新抓 —— 这正是
// R-缓存-2「缓存不跨端」能成立的原因。

import { githubRequest, GitHubApiError } from './client';
import { getFile } from './sync';
import { mergeBackup } from '@/backup/merge';
import { getAllLessons, putLesson } from '@/db/lessons';
import { getAllVocabEntries, putVocabEntry } from '@/db/vocab';
import type { MergeSummary } from '@/backup/types';
import type { RepoRef } from './repo';
import type { Lesson, VocabEntry } from '@/types/models';

export interface RestoreResult {
  summary: MergeSummary;
  lessonsFetched: number;
  vocabFetched: number;
  /** 单个文件坏掉不该让整次恢复失败：坏的记在这里，好的照常写入 */
  failures: string[];
}

interface DirEntry {
  name: string;
  path: string;
  type: string;
}

async function listDir(token: string, ref: RepoRef, path: string): Promise<DirEntry[]> {
  const res = await githubRequest(`/repos/${ref.owner}/${ref.repo}/contents/${path}`, token);
  if (res.status === 404) return []; // 还没备份过任何课程
  if (!res.ok) throw new GitHubApiError(res.status, `列出 ${path} 失败：${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? (data as DirEntry[]) : [];
}

export async function restoreFromRepo(token: string, ref: RepoRef): Promise<RestoreResult> {
  const failures: string[] = [];

  const incomingLessons: Lesson[] = [];
  for (const entry of await listDir(token, ref, 'lessons')) {
    if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue;
    try {
      const file = await getFile(token, ref, entry.path);
      if (file) incomingLessons.push(JSON.parse(file.content) as Lesson);
    } catch (err) {
      failures.push(`${entry.path}：${err instanceof Error ? err.message : err}`);
    }
  }

  let incomingVocab: VocabEntry[] = [];
  try {
    const vocabFile = await getFile(token, ref, 'vocab.json');
    if (vocabFile) incomingVocab = JSON.parse(vocabFile.content) as VocabEntry[];
  } catch (err) {
    failures.push(`vocab.json：${err instanceof Error ? err.message : err}`);
  }

  // 走 §2.4 的同一套合并规则，不是「清空后覆盖」—— 恢复到一台**已有数据**的设备上
  // （比如想把手机的复习状态拉回桌面）是完全正常的用法。
  const [localLessons, localVocab] = await Promise.all([getAllLessons(), getAllVocabEntries()]);
  const result = mergeBackup(
    { lessons: localLessons, vocab: localVocab },
    { lessons: incomingLessons, vocab: incomingVocab },
  );

  await Promise.all([
    ...result.lessons.map((lesson) => putLesson(lesson)),
    ...result.vocab.map((entry) => putVocabEntry(entry)),
  ]);

  return {
    summary: result.summary,
    lessonsFetched: incomingLessons.length,
    vocabFetched: incomingVocab.length,
    failures,
  };
}
