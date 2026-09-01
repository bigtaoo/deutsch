// 对齐跑在 Web Worker 里。
//
// 这不是优化，是必需：一课 6 分钟音频在 WASM 后端要跑几分钟，
// 放主线程等于整个 PWA 冻住几分钟 —— 连进度条都刷不出来。
// WebGPU 后端快得多，但仍然是几十秒级，同样不能占着主线程。

/// <reference lib="webworker" />

import { alignAudio, type AlignOutcome, type AlignProgress } from './align';
import { disposeModel } from './emissions';
import type { DevicePlan } from './config';
import type { Sentence } from '@/types/models';

export interface AlignWorkerRequest {
  id: number;
  /** 主线程解好的单声道 16kHz 波形。Web Audio 在 Worker 里不存在，所以解码只能在外面做。 */
  audio: Float32Array;
  sentences: Sentence[];
  /** 用哪套后端。主线程按黑匣子里的崩溃记录选（journal.ts），Worker 只是执行。 */
  plan: DevicePlan;
  /**
   * 跑完就把模型放掉。手机上这一项是必须的：权重常驻 187MB 之后，
   * 用户接着做的第一件事就是播这一课的音频，那时再被系统盯上就是白丢一次对齐。
   * 桌面上留着，连续对齐几课不必重复加载。
   */
  release?: boolean;
}

export type AlignWorkerResponse =
  | { id: number; type: 'progress'; progress: AlignProgress }
  | { id: number; type: 'done'; outcome: AlignOutcome }
  | { id: number; type: 'error'; message: string };

self.onmessage = async (event: MessageEvent<AlignWorkerRequest>) => {
  const { id, audio, sentences, plan, release } = event.data;
  const post = (msg: AlignWorkerResponse) => self.postMessage(msg);
  try {
    const outcome = await alignAudio(audio, sentences, plan, (progress) =>
      post({ id, type: 'progress', progress }),
    );
    post({ id, type: 'done', outcome });
  } catch (err) {
    // Error 不能结构化克隆，只把消息送出去。
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (release) await disposeModel().catch(() => undefined);
  }
};
