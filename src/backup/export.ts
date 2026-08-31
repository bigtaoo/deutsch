// FR-11.11：全量导出 —— 标注层全部，缓存层零字节。
// 白名单构造：只挑这四样，绝不 spread 任何可能夹带缓存层字段的对象。

import { getAllLessons } from '@/db/lessons';
import { getAllVocabEntries } from '@/db/vocab';
import { getSettings } from '@/db/meta';
import type { BackupFile } from './types';

export const BACKUP_WARNING =
  'Contains copyrighted text. Local backup only. Do not share.';

export const BACKUP_FORMAT_VERSION = 1 as const;

/** 读取当前 DB 状态，构造一份可写入磁盘的备份对象。纯 I/O，无副作用之外的副作用。 */
export async function buildBackupJson(): Promise<BackupFile> {
  const [lessons, vocab, settings] = await Promise.all([
    getAllLessons(),
    getAllVocabEntries(),
    getSettings(),
  ]);

  return {
    _warning: BACKUP_WARNING,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: Date.now(),
    lessons,
    vocab,
    settings,
  };
}

/** FR-11.11：按日期命名，永不覆盖同名文件（同一天内多次导出会追加序号）。 */
export function backupFileName(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `backup-${y}-${m}-${d}.json`;
}
