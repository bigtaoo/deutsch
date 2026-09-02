// 对齐跑在 Web Worker 里。
//
// 这不是优化，是必需：一课 6 分钟音频在 WASM 后端要跑几分钟，
// 放主线程等于整个 PWA 冻住几分钟 —— 连进度条都刷不出来。
// WebGPU 后端快得多，但仍然是几十秒级，同样不能占着主线程。
//
// ── 两种入口 ──
// `input: 'audio'`     本机全程：算 emissions 再对齐。今天唯一走的那条。
// `input: 'emissions'` 矩阵已经在手上（原生插件算的、远端算的），只跑 viterbi。
// **viterbi 也必须在 Worker 里**：它比 emissions 便宜得多，但一课仍是几秒的同步循环，
// 放主线程就是几秒的白屏。所以这两种入口都在这里，而不是「远端就顺手在主线程算完」。

/// <reference lib="webworker" />

import { alignAudio, alignEmissions, type AlignOutcome, type AlignProgress } from './align';
import { disposeModel } from './emissions';
import type { EmissionMatrix } from './emissionMatrix';
import type { DevicePlan } from './config';
import type { Sentence } from '@/types/models';

interface AlignWorkerRequestBase {
  id: number;
  sentences: Sentence[];
  /**
   * 跑完就把模型放掉。手机上这一项是必须的：权重常驻 187MB 之后，
   * 用户接着做的第一件事就是播这一课的音频，那时再被系统盯上就是白丢一次对齐。
   * 桌面上留着，连续对齐几课不必重复加载。
   */
  release?: boolean;
}

/** 喂什么进来。这就是那道缝在 Worker 边界上的形状。 */
export type AlignWorkerInput =
  | {
      input: 'audio';
      /** 主线程解好的单声道 16kHz 波形。Web Audio 在 Worker 里不存在，所以解码只能在外面做。 */
      audio: Float32Array;
      /** 用哪套后端。主线程按黑匣子里的崩溃记录选（journal.ts），Worker 只是执行。 */
      plan: DevicePlan;
    }
  | { input: 'emissions'; emissions: EmissionMatrix };

export type AlignWorkerRequest = AlignWorkerRequestBase & AlignWorkerInput;

export type AlignWorkerResponse =
  | { id: number; type: 'progress'; progress: AlignProgress }
  | { id: number; type: 'done'; outcome: AlignOutcome }
  | { id: number; type: 'error'; message: string };

self.onmessage = async (event: MessageEvent<AlignWorkerRequest>) => {
  const request = event.data;
  const { id, sentences, release } = request;
  const post = (msg: AlignWorkerResponse) => self.postMessage(msg);
  const report = (progress: AlignProgress) => post({ id, type: 'progress', progress });
  try {
    const outcome =
      request.input === 'audio'
        ? await alignAudio(request.audio, sentences, request.plan, report)
        : alignEmissions(request.emissions, sentences, report);
    post({ id, type: 'done', outcome });
  } catch (err) {
    // Error 不能结构化克隆，只把消息送出去。
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (release) await disposeModel().catch(() => undefined);
  }
};
