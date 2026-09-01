// 主线程侧：选后端、起 Worker、跑对齐、把结果落库，并全程往黑匣子里记面包屑。
//
// 一次只允许跑一个对齐任务。两个并行会各自占一份 187MB+ 的权重，
// 手机上直接 OOM，桌面上也只是互相抢 CPU。

import { getAudioBlob, getLessonCache, putLessonCache } from '@/db/cache';
import { useLessonStore } from '@/state/useLessonStore';
import { nativePlatform } from '@/platform/native';
import type { Lesson } from '@/types/models';
import { applyTimings, type ApplyResult } from './apply';
import { decodeToMono16k } from './decode';
import { LOCAL_MODEL_PATH, MMS_FA, PLAN_LADDER, hasLocalWeights, pickPlan } from './config';
import { probeRanged } from './rangedFetch';
import { beginRun, finishRun, nextPlanStep, noteStage } from './journal';
import type { AlignOutcome, AlignProgress } from './align';
import type { AlignWorkerRequest, AlignWorkerResponse } from './worker';

let worker: Worker | null = null;
let nextId = 1;
let running = false;
/** 取消要靠它把挂着的 Promise 拒掉 —— terminate() 之后 Worker 不会再回任何消息。 */
let cancelCurrent: ((reason: Error) => void) | null = null;

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

/** 换模型、或者想把那 187MB 从内存里放掉时用。下一次对齐会重新起。 */
export function terminateAlignWorker(): void {
  worker?.terminate();
  worker = null;
  running = false;
}

export function isAligning(): boolean {
  return running;
}

/** 用户点「停止」。Worker 整个干掉是唯一可靠的中断方式：ORT 的 run() 不可打断。 */
export function cancelAlignment(): void {
  if (!running) return;
  const reject = cancelCurrent;
  terminateAlignWorker();
  reject?.(new Error('已取消'));
}

/**
 * @param audio 已解好的单声道 16kHz 波形。它的 ArrayBuffer 会被 **transfer** 进 Worker
 *   （6 分钟音频是 24MB float32，拷一份没必要），所以调用方交出去之后不要再读它。
 */
export function runAlignment(
  audio: Float32Array,
  sentences: Lesson['sentences'],
  plan: AlignWorkerRequest['plan'],
  onProgress?: (p: AlignProgress) => void,
  release = false,
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
      cancelCurrent = null;
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };

    cancelCurrent = (reason) => {
      cleanup();
      reject(reason);
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    const request: AlignWorkerRequest = { id, audio, sentences, plan, release };
    w.postMessage(request, [audio.buffer]);
  });
}

export interface AlignLessonResult extends ApplyResult {
  outcome: AlignOutcome;
}

/**
 * 对一课跑完整流程：取音频 → 解码 → 对齐 → 写回 Sentence + LessonCache.wordTimings → 触发备份。
 *
 * 词级时间戳进缓存层（不进备份），句级时间戳进标注层（进备份）。
 * 所以手机上换个设备打开，句子照样能播 —— 这就是「桌面预处理、手机学习」成立的原因。
 *
 * 全程往 journal.ts 记面包屑：这一步是**唯一**能在「进程被系统杀掉」之后还留下证据的机制。
 */
export async function alignLesson(
  lesson: Lesson,
  onProgress?: (p: AlignProgress) => void,
  options: { overwriteManual?: boolean } = {},
): Promise<AlignLessonResult> {
  const blob = await getAudioBlob(lesson.id);
  if (!blob) throw new Error('本机没有这一课的音频，先去「素材」里下载');

  // 后端与「随包还是 CDN」都在主线程定：黑匣子在 localStorage 里，Worker 读不到。
  const { plan, step } = await pickPlan(nextPlanStep(PLAN_LADDER.length));
  const platform = await nativePlatform();
  const weights = (await hasLocalWeights(MMS_FA)) ? 'local' : 'cdn';
  // 随包权重会不会走分片那条路（rangedFetch.ts）。Worker 里那次探测的结果拿不出来，
  // 而这一位正是那次 iPhone 崩溃修复的验收凭据 —— 所以这里自己探一次。
  // 代价是一个 1 字节的请求（body 当场掐掉），URL 与 Worker 要取的那份完全一致。
  const ranged =
    weights === 'local'
      ? (await probeRanged(`${LOCAL_MODEL_PATH}${MMS_FA.modelId}/onnx/model_${plan.dtype}.onnx`)) !== null
      : undefined;
  // 手机上跑完就把权重放掉（连着 Worker 一起干掉最彻底）。见 worker.ts 的 release。
  const release = platform !== 'web';

  beginRun({ lessonId: lesson.id, title: lesson.title, plan, planStep: step, platform, weights, ranged });
  const report = (p: AlignProgress) => {
    noteStage(p);
    onProgress?.(p);
  };

  try {
    report({ stage: 'decode' });
    // 解码必须在主线程（Web Audio 在 Worker 里不存在）。6 分钟 mp3 大约 1 秒，
    // 之后波形直接 transfer 进 Worker，主线程就空出来了。
    const audio = await decodeToMono16k(blob, MMS_FA.sampleRate);
    const outcome = await runAlignment(audio, lesson.sentences, plan, report, release);

    report({ stage: 'apply' });
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

    finishRun('done');
    if (release) terminateAlignWorker();
    return { ...applied, outcome };
  } catch (err) {
    // 正常抛错也要收尾：active 不清掉，下次启动会把这次误判成「被系统杀掉」。
    finishRun('error', err instanceof Error ? err.message : String(err));
    if (release) terminateAlignWorker();
    throw err;
  }
}
