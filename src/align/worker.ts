// 对齐跑在 Web Worker 里。
//
// 这不是优化，是必需：一课 6 分钟音频在 WASM 后端要跑几分钟，
// 放主线程等于整个 PWA 冻住几分钟 —— 连进度条都刷不出来。
// WebGPU 后端快得多，但仍然是几十秒级，同样不能占着主线程。

/// <reference lib="webworker" />

import { alignAudio, type AlignOutcome, type AlignProgress } from './align';
import type { Sentence } from '@/types/models';

export interface AlignWorkerRequest {
  id: number;
  /** 主线程解好的单声道 16kHz 波形。Web Audio 在 Worker 里不存在，所以解码只能在外面做。 */
  audio: Float32Array;
  sentences: Sentence[];
}

export type AlignWorkerResponse =
  | { id: number; type: 'progress'; progress: AlignProgress }
  | { id: number; type: 'done'; outcome: AlignOutcome }
  | { id: number; type: 'error'; message: string };

self.onmessage = async (event: MessageEvent<AlignWorkerRequest>) => {
  const { id, audio, sentences } = event.data;
  const post = (msg: AlignWorkerResponse) => self.postMessage(msg);
  try {
    const outcome = await alignAudio(audio, sentences, (progress) =>
      post({ id, type: 'progress', progress }),
    );
    post({ id, type: 'done', outcome });
  } catch (err) {
    // Error 不能结构化克隆，只把消息送出去。
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
