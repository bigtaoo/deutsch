// 音频字节 → 帧级 log-prob 矩阵。`src/align/emissions.ts` 的服务端对应物。
//
// 与浏览器那一份的唯一差别是「谁解码、谁归一化」：
// 浏览器里 Web Audio 解码、transformers.js 的 processor 归一化；这里 ffmpeg 解码、
// frames.ts 归一化。**分块、帧号、log-softmax、未覆盖帧的填充值必须逐字相同** ——
// 那四件事决定时间戳，见 frames.ts 顶部那段。

import { logSoftmaxInPlace, normalizeChunk, planChunks } from './frames.ts';
import { decodeToMono, extensionOf, DecodeError } from './decode.ts';
import { createSession, type CtcSession, type ModelOptions } from './model.ts';

export { DecodeError, extensionOf };

/** 与 src/align/config.ts 的 GERMAN_CTC 一致。服务器不猜这些数，它就是模型的事实。 */
export const MODEL_SHAPE = {
  // 35 = vocab.json 的 33 条 + added_tokens.json 的 `<s>`/`</s>`。
  // blank（32）与词分隔符（0）只有客户端的 Viterbi 用得着，这里不需要知道。
  vocabSize: 35,
  sampleRate: 16000,
  frameStride: 320,
  chunkSeconds: 20,
  overlapSeconds: 2,
} as const;

export interface EmissionsResult {
  logProbs: Float32Array;
  frames: number;
  vocabSize: number;
  /** 音频总时长（秒）。解码出来的这个数比 DW 页面上写的可靠，客户端会写回 Lesson。 */
  duration: number;
}

export interface EngineProgress {
  stage: 'decode' | 'model' | 'infer';
  chunk?: number;
  chunks?: number;
}

export interface EngineOptions extends ModelOptions {
  maxSeconds: number;
  ffmpegPath?: string;
  /**
   * 闲置这么久之后把会话放掉（毫秒，0 = 永不放）。
   *
   * fp32 的会话是 1.3GB 常驻，而这台机器上还跑着公司的东西，用这个功能一周一两次。
   * 代价是下一次要重新加载十几秒 —— 而那一次本来也要跑好几分钟。
   */
  idleMs: number;
}

export interface Engine {
  compute(
    audio: Uint8Array,
    extension: string,
    onProgress: (p: EngineProgress) => void,
    isCancelled: () => boolean,
  ): Promise<EmissionsResult>;
  /** healthz 用：权重与 ORT 就位了吗。**不会**触发下载。 */
  status(): 'idle' | 'ready' | 'error';
  statusMessage(): string | undefined;
}

export class Cancelled extends Error {
  constructor() {
    super('已取消');
  }
}

export function createEngine(options: EngineOptions): Engine {
  // 会话缓存在闭包里：加载 1.2GB 要十几秒，连着对两课没有理由重来一遍。
  let session: Promise<CtcSession> | null = null;
  let state: 'idle' | 'ready' | 'error' = 'idle';
  let message: string | undefined;
  /** 正在跑的块数。闲置计时器只在它归零之后才真的放掉会话。 */
  let busy = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const releaseSoon = () => {
    if (options.idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (busy > 0) {
        // 还在跑（一课能跑好几分钟）—— 等这一轮完了再重新计时。
        releaseSoon();
        return;
      }
      const pending = session;
      session = null;
      state = 'idle';
      void pending?.then((s) => s.release()).catch(() => undefined);
    }, options.idleMs);
    // 这个计时器不该拖着进程不退出。
    idleTimer.unref?.();
  };

  const ensureSession = (): Promise<CtcSession> => {
    session ??= createSession(options).then(
      (s) => {
        state = 'ready';
        return s;
      },
      (err: unknown) => {
        state = 'error';
        message = err instanceof Error ? err.message : String(err);
        // 失败不缓存：下一次请求重试一遍（多半是网络断在下权重那一步）。
        session = null;
        throw err;
      },
    );
    return session;
  };

  return {
    status: () => state,
    statusMessage: () => message,

    async compute(audio, extension, onProgress, isCancelled) {
      onProgress({ stage: 'decode' });
      const samples = await decodeToMono(audio, extension, {
        sampleRate: MODEL_SHAPE.sampleRate,
        maxSeconds: options.maxSeconds,
        ffmpegPath: options.ffmpegPath,
      });
      if (isCancelled()) throw new Cancelled();

      onProgress({ stage: 'model' });
      busy++;
      try {
        return await computeWith(await ensureSession(), samples, onProgress, isCancelled);
      } finally {
        busy--;
        releaseSoon();
      }
    },
  };
}

/**
 * 真正的推理循环。从 compute 里抽出来只是为了让「加载会话 / 释放会话」那圈
 * try-finally 看得清 —— 逻辑一行没变。
 */
async function computeWith(
  ctc: CtcSession,
  samples: Float32Array,
  onProgress: (p: EngineProgress) => void,
  isCancelled: () => boolean,
): Promise<EmissionsResult> {
  if (isCancelled()) throw new Cancelled();

  const totalFrames = Math.floor(samples.length / MODEL_SHAPE.frameStride);
  const logProbs = new Float32Array(totalFrames * MODEL_SHAPE.vocabSize);
  // 没被任何块覆盖到的帧（理论上不该有）保持全 0 会被 Viterbi 当成 log(1) = 确定，
  // 那是最坏的默认值。填均匀分布的 log 值 = 「完全不确定」。
  logProbs.fill(Math.log(1 / MODEL_SHAPE.vocabSize));

  const chunks = planChunks(
    samples.length,
    MODEL_SHAPE.sampleRate,
    MODEL_SHAPE.frameStride,
    MODEL_SHAPE.chunkSeconds,
    MODEL_SHAPE.overlapSeconds,
  );
  onProgress({ stage: 'infer', chunk: 0, chunks: chunks.length });

  for (let i = 0; i < chunks.length; i++) {
    // 取消只在块边界生效 —— ORT 的 run() 不可打断，这一点两条路都一样。
    if (isCancelled()) throw new Cancelled();
    const chunk = chunks[i];
    const slice = samples.subarray(chunk.sampleStart, chunk.sampleEnd);
    const { logits, frames, vocabSize } = await ctc.run(normalizeChunk(slice));
    if (vocabSize !== MODEL_SHAPE.vocabSize) {
      throw new Error(`模型词表大小是 ${vocabSize}，配置写的是 ${MODEL_SHAPE.vocabSize}`);
    }
    logSoftmaxInPlace(logits, frames, vocabSize);

    // 全局帧 g 对应块内帧 g - floor(sampleStart / stride)。
    const chunkFrameBase = Math.floor(chunk.sampleStart / MODEL_SHAPE.frameStride);
    for (let g = chunk.keepFrameStart; g < chunk.keepFrameEnd; g++) {
      const localFrame = g - chunkFrameBase;
      if (localFrame < 0 || localFrame >= frames) continue;
      logProbs.set(
        logits.subarray(localFrame * vocabSize, (localFrame + 1) * vocabSize),
        g * vocabSize,
      );
    }
    onProgress({ stage: 'infer', chunk: i + 1, chunks: chunks.length });
  }

  return {
    logProbs,
    frames: totalFrames,
    vocabSize: MODEL_SHAPE.vocabSize,
    duration: samples.length / MODEL_SHAPE.sampleRate,
  };
}
