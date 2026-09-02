// FR-13.4 ~ FR-13.9 的编排层：把 adapter 取回的数据接进既有的导入流程。
//
// FR-13.6 的分寸：自动导入**不是独立分支**，它只替 FR-1.2 / FR-1.3 填数据。
// 切句、段落排除、挖空全部走原来那套 —— 这里一行切句逻辑都不重写。
//
// FR-13.10 / R-3：串行请求、间隔 ≥ 1s。所有出网请求都过 politely()。
//
// **有一个批量导入了**（FR-13.12，`./backfill.ts`），但它仍然满足 R-3：
// 有硬上限且没有「全部」这个选项、只从已拉到的 RSS 列表里取、
// 速率约束复用这里的 politely() 而不是自己重写一套。R-3 禁的是
// 「一键导入全部 100 期」那个形状，不是「有循环」。理由写在那个文件头部。

import { putLesson } from '@/db/lessons';
import { getLessonCache, putAudioBlob, putLessonCache } from '@/db/cache';
import { segmentSentences } from '@/lesson/segment';
import { createSentences, setExcluded } from '@/lesson/sentences';
import { resegment } from '@/lesson/resegment';
import { manuscriptHash } from '@/lib/hash';
import { generateId } from '@/lib/id';
import { scheduleLessonBackup } from '@/github/backupTrigger';
import { useLessonStore } from '@/state/useLessonStore';
import { downloadAudio, fetchLesson, mapSpansToSentences, type DwLesson } from './dw/adapter';
import type { GlossaryCandidate, Lesson, LessonCache, Sentence } from '@/types/models';

const MIN_REQUEST_INTERVAL_MS = 1000;
let lastRequestAt = 0;

/** R-3：礼貌抓取。所有出网请求都从这里过一遍，保证彼此间隔 ≥ 1s 且串行。 */
export async function politely<T>(task: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
  return task();
}

export interface ImportProgress {
  step: 'page' | 'audio' | 'saving' | 'done';
  loaded?: number;
  total?: number;
}

export interface ImportOutcome {
  lessonId: string;
  /** FR-13.9：抓到哪算哪。文本成功而音频失败时这里有值，课程照样建出来 */
  audioError?: string;
  /** FR-13.7 判定失败：teaser 块与 teaser 对不上，需要人工确认 */
  teaserNeedsReview: boolean;
  /**
   * 音频到位了 —— 调用方据此把这一课排进自动对齐队列（FR-15）。
   *
   * 对齐**不在这个函数里跑**：它要几分钟到十几分钟，而导入本身是秒级的。
   * 塞在一起会让「导入」按钮转十分钟，还会把进度绑死在来源页上（切走就看不见了）。
   * 现在导入一落库就返回，对齐交给 useAlignStore 的队列，进度常驻在应用底部。
   */
  hasAudio: boolean;
}

function buildCandidates(dw: DwLesson, sentences: Sentence[]): GlossaryCandidate[] {
  return mapSpansToSentences(dw.spans, sentences, dw.knowledges).map((c) => ({
    dwKnowledgeId: c.dwKnowledgeId,
    sentenceIndex: c.sentenceIndex,
    ranges: c.ranges,
    surface: c.surface,
    title: c.title,
    lemma: c.lemma,
    gender: c.gender,
    plural: c.plural,
    meaning: c.meaning,
  }));
}

/** FR-13.7：teaser 块对得上就自动排除；对不上一句都不排，交给人工确认。 */
function excludeTeaserBlock(sentences: Sentence[], dw: DwLesson): Sentence[] {
  const block = dw.teaserBlock;
  if (!block || !block.matchesTeaser) return sentences;
  let next = sentences;
  for (const sentence of sentences) {
    if (sentence.charStart < block.end && block.start < sentence.charEnd) {
      next = setExcluded(next, sentence.index, true);
    }
  }
  return next;
}

export async function importFromDw(
  lessonId: string,
  onProgress?: (progress: ImportProgress) => void,
  sourceUrl?: string,
): Promise<ImportOutcome> {
  onProgress?.({ step: 'page' });
  const dw = await politely(() => fetchLesson(lessonId, sourceUrl));

  const sentences = excludeTeaserBlock(createSentences(segmentSentences(dw.plainText)), dw);

  // FR-13.5：音频与文本任一失败不影响另一个。
  let audioBlob: Blob | undefined;
  let audioError: string | undefined;
  if (dw.audio) {
    onProgress?.({ step: 'audio', loaded: 0, total: 0 });
    try {
      audioBlob = await politely(() =>
        downloadAudio(dw.audio!.mp3Src, (loaded, total) => onProgress?.({ step: 'audio', loaded, total })),
      );
    } catch (err) {
      audioError = err instanceof Error ? err.message : String(err);
    }
  } else {
    audioError = '页面里没有找到音频直链';
  }

  onProgress?.({ step: 'saving' });
  const id = generateId();
  const now = Date.now();

  const lesson: Lesson = {
    id,
    title: dw.title,
    source: { type: 'dw', dwLessonId: lessonId, sourceUrl: dw.sourceUrl },
    audioDuration: dw.audio?.duration || undefined,
    manuscriptHash: manuscriptHash(dw.plainText),
    sentences,
    createdAt: now,
    updatedAt: now,
  };

  const cache: LessonCache = {
    lessonId: id,
    manuscriptHtml: dw.manuscriptHtml,
    plainText: dw.plainText,
    glossary: buildCandidates(dw, sentences),
    hasAudio: Boolean(audioBlob),
    audioBytes: audioBlob?.size ?? 0,
    fetchedAt: now,
  };

  if (audioBlob) await putAudioBlob(id, audioBlob);
  await Promise.all([putLesson(lesson), putLessonCache(cache)]);
  await useLessonStore.getState().load();
  scheduleLessonBackup(id);

  onProgress?.({ step: 'done' });
  return {
    lessonId: id,
    audioError,
    teaserNeedsReview: Boolean(dw.teaserBlock && !dw.teaserBlock.matchesTeaser),
    hasAudio: Boolean(audioBlob),
  };
}

export interface RehydrateOutcome {
  /** FR-3.7：文稿 hash 变了 —— DW 改过稿，时间戳与挖空 offset 可能全部失效 */
  manuscriptChanged: boolean;
  audioRestored: boolean;
  audioError?: string;
  /** manuscriptChanged 时，按新文稿重切的预览结果，等用户决定 */
  fresh?: { plainText: string; dw: DwLesson };
}

/**
 * FR-3.5：补齐素材。凭 source.dwLessonId 重新拉页面与音频。
 *
 * **不**自动按新文稿重切：FR-3.7 说得很明白 —— 文稿变了就是标注可能全废的信号，
 * 必须显式警告让用户选，不能静默接受。
 */
export async function rehydrateLesson(lesson: Lesson): Promise<RehydrateOutcome> {
  if (lesson.source.type !== 'dw') throw new Error('这一课不是 DW 来源，无法自动补齐');

  const dw = await politely(() => fetchLesson(lesson.source.type === 'dw' ? lesson.source.dwLessonId : ''));
  const manuscriptChanged =
    lesson.manuscriptHash !== undefined && lesson.manuscriptHash !== manuscriptHash(dw.plainText);

  let audioRestored = false;
  let audioError: string | undefined;
  if (dw.audio) {
    try {
      const blob = await politely(() => downloadAudio(dw.audio!.mp3Src));
      await putAudioBlob(lesson.id, blob);
      const existing = await getLessonCache(lesson.id);
      await putLessonCache({
        ...existing,
        lessonId: lesson.id,
        hasAudio: true,
        audioBytes: blob.size,
        fetchedAt: Date.now(),
        // 文稿没变才敢用新抓的正文覆盖缓存：句子的 charStart/charEnd 与候选词 offset
        // 全都基于 plainText，文稿一变它们就集体失效。这时保留旧的那份，
        // 等用户在 FR-3.7 的两个选项里做完决定再说。
        ...(manuscriptChanged
          ? {}
          : {
              manuscriptHtml: dw.manuscriptHtml,
              plainText: dw.plainText,
              glossary: buildCandidates(dw, lesson.sentences),
            }),
      });
      audioRestored = true;
    } catch (err) {
      audioError = err instanceof Error ? err.message : String(err);
    }
  } else {
    audioError = '页面里没有找到音频直链';
  }

  await useLessonStore.getState().load();
  return { manuscriptChanged, audioRestored, audioError, fresh: { plainText: dw.plainText, dw } };
}

/**
 * FR-3.7 的「按新文稿重切」分支。保留能匹配上的标注（FR-1.5），其余由 UI 列出来。
 * 另一个分支「保留旧标注自行核对」什么都不用做 —— 缓存里留着的就是旧文稿。
 */
export async function acceptNewManuscript(lesson: Lesson, dw: DwLesson) {
  const result = resegment(lesson.sentences, segmentSentences(dw.plainText));
  const existing = await getLessonCache(lesson.id);
  await putLessonCache({
    ...existing,
    lessonId: lesson.id,
    manuscriptHtml: dw.manuscriptHtml,
    plainText: dw.plainText,
    glossary: buildCandidates(dw, result.sentences),
    hasAudio: existing?.hasAudio ?? false,
    audioBytes: existing?.audioBytes ?? 0,
    fetchedAt: Date.now(),
  });
  await useLessonStore.getState().saveLesson({
    ...lesson,
    sentences: result.sentences,
    manuscriptHash: manuscriptHash(dw.plainText),
  });
  await useLessonStore.getState().load();
  return result;
}
