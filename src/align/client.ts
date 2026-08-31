// 主线程侧：起 Worker、跑对齐、把结果落库。
//
// 一次只允许跑一个对齐任务。两个并行会各自占一份 200MB+ 的权重，
// 手机上直接 OOM，桌面上也只是互相抢 CPU。

import { getAudioBlob, getLessonCache, putLessonCache } from '@/db/cache';
import { useLessonStore } from '@/state/useLessonStore';
import type { Lesson } from '@/types/models';
import { applyTimings, type ApplyResult } from './apply';
import { decodeToMono16k } from './decode';
import { MMS_FA } from './config';
import type { AlignOutcome, AlignProgress } from './align';
import type { AlignWorkerRequest, AlignWorkerResponse } from './worker';

let worker: Worker | null = null;
let nextId = 1;
let running = false;

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

/** 换模型、或者想把那 200MB 从内存里放掉时用。下一次对齐会重新起。 */
export function terminateAlignWorker(): void {
  worker?.terminate();
  worker = null;
  running = false;
}

export function isAligning(): boolean {
  return running;
}

/**
 * @param audio 已解好的单声道 16kHz 波形。它的 ArrayBuffer 会被 **transfer** 进 Worker
 *   （6 分钟音频是 24MB float32，拷一份没必要），所以调用方交出去之后不要再读它。
 */
export function runAlignment(
  audio: Float32Array,
  sentences: Lesson['sentences'],
  onProgress?: (p: AlignProgress) => void,
): Promise<AlignOutcome> {
  if (running) return Promise.reject(new Error('已经有一个对齐任务在跑了'));
  running = true;
  const id = nextId++;
  const w = ensureWorker();

  return new Promise<AlignOutcome>((resolve, reject) => {
    const onMessage = (event: MessageEvent<AlignWorkerResponse>) => {
      const msg = event.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') {
        onProgress?.(msg.progress);
        return;
      }
      cleanup();
      if (msg.type === 'done') resolve(msg.outcome);
      else reject(new Error(msg.message));
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      // Worker 整个挂了（多半是模型加载失败）——下次重新起一个，
      // 不然后续每次调用都会往一个已死的 Worker 里 postMessage。
      terminateAlignWorker();
      reject(new Error(event.message || '对齐 Worker 异常退出'));
    };
    const cleanup = () => {
      running = false;
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };

    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    const request: AlignWorkerRequest = { id, audio, sentences };
    w.postMessage(request, [audio.buffer]);
  });
}

export interface AlignLessonResult extends ApplyResult {
  outcome: AlignOutcome;
}

/**
 * 对一课跑完整流程：取音频 → 对齐 → 写回 Sentence + LessonCache.wordTimings → 触发备份。
 *
 * 词级时间戳进缓存层（不进备份），句级时间戳进标注层（进备份）。
 * 所以手机上换个设备打开，句子照样能播 —— 这就是「桌面预处理、手机学习」成立的原因。
 */
export async function alignLesson(
  lesson: Lesson,
  onProgress?: (p: AlignProgress) => void,
  options: { overwriteManual?: boolean } = {},
): Promise<AlignLessonResult> {
  const blob = await getAudioBlob(lesson.id);
  if (!blob) throw new Error('本机没有这一课的音频，先去「素材」里下载');

  // 解码必须在主线程（Web Audio 在 Worker 里不存在）。6 分钟 mp3 大约 1 秒，
  // 之后波形直接 transfer 进 Worker，主线程就空出来了。
  const audio = await decodeToMono16k(blob, MMS_FA.sampleRate);
  const outcome = await runAlignment(audio, lesson.sentences, onProgress);
  const applied = applyTimings(lesson.sentences, outcome.sentences, {
    audioDuration: outcome.duration,
    overwriteManual: options.overwriteManual,
  });

  const cache = await getLessonCache(lesson.id);
  await putLessonCache({
    ...cache,
    lessonId: lesson.id,
    hasAudio: true,
    audioBytes: cache?.audioBytes ?? blob.size,
    fetchedAt: cache?.fetchedAt ?? Date.now(),
    wordTimings: outcome.words,
  });

  // saveLesson 自己会更新内存 store 并 scheduleLessonBackup，不要在这里重复触发备份。
  await useLessonStore.getState().saveLesson({
    ...lesson,
    sentences: applied.sentences,
    // 解码出来的时长比 DW 页面上写的可靠，顺手校正。
    audioDuration: outcome.duration,
  });
  // 但 wordTimings 是直接写进 LessonCache 的，store 里那份 caches 快照还是旧的，
  // 得重读一次 —— 否则听写页拿不到刚算出来的词级时间戳。
  await useLessonStore.getState().load();

  return { ...applied, outcome };
}
