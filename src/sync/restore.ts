// FR-11.13：一键从服务器恢复到空设备。
//
// 恢复路径是**最容易悄悄坏掉**的那条 —— 平时没人走，等真需要时才发现它早就不通了（§2.6.5）。
// 所以它必须是一个按钮，而不是一段「先 curl 下来再手动导入 JSON」的说明。
//
// 恢复只写标注层：课程、生词、设置（§0 变更 28）、学习记录（FR-18）、AI 缓存（变更 49）。
// 课程会显示「素材未下载」，音频靠 FR-3.5 照 Lesson.audioSrc 或 lesson id 重新抓 ——
// 这正是 R-缓存-2「缓存不跨端」能成立的原因。

import { mergeBackup } from '@/backup/merge';
import { getAllLessons, putLesson } from '@/db/lessons';
import { getAllVocabEntries, putVocabEntry } from '@/db/vocab';
import { getSettings, putSettings } from '@/db/meta';
import type { MergeSummary } from '@/backup/types';
import { getStudyLog, mergeStudyLogs, putStudyLog, type StudyLog } from '@/study/log';
import { getAiCache, mergeAiCaches, putAiCache, type AiCache } from '@/ai/cache';
import type { Lesson, Settings, VocabEntry } from '@/types/models';
import { getSessionToken } from './session';
import { SyncAuthError } from './client';
import {
  AI_CACHE_DOC_ID,
  SETTINGS_DOC_ID,
  STUDY_DOC_ID,
  VOCAB_DOC_ID,
  getRemoteDoc,
  lessonIdFromDocId,
  listRemoteDocs,
  rememberVersion,
} from './docs';

export interface RestoreResult {
  summary: MergeSummary;
  lessonsFetched: number;
  vocabFetched: number;
  /** 远端那份设置赢了、已经写进本地 */
  settingsRestored: boolean;
  /** 远端那份学习记录里有本地没有的东西，已经合进本地（FR-18） */
  studyRestored: boolean;
  /** 远端那份 AI 缓存里有本地没有（或更新）的词，已经合进本地（变更 49） */
  aiCacheRestored: boolean;
  /** 单个文档坏掉不该让整次恢复失败：坏的记在这里，好的照常写入。 */
  failures: string[];
}

export async function restoreFromServer(): Promise<RestoreResult> {
  const token = await getSessionToken();
  if (!token) throw new SyncAuthError('尚未登录');

  const failures: string[] = [];
  const incomingLessons: Lesson[] = [];
  let incomingVocab: VocabEntry[] = [];
  let incomingSettings: Settings | undefined;
  let incomingStudy: StudyLog | undefined;
  let incomingAiCache: AiCache | undefined;

  for (const meta of await listRemoteDocs(token)) {
    try {
      if (meta.id === VOCAB_DOC_ID) {
        const doc = await getRemoteDoc<VocabEntry[]>(token, meta.id);
        if (doc) {
          incomingVocab = doc.body;
          await rememberVersion(meta.id, doc.version);
        }
        continue;
      }
      if (meta.id === SETTINGS_DOC_ID) {
        const doc = await getRemoteDoc<Settings>(token, meta.id);
        if (doc) {
          incomingSettings = doc.body;
          await rememberVersion(meta.id, doc.version);
        }
        continue;
      }
      if (meta.id === STUDY_DOC_ID) {
        const doc = await getRemoteDoc<StudyLog>(token, meta.id);
        if (doc?.body?.days) {
          incomingStudy = doc.body;
          await rememberVersion(meta.id, doc.version);
        }
        continue;
      }
      if (meta.id === AI_CACHE_DOC_ID) {
        const doc = await getRemoteDoc<AiCache>(token, meta.id);
        if (doc?.body?.entries) {
          incomingAiCache = doc.body;
          await rememberVersion(meta.id, doc.version);
        }
        continue;
      }
      if (lessonIdFromDocId(meta.id) === null) continue; // 不认识的文档类型，跳过
      const doc = await getRemoteDoc<Lesson>(token, meta.id);
      if (doc) {
        incomingLessons.push(doc.body);
        await rememberVersion(meta.id, doc.version);
      }
    } catch (err) {
      failures.push(`${meta.id}：${err instanceof Error ? err.message : err}`);
    }
  }

  // 走 §2.4 的同一套合并规则，不是「清空后覆盖」—— 恢复到一台**已有数据**的设备上
  // （比如想把手机的复习状态拉回桌面）是完全正常的用法。
  const [localLessons, localVocab, localSettings] = await Promise.all([
    getAllLessons(),
    getAllVocabEntries(),
    getSettings(),
  ]);
  const result = mergeBackup(
    { lessons: localLessons, vocab: localVocab, settings: localSettings },
    { lessons: incomingLessons, vocab: incomingVocab, settings: incomingSettings },
  );

  const settingsRestored = Boolean(result.settings && result.summary.settingsUpdated);

  // 学习记录不进 mergeBackup：它的合并规则（逐格取 max）和那三样都不一样，
  // 硬塞进去只会让那个纯函数多一个与它无关的形状。
  let studyRestored = false;
  if (incomingStudy) {
    const { merged, changed } = mergeStudyLogs(await getStudyLog(), incomingStudy);
    if (changed) {
      await putStudyLog(merged);
      studyRestored = true;
    }
  }

  // AI 缓存也不进 mergeBackup，理由同学习记录：合并规则（逐词比 ts）跟那三样不一样。
  let aiCacheRestored = false;
  if (incomingAiCache) {
    const { merged, changed } = mergeAiCaches(await getAiCache(), incomingAiCache);
    if (changed) {
      await putAiCache(merged);
      aiCacheRestored = true;
    }
  }

  await Promise.all([
    ...result.lessons.map((lesson) => putLesson(lesson)),
    ...result.vocab.map((entry) => putVocabEntry(entry)),
    // 本地那份更新时不写 —— 空设备上 getSettings() 给的是默认值（updatedAt 缺失），
    // 所以远端只要改过一次就赢，正是恢复该有的行为。
    ...(settingsRestored ? [putSettings(result.settings!)] : []),
  ]);

  return {
    summary: result.summary,
    lessonsFetched: incomingLessons.length,
    vocabFetched: incomingVocab.length,
    settingsRestored,
    studyRestored,
    aiCacheRestored,
    failures,
  };
}
