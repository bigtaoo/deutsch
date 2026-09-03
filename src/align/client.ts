// 主线程侧：选后端、起 Worker、跑对齐、把结果落库，并全程往黑匣子里记面包屑。
//
// 一次只允许跑一个对齐任务。两个并行会各自占一份 187MB+ 的权重，
// 手机上直接 OOM，桌面上也只是互相抢 CPU。

import { getAudioBlob } from '@/db/cache';
import { useLessonStore } from '@/state/useLessonStore';
import { nativePlatform } from '@/platform/native';
import type { Lesson } from '@/types/models';
import { applyTimings, type ApplyResult } from './apply';
import { decodeToMono16k } from './decode';
import {
  LOCAL_MODEL_PATH,
  MMS_FA,
  NATIVE_PLAN,
  NATIVE_PLAN_STEP,
  PLAN_LADDER,
  hasLocalWeights,
  pickPlan,
} from './config';
import { emissionTransferables } from './emissionMatrix';
import {
  cancelNativeEmissions,
  computeNativeEmissions,
  nativeEmissionsAvailable,
} from './nativeEmissions';
import { probeRanged } from './rangedFetch';
import { buildTarget } from './target';
import { beginRun, finishRun, nextPlanStep, noteStage } from './journal';
import type { AlignOutcome, AlignProgress } from './align';
import type { AlignWorkerInput, AlignWorkerRequest, AlignWorkerResponse } from './worker';

/**
 * Worker 整个没了 —— 不是它抛的错，是它**被杀了**。
 *
 * 必须和普通抛错区分开，因为两者的后续处置相反：普通抛错（词表不对、音频没有可对齐的句子）
 * 重试一次也是同样的结果；被杀说明这台设备跑不动这一档，**下次必须降档**。
 * 而降档的判据来自黑匣子里的 `crashed` 计数（journal.crashedSteps），
 * 所以这一类必须记成 crashed 而不是 error —— 否则第 2 档会被无限重试。
 *
 * 实测（2026-09-02，Windows/Chrome，32GB）：`wasm/int8` 那份 302.6 MiB 权重
 * 在加载时就会让进程被干掉，JS 侧一行报错都没有。Worker 单独死就走到这里；
 * 整个 tab 一起死则连这里都到不了，靠下次启动 detectCrash() 兜。
 */
export class AlignWorkerDeath extends Error {
  constructor(message?: string) {
    super(message || '对齐进程被系统杀掉了 —— 多半是加载权重时内存不够');
    this.name = 'AlignWorkerDeath';
  }
}

let worker: Worker | null = null;
let nextId = 1;
let running = false;
/**
 * 原生 emissions 正在跑。`running` 管不了这一段 —— 那十几分钟里 Worker 还没起，
 * 所以「停止」要靠这一位才知道该往插件那边递取消（见 cancelAlignment）。
 */
let nativeRunning = false;
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

/**
 * 用户点「停止」。
 *
 * 两条路要分别停，而且**原生那条必须先停**：
 *   · Worker（浏览器那条）：整个干掉是唯一可靠的中断方式，ORT 的 run() 不可打断。
 *   · 原生那条：`running` 在算 emissions 的那十几分钟里**是 false** —— Worker 那时
 *     还没起。所以以前这个函数会在第一行就 return，「停止」在手机上整整十几分钟
 *     是个死按钮。现在它给插件递一个标志，插件在下一个块边界停下，
 *     已经算完的块留在断点里（变更 33）。
 */
export function cancelAlignment(): void {
  if (nativeRunning) void cancelNativeEmissions();
  if (!running) return;
  const reject = cancelCurrent;
  terminateAlignWorker();
  reject?.(new Error('已取消'));
}

/**
 * @param input 喂波形（本机全程算）还是喂已经算好的 log-prob 矩阵（只跑 viterbi）。
 *   两者底下那个 ArrayBuffer 都会被 **transfer** 进 Worker（音频 24MB、矩阵 3MB，
 *   拷一份没必要），所以调用方交出去之后不要再读它。
 */
export function runAlignment(
  input: AlignWorkerInput,
  sentences: Lesson['sentences'],
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
      // Worker 整个挂了 —— 下次重新起一个，
      // 不然后续每次调用都会往一个已死的 Worker 里 postMessage。
      terminateAlignWorker();
      // 空 message 的 ErrorEvent = 进程被外面干掉的，不是 JS 抛的。见 AlignWorkerDeath。
      reject(new AlignWorkerDeath(event.message));
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
    const request: AlignWorkerRequest = { id, sentences, release, ...input };
    w.postMessage(
      request,
      input.input === 'audio'
        ? [input.audio.buffer as ArrayBuffer]
        : emissionTransferables(input.emissions),
    );
  });
}

export interface AlignLessonResult extends ApplyResult {
  outcome: AlignOutcome;
}

/**
 * 对一课跑完整流程：取音频 → 解码 → 对齐 → 写回 Sentence（句级 + 词级）→ 触发同步。
 *
 * **句级和词级时间戳都进标注层**（2026-09-02 改，见 SPEC §0 变更 26）。
 * 词级曾经只进缓存层、不进备份，理由是「有音频+文稿就能重算」——
 * 但手机跑不动这个模型，在那台设备上它重算不出来，于是「桌面预处理、手机学习」
 * 只兑现了一半（句子能播，词不能）。现在一次对齐的产出全都跟着 Lesson 同步过去。
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

  // ── 原生那一条（SPEC §0 变更 31）──
  // iOS 原生壳里 emissions 整块挪出 WebView，走 native-plugins/align-native。
  // 它不在后端阶梯上：不 pickPlan、不探分片、也不参与降档（见 config.NATIVE_PLAN）。
  if (await nativeEmissionsAvailable()) return alignLessonNative(lesson, blob, onProgress, options);

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
    // ── 这里就是那道缝在应用层的位置 ──
    // 今天只有一条：把波形交给 Worker，让本机 provider（emissions.ts）算完再对齐。
    // 接原生插件或远端时，改的是这一行 —— 先拿到 EmissionMatrix，再用
    // `{ input: 'emissions', emissions }` 进同一个 Worker 跑 viterbi。
    // 下游（applyTimings → saveLesson → 同步）一行都不用动。
    const outcome = await runAlignment(
      { input: 'audio', audio, plan },
      lesson.sentences,
      report,
      release,
    );

    const applied = await saveOutcome(lesson, outcome, options, report);
    finishRun('done');
    if (release) terminateAlignWorker();
    return { ...applied, outcome };
  } catch (err) {
    // 正常抛错也要收尾：active 不清掉，下次启动会把这次误判成「被系统杀掉」。
    // 但 Worker 被杀**要**记成 crashed —— 那正是降档的判据（见 AlignWorkerDeath）。
    finishRun(
      err instanceof AlignWorkerDeath ? 'crashed' : 'error',
      err instanceof Error ? err.message : String(err),
    );
    if (release) terminateAlignWorker();
    throw err;
  }
}

/**
 * 两条路共用的收尾：写回时间戳 → 落库 → 触发同步。
 *
 * 抽出来是因为**它必须两条路逐字相同**：这一段决定了「一次对齐的产出有哪些」
 * （句级 + 词级都进标注层，见变更 26），原生那条路上任何一项漏掉，
 * 失败方式都是静默的 —— 界面照样说「对齐完成」，只是词级高亮不动。
 */
async function saveOutcome(
  lesson: Lesson,
  outcome: AlignOutcome,
  options: { overwriteManual?: boolean },
  report: (p: AlignProgress) => void,
): Promise<ApplyResult> {
  report({ stage: 'apply' });
  const applied = applyTimings(lesson.sentences, outcome.sentences, {
    audioDuration: outcome.duration,
    overwriteManual: options.overwriteManual,
    words: outcome.words,
  });

  // 一次写完：句级 + 词级都在 sentences 里，所以只有这一次落库。
  // saveLesson 自己会更新内存 store 并触发同步，不要在这里重复触发。
  await useLessonStore.getState().saveLesson({
    ...lesson,
    sentences: applied.sentences,
    // 解码出来的时长比 DW 页面上写的可靠，顺手校正。
    audioDuration: outcome.duration,
  });
  return applied;
}

/**
 * 原生那一条（iOS）。与上面那条的差别只有前半截：
 *
 *   · **不解码**。mp3 原样交给插件，`AVAudioFile` 在原生侧解 —— 桥上过 9MB 而不是 41MB，
 *     理由写在 nativeEmissions.ts 顶部。所以这条路上压根没有 `decode` 阶段。
 *   · **不选后端、不探分片、不降档**。planStep 记 `NATIVE_PLAN_STEP`（-1），
 *     它撞不上阶梯里的 0/1，`crashedSteps()` 因此不会把原生的失败算到那两档头上。
 *   · Worker 只跑 viterbi（`input: 'emissions'`），所以 `release` 没有意义 ——
 *     那 230MB 从来没进过 WebView。
 *
 * 后半截（viterbi → applyTimings → 落库 → 同步）与浏览器那条完全一样，走 saveOutcome。
 * 黑匣子照记：原生进程也会被 jetsam 杀，只是那条线高得多。
 */
async function alignLessonNative(
  lesson: Lesson,
  blob: Blob,
  onProgress?: (p: AlignProgress) => void,
  options: { overwriteManual?: boolean } = {},
): Promise<AlignLessonResult> {
  beginRun({
    lessonId: lesson.id,
    title: lesson.title,
    plan: NATIVE_PLAN,
    planStep: NATIVE_PLAN_STEP,
    platform: 'ios',
    // 原生只可能读包里那份 —— 插件是从 Bundle.main 里按路径打开文件的，
    // 没有「退到 CDN」这回事（那也正是它离线可用的原因）。
    weights: 'local',
  });
  const report = (p: AlignProgress) => {
    noteStage(p);
    onProgress?.(p);
  };

  try {
    // **必须在算 emissions 之前挡这一下。** 浏览器那条路上这件事由 Worker 里的
    // `assertAlignable()` 做，而原生这条路是「先算完矩阵再进 Worker」——
    // 不挡的话，一整课全被标成排除时会先在手机上白算几分钟再报「无事可做」。
    // 这里不 import align.ts 的 assertAlignable：那个文件静态连着 emissions.ts
    // → transformers.js，主线程一 import 主包就涨 500KB（README「已知的坑」那条）。
    if (buildTarget(lesson.sentences).ids.length === 0) {
      throw new Error('没有可对齐的句子：要么全被标成了非朗读内容，要么正文里没有字母');
    }
    // 键用 lesson id：断点跟着「这一课」走，而不是跟着这一次运行。
    // 插件那边还会拿音频长度和参数做指纹，换了音频的话旧中间态自己作废。
    nativeRunning = true;
    const emissions = await computeNativeEmissions(blob, MMS_FA, report, lesson.id).finally(() => {
      nativeRunning = false;
    });
    const outcome = await runAlignment({ input: 'emissions', emissions }, lesson.sentences, report);
    const applied = await saveOutcome(lesson, outcome, options, report);
    finishRun('done');
    return { ...applied, outcome };
  } catch (err) {
    finishRun('error', err instanceof Error ? err.message : String(err));
    throw err;
  }
}
