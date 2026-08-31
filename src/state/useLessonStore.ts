// 课程与素材缓存的唯一写入口。
//
// 两件容易出事、所以集中在这里做的事：
//   1. 任何改动标注层都要 touch updatedAt（§2.4 合并规则拿它比新旧）并触发去抖备份（FR-11.7）。
//   2. 句子结构编辑会重排 index，必须同步 VocabEntry.sentenceIndex，否则生词的出处静默错位。

import { create } from 'zustand';
import { getAllLessons, getLesson, putLesson, deleteLesson } from '@/db/lessons';
import {
  deleteLessonCache,
  getAllLessonCaches,
  getLessonCache,
  putAudioBlob,
  putLessonCache,
} from '@/db/cache';
import { getVocabEntriesByLesson, putVocabEntry } from '@/db/vocab';
import { scheduleLessonBackup } from '@/github/backupTrigger';
import { generateId } from '@/lib/id';
import { manuscriptHash } from '@/lib/hash';
import { readAudioDuration } from '@/audio/player';
import { segmentSentences } from '@/lesson/segment';
import { createSentences } from '@/lesson/sentences';
import { resegment, type ResegmentResult } from '@/lesson/resegment';
import type { Lesson, LessonCache, Sentence } from '@/types/models';

export interface NewLessonInput {
  title: string;
  sourceUrl?: string;
  /** DW 来源才有；有它才能自动补齐（FR-3.5） */
  dwLessonId?: string;
  manuscriptHtml?: string;
  plainText: string;
  audioFile?: File;
}

interface LessonState {
  lessons: Lesson[];
  caches: Record<string, LessonCache>;
  loaded: boolean;

  load: () => Promise<void>;
  createLesson: (input: NewLessonInput) => Promise<string>;
  saveLesson: (lesson: Lesson) => Promise<void>;

  /**
   * 读-改-写的唯一安全形式：updater 拿到的一定是 store 里最新的那一份。
   *
   * 组件闭包里的 lesson 是上一次渲染的快照。连按 Enter 快速打点时，
   * 两次回调可能都拿到同一个旧对象，后一次把前一次的时间戳整个抹掉 ——
   * 而且抹得悄无声息，只表现为「刚才那句好像没标上」。
   */
  patchLesson: (lessonId: string, updater: (lesson: Lesson) => Lesson) => Promise<void>;

  removeLesson: (id: string) => Promise<void>;

  /** 句子结构编辑的统一出口；给了 indexMap 就顺带迁移 VocabEntry.sentenceIndex。 */
  updateSentences: (
    lessonId: string,
    sentences: Sentence[],
    indexMap?: Map<number, number>,
  ) => Promise<void>;

  /** FR-1.5：改了原文重新切句，保留能匹配上的标注。 */
  resegmentLesson: (lessonId: string, plainText: string, manuscriptHtml?: string) => Promise<ResegmentResult>;

  /** FR-1.3 / FR-3.6：绑定本地音频文件。 */
  attachAudio: (lessonId: string, file: File) => Promise<{ duration: number; mismatch: boolean }>;

  /** FR-3.8 / FR-3.9：清除单课缓存（标注层不动）。 */
  clearCache: (lessonId: string) => Promise<void>;
}

/** 时长差超过这个值就警告「时间戳可能失效」（FR-3.6）。 */
export const DURATION_TOLERANCE_SECONDS = 0.5;

function touch(lesson: Lesson): Lesson {
  return { ...lesson, updatedAt: Date.now() };
}

export const useLessonStore = create<LessonState>((set, get) => ({
  lessons: [],
  caches: {},
  loaded: false,

  load: async () => {
    const [lessons, caches] = await Promise.all([getAllLessons(), getAllLessonCaches()]);
    set({
      lessons: lessons.sort((a, b) => b.createdAt - a.createdAt),
      caches: Object.fromEntries(caches.map((c) => [c.lessonId, c])),
      loaded: true,
    });
  },

  createLesson: async (input) => {
    const id = generateId();
    const now = Date.now();
    const sentences = createSentences(segmentSentences(input.plainText));

    let audioDuration: number | undefined;
    let audioBytes = 0;
    if (input.audioFile) {
      audioDuration = await readAudioDuration(input.audioFile);
      audioBytes = input.audioFile.size;
      await putAudioBlob(id, input.audioFile);
    }

    const lesson: Lesson = {
      id,
      title: input.title,
      source: input.dwLessonId
        ? { type: 'dw', dwLessonId: input.dwLessonId, sourceUrl: input.sourceUrl ?? '' }
        : { type: 'manual', audioFileName: input.audioFile?.name },
      audioDuration,
      manuscriptHash: manuscriptHash(input.plainText),
      sentences,
      createdAt: now,
      updatedAt: now,
    };

    const cache: LessonCache = {
      lessonId: id,
      manuscriptHtml: input.manuscriptHtml,
      plainText: input.plainText,
      hasAudio: Boolean(input.audioFile),
      audioBytes,
      fetchedAt: now,
    };

    await Promise.all([putLesson(lesson), putLessonCache(cache)]);
    set({
      lessons: [lesson, ...get().lessons],
      caches: { ...get().caches, [id]: cache },
    });
    scheduleLessonBackup(id);
    return id;
  },

  saveLesson: async (lesson) => {
    const next = touch(lesson);
    // 先同步更新内存，再落库。顺序反过来的话，`await putLesson` 之前 store 还是旧值，
    // 同一帧内连来的第二次修改会读到旧快照并把第一次覆盖掉 ——
    // 表现就是「连按 Enter 打点，只有最后一下留下来了」。
    set({ lessons: get().lessons.map((l) => (l.id === next.id ? next : l)) });
    await putLesson(next);
    scheduleLessonBackup(next.id);
  },

  patchLesson: async (lessonId, updater) => {
    const lesson = get().lessons.find((l) => l.id === lessonId);
    if (!lesson) return;
    await get().saveLesson(updater(lesson));
  },

  removeLesson: async (id) => {
    await Promise.all([deleteLesson(id), deleteLessonCache(id)]);
    const caches = { ...get().caches };
    delete caches[id];
    set({ lessons: get().lessons.filter((l) => l.id !== id), caches });
  },

  updateSentences: async (lessonId, sentences, indexMap) => {
    const lesson = get().lessons.find((l) => l.id === lessonId) ?? (await getLesson(lessonId));
    if (!lesson) return;

    if (indexMap) {
      const entries = await getVocabEntriesByLesson(lessonId);
      await Promise.all(
        entries.map(async (entry) => {
          const mapped = indexMap.get(entry.sentenceIndex);
          if (mapped === undefined || mapped === entry.sentenceIndex) return;
          await putVocabEntry({ ...entry, sentenceIndex: mapped, updatedAt: Date.now() });
        }),
      );
    }

    await get().saveLesson({ ...lesson, sentences });
  },

  resegmentLesson: async (lessonId, plainText, manuscriptHtml) => {
    const lesson = get().lessons.find((l) => l.id === lessonId) ?? (await getLesson(lessonId));
    if (!lesson) throw new Error('课程不存在');

    const result = resegment(lesson.sentences, segmentSentences(plainText));
    const cache = (await getLessonCache(lessonId)) ?? {
      lessonId,
      hasAudio: false,
      audioBytes: 0,
      fetchedAt: Date.now(),
    };
    const nextCache: LessonCache = {
      ...cache,
      plainText,
      manuscriptHtml: manuscriptHtml ?? cache.manuscriptHtml,
    };
    await putLessonCache(nextCache);
    set({ caches: { ...get().caches, [lessonId]: nextCache } });

    await get().saveLesson({
      ...lesson,
      sentences: result.sentences,
      manuscriptHash: manuscriptHash(plainText),
    });
    return result;
  },

  attachAudio: async (lessonId, file) => {
    const lesson = get().lessons.find((l) => l.id === lessonId) ?? (await getLesson(lessonId));
    if (!lesson) throw new Error('课程不存在');

    const duration = await readAudioDuration(file);
    await putAudioBlob(lessonId, file);

    const cache = (await getLessonCache(lessonId)) ?? {
      lessonId,
      hasAudio: false,
      audioBytes: 0,
      fetchedAt: Date.now(),
    };
    const nextCache: LessonCache = {
      ...cache,
      hasAudio: true,
      audioBytes: file.size,
      fetchedAt: Date.now(),
    };
    await putLessonCache(nextCache);
    set({ caches: { ...get().caches, [lessonId]: nextCache } });

    // FR-3.6：时长对不上说明换了个文件，已有时间戳大概率作废。不阻止，只警告。
    const mismatch =
      lesson.audioDuration !== undefined &&
      Math.abs(lesson.audioDuration - duration) > DURATION_TOLERANCE_SECONDS;

    if (lesson.audioDuration === undefined) {
      await get().saveLesson({ ...lesson, audioDuration: duration });
    }
    return { duration, mismatch };
  },

  clearCache: async (lessonId) => {
    await deleteLessonCache(lessonId);
    const caches = { ...get().caches };
    delete caches[lessonId];
    set({ caches });
  },
}));

/** FR-3.4：标注层有这一课但本机没素材 —— UI 要显式说「素材未下载」，不能装作能播。 */
export function isMaterialMissing(cache: LessonCache | undefined): boolean {
  return !cache?.hasAudio;
}

/** FR-3.9：DW 来源清缓存无损，手动来源清了就得自己再找回音频文件。 */
export function isRehydratable(lesson: Lesson): boolean {
  return lesson.source.type === 'dw';
}
