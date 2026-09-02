import type { Lesson, VocabEntry, Settings } from '@/types/models';

/**
 * 全量备份文件 —— FR-11.11。
 * 标注层全部，缓存层零字节：不含 LessonCache / audioBlobs 的任何字节。
 */
export interface BackupFile {
  _warning: string;
  formatVersion: 1;
  exportedAt: number; // epoch ms
  lessons: Lesson[];
  vocab: VocabEntry[];
  settings: Settings;
}

export interface MergeSummary {
  addedLessons: string[]; // Lesson.id
  updatedLessons: string[]; // Lesson.id，本机版本被覆盖
  skippedLessons: string[]; // Lesson.id，本机版本更新，忽略导入的
  overwrittenLessonTitles: string[]; // 与 updatedLessons 对应，展示用（FR-11.14 验收：列出被覆盖的课程标题）
  addedVocab: string[]; // VocabEntry.id
  updatedVocab: string[];
  skippedVocab: string[];
  /** 设置被导入的那一份覆盖了（§0 变更 28：Settings 整体 last-write-wins） */
  settingsUpdated?: boolean;
}

export interface MergeResult {
  lessons: Lesson[];
  vocab: VocabEntry[];
  /** 合并后的设置。两边都没给设置时是 undefined —— 调用方据此判断「不用写」 */
  settings?: Settings;
  summary: MergeSummary;
}
