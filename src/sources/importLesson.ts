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
import { createSentences } from '@/lesson/sentences';
import { resegment } from '@/lesson/resegment';
import { readAudioDuration } from '@/audio/player';
import { manuscriptHash } from '@/lib/hash';
import { generateId } from '@/lib/id';
import { scheduleLessonSync } from '@/sync/trigger';
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

export async function importFromDw(
  lessonId: string,
  onProgress?: (progress: ImportProgress) => void,
  sourceUrl?: string,
): Promise<ImportOutcome> {
  onProgress?.({ step: 'page' });
  const dw = await politely(() => fetchLesson(lessonId, sourceUrl));

  // FR-13.7（2026-09-02 改）：**一句都不自动排除。**
  // 原来的规则是「首个 <strong> 块 = 标题 + teaser，音频里不朗读」——
  // 实测（Alltagsdeutsch 45334084）那是错的：播音员**照着念**标题和导语，
  // 一字不差。排除它们的后果不只是少练三句，而是把这段真实存在的音频
  // 从对齐目标里挖掉，逼 CTC 把开头几十秒的声音塞给第一句正文。
  // 音频里没念的段落（手动粘贴 PDF 时的文末 Glossar）仍然排除，只是走手工 ——
  // 「切句」页有开头/文末两个批量控件，逐句也能点。
  const sentences = createSentences(segmentSentences(dw.plainText));

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
    // 音频本身不进备份，地址进（§0 变更 27）。抓失败时也记 —— 那正是最需要它的时候。
    audioSrc: dw.audio?.mp3Src,
    audioDuration: dw.audio?.duration || undefined,
    // 补齐素材时拿它比「DW 换没换过音频」（§0 变更 43）。抓失败时没有这个数，
    // 那种课的第一次补齐会退回到比时长。
    audioBytes: audioBlob?.size,
    manuscriptHash: manuscriptHash(dw.plainText),
    sentences,
    glossary: buildCandidates(dw, sentences),
    createdAt: now,
    updatedAt: now,
  };

  const cache: LessonCache = {
    lessonId: id,
    manuscriptHtml: dw.manuscriptHtml,
    plainText: dw.plainText,
    hasAudio: Boolean(audioBlob),
    audioBytes: audioBlob?.size ?? 0,
    fetchedAt: now,
  };

  if (audioBlob) await putAudioBlob(id, audioBlob);
  await Promise.all([putLesson(lesson), putLessonCache(cache)]);
  await useLessonStore.getState().load();
  scheduleLessonSync(id);

  onProgress?.({ step: 'done' });
  return {
    lessonId: id,
    audioError,
    hasAudio: Boolean(audioBlob),
  };
}

export interface RehydrateOutcome {
  /** FR-3.7：文稿 hash 变了 —— DW 改过稿，时间戳与挖空 offset 可能全部失效 */
  manuscriptChanged: boolean;
  audioRestored: boolean;
  audioError?: string;
  /**
   * 重新抓到的音频和标注层记着的那份不是同一个 —— DW 换过音频，
   * 时间戳大概率整体作废，这一课要重对。
   *
   * 这一位是「补齐之后要不要重对」的**唯一**依据（变更 34）：
   * 以前是无条件重对，而在有同步的世界里那等于「在手机上重算桌面刚算好的值」。
   * 判据见 `audioChanged()` —— 变更 43 从「比时长」换成了「比字节数」。
   */
  audioChanged: boolean;
  /** manuscriptChanged 时，按新文稿重切的预览结果，等用户决定 */
  fresh?: { plainText: string; dw: DwLesson };
}

/**
 * 读一下这份音频的真实时长，读不出来就算了（返回 undefined）。
 *
 * 带超时：`readAudioDuration` 等的是 `<audio>` 的 loadedmetadata，而那个事件在
 * 某些 WebView / 某些损坏文件上既不来也不报错。补齐素材这条路上它只是个**辅助判据**
 * （老课程才用得上），不值得让「正在补齐」永远转下去。
 */
const DURATION_PROBE_TIMEOUT_MS = 10_000;

async function probeDuration(blob: Blob): Promise<number | undefined> {
  const timeout = new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), DURATION_PROBE_TIMEOUT_MS),
  );
  return Promise.race([readAudioDuration(blob).catch(() => undefined), timeout]);
}

/** 老课程没记过 audioBytes 时退回去比时长，容差放到这么宽。理由见 `audioChanged`。 */
export const DURATION_FALLBACK_TOLERANCE_SECONDS = 2;

/**
 * 补齐回来的这份音频，和标注层记着的是不是同一个（§0 变更 43）。
 *
 * **首选比字节数**：`Lesson.audioBytes` 是上一次下载时记下的，跟着同步走，
 * 两边同源，一个字节都不差才叫同一份。
 *
 * 老课程（变更 43 之前导入的）没有这个数，只好退回去比时长 —— 但要比对地方：
 * 拿**这次解码出来的**值去比标注层记着的，而不是拿 DW 页面上报的整数秒去比。
 * 后者正是这次要修的 bug：对齐完会把解码出来的精确值写回 audioDuration
 * （align/client.ts），于是一门在桌面上对齐过的课到了手机上，比的是
 * 「解码值 vs 页面整数」，差过 1 秒就被判成 DW 换过音频，白重对一次。
 * 容差也顺手放宽到 2 秒：漏不掉「DW 换了一版」——那种差的是分钟，不是秒。
 *
 * 两样都没有（既没记字节数，也没有旧时长）就一律当没变：这一课本来就没有时间戳，
 * 要不要对齐由 `hasTimings` 那一支回答，不该由这里猜。
 */
export function audioChanged(
  lesson: Pick<Lesson, 'audioBytes' | 'audioDuration'>,
  downloaded: { bytes: number; duration?: number } | undefined,
  pageDuration?: number,
): boolean {
  if (!downloaded) return false; // 这次压根没下到音频，无从比较
  if (lesson.audioBytes !== undefined) return downloaded.bytes !== lesson.audioBytes;
  const fresh = downloaded.duration ?? pageDuration;
  if (lesson.audioDuration === undefined || fresh === undefined) return false;
  return Math.abs(fresh - lesson.audioDuration) > DURATION_FALLBACK_TOLERANCE_SECONDS;
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

  // 页面上那份直链优先（CDN 地址会变），页面里找不到时退到标注层记着的那个地址 ——
  // 「记下载地址」这件事就是为了这一刻（§0 变更 27）。
  const mp3Src = dw.audio?.mp3Src ?? lesson.audioSrc;

  let audioRestored = false;
  let audioError: string | undefined;
  /** 这次真的下到了音频时才有；用来判断 DW 换没换过版本，以及回填 audioBytes。 */
  let downloaded: { bytes: number; duration?: number } | undefined;
  if (mp3Src) {
    try {
      const blob = await politely(() => downloadAudio(mp3Src));
      await putAudioBlob(lesson.id, blob);
      // 解码出来的时长和对齐写回的那个同源（align/client.ts）——
      // 老课程没记过 audioBytes 时，退回去比时长的那一支靠它才比得准。
      // 读不出来不算错：判据会退到页面上报的那个整数秒。
      downloaded = { bytes: blob.size, duration: await probeDuration(blob) };
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
        ...(manuscriptChanged ? {} : { manuscriptHtml: dw.manuscriptHtml, plainText: dw.plainText }),
      });
      audioRestored = true;
    } catch (err) {
      audioError = err instanceof Error ? err.message : String(err);
    }
  } else {
    audioError = '页面里没有找到音频直链，这一课也没有记录过原始下载地址';
  }

  // 标注层这边要更新的几样：刷新音频地址（CDN 直链会变）、记下字节数、必要时刷新时长，
  // 以及文稿没变时刷新候选词。文稿变了就不动候选词 —— 它的 offset 基于旧文稿，
  // 等用户在 FR-3.7 里做完决定。
  const nextAudioSrc = dw.audio?.mp3Src ?? lesson.audioSrc;
  const changed = audioChanged(lesson, downloaded, dw.audio?.duration);
  // **时长只在「确实换过音频」或「本来就没有」时才改写**（§0 变更 43）：
  // 对齐写回的是解码出来的精确值，比 DW 页面上报的整数秒可靠 —— 补齐一次素材
  // 就把它降级回整数，等于每台设备各记一个值，下次比起来又像是换过音频。
  const nextDuration =
    changed || lesson.audioDuration === undefined
      ? (downloaded?.duration ?? dw.audio?.duration ?? lesson.audioDuration)
      : lesson.audioDuration;
  const nextBytes = downloaded?.bytes ?? lesson.audioBytes;
  if (
    nextAudioSrc !== lesson.audioSrc ||
    nextDuration !== lesson.audioDuration ||
    nextBytes !== lesson.audioBytes ||
    !manuscriptChanged
  ) {
    await useLessonStore.getState().saveLesson({
      ...lesson,
      audioSrc: nextAudioSrc,
      audioDuration: nextDuration,
      audioBytes: nextBytes,
      glossary: manuscriptChanged ? lesson.glossary : buildCandidates(dw, lesson.sentences),
    });
  }

  await useLessonStore.getState().load();
  return {
    manuscriptChanged,
    audioRestored,
    audioError,
    audioChanged: changed,
    fresh: { plainText: dw.plainText, dw },
  };
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
    hasAudio: existing?.hasAudio ?? false,
    audioBytes: existing?.audioBytes ?? 0,
    fetchedAt: Date.now(),
  });
  await useLessonStore.getState().saveLesson({
    ...lesson,
    sentences: result.sentences,
    // 候选词的 offset 是按新文稿重算的 —— 必须跟着新句子一起换，
    // 留着旧的那份会让「点这个候选词」跳到别的位置上（静默错位）。
    glossary: buildCandidates(dw, result.sentences),
    manuscriptHash: manuscriptHash(dw.plainText),
  });
  await useLessonStore.getState().load();
  return result;
}
