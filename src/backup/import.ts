// FR-11.14：导入本地备份文件，按 §2.4 合并规则执行，展示合并摘要。
//
// 两阶段设计：
//   prepareImport()  —— 只读，算出合并结果 + 摘要，同时返回"导入前"的当前状态快照
//                        （给 UI 触发一次防呆下载，对应"导入前自动先导出一份当前状态"）
//   commitImport()   —— 把 prepareImport() 算好的结果写回 DB
// 拆开是为了让 UI 能先展示摘要、等用户确认后再落库，而不是导入即生效。

import { getAllLessons, putLesson } from '@/db/lessons';
import { getAllVocabEntries, putVocabEntry } from '@/db/vocab';
import { buildBackupJson } from './export';
import { mergeBackup } from './merge';
import type { BackupFile, MergeResult } from './types';

export interface PreparedImport {
  safetySnapshot: BackupFile; // 导入前的当前状态，供 UI 下载防呆
  result: MergeResult; // 合并后的数据 + 摘要，尚未写入 DB
}

export async function prepareImport(incoming: BackupFile): Promise<PreparedImport> {
  const [safetySnapshot, localLessons, localVocab] = await Promise.all([
    buildBackupJson(),
    getAllLessons(),
    getAllVocabEntries(),
  ]);

  const result = mergeBackup(
    { lessons: localLessons, vocab: localVocab },
    { lessons: incoming.lessons, vocab: incoming.vocab },
  );

  return { safetySnapshot, result };
}

export async function commitImport(result: MergeResult): Promise<void> {
  await Promise.all([
    ...result.lessons.map((lesson) => putLesson(lesson)),
    ...result.vocab.map((entry) => putVocabEntry(entry)),
  ]);
}

/** 便利封装：不需要摘要确认环节时一步到位（例如测试、FR-11.13 恢复流程）。 */
export async function importBackup(incoming: BackupFile): Promise<MergeResult> {
  const { result } = await prepareImport(incoming);
  await commitImport(result);
  return result;
}
