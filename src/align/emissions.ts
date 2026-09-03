// 波形 → 帧级 log-prob 的**本机实现**：`EmissionsProvider` 的第一个（目前唯一一个）实现，
// 跑在浏览器运行时（WASM/WebGPU）上。产物的形状与那道缝的契约在 emissionMatrix.ts ——
// 换地方算（原生插件、远端）就是换一个 provider，下游一行都不用改。
//
// 这是唯一需要浏览器运行时的一层，因此单测只覆盖里面的纯函数
// （logSoftmaxInPlace / planChunks），模型本身靠手动跑真实素材验。
//
// ── 解码为什么不在这里 ──
// **Web Audio API 在 Worker 里不存在**：AudioContext / OfflineAudioContext 只在主线程暴露。
// 而对齐必须在 Worker 里跑（否则 PWA 冻住几分钟）。所以分工是：
// 主线程 decodeToMono16k() 解出波形 → 把 ArrayBuffer transfer 进 Worker（零拷贝）
// → Worker 里 computeEmissions() 只处理 Float32Array。
//
// ── 为什么必须分块 ──
// wav2vec2 的自注意力是 O(n²)。6 分 16 秒 = 18800 帧，一把喂进去注意力矩阵是 3.5 亿项，
// 手机上必崩，桌面上也没必要。所以切成 20 秒一块。
//
// ── 为什么块之间要重叠 ──
// 块边界的那几帧缺少上下文（卷积特征提取器的感受野被截断，注意力也看不到块外），
// 后验会明显变差。做法是块间重叠 2 秒，但**每块只采用中间那段**，
// 两侧各丢掉一半重叠。这样每一帧的后验都来自「有完整上下文」的位置。
// 不这么做的话，每 20 秒就会出现一处系统性的边界误差，而句子边界恰好是密集出现的地方。
//
// 拼接后的 log-prob 只有 18800 × 31 个 float32 ≈ 2.3MB，比音频本身小得多，
// 所以「先全部算完再对齐」是划算的，不需要流式。

import { AutoModelForCTC, AutoProcessor, Tensor } from '@huggingface/transformers';
import type { AlignModelConfig, DevicePlan } from './config';
import type { EmissionMatrix, EmissionsProgress, EmissionsProvider } from './emissionMatrix';
import { configureRuntime } from './runtime';

export interface Chunk {
  /** 该块在整段音频里的起始采样点 */
  sampleStart: number;
  sampleEnd: number;
  /** 采用区间（全局帧号，右开）——两侧重叠的一半被丢掉 */
  keepFrameStart: number;
  keepFrameEnd: number;
}

/**
 * 切块计划。纯函数，可单测。
 *
 * 全局帧号一律定义为 floor(sample / frameStride)。这和模型内部卷积的实际对齐
 * 差不到一帧（20ms），而换来的是「块与块之间帧号绝不错位」——
 * 如果按每块实际输出的帧数去累加，卷积的边界效应会让误差逐块累积。
 */
export function planChunks(
  totalSamples: number,
  sampleRate: number,
  frameStride: number,
  chunkSeconds = 20,
  overlapSeconds = 2,
): Chunk[] {
  const chunkSamples = Math.round(chunkSeconds * sampleRate);
  const overlapSamples = Math.round(overlapSeconds * sampleRate);
  const strideSamples = chunkSamples - overlapSamples;
  const totalFrames = Math.floor(totalSamples / frameStride);
  if (totalSamples <= chunkSamples) {
    return [{ sampleStart: 0, sampleEnd: totalSamples, keepFrameStart: 0, keepFrameEnd: totalFrames }];
  }

  const chunks: Chunk[] = [];
  for (let start = 0; start < totalSamples; start += strideSamples) {
    const sampleEnd = Math.min(totalSamples, start + chunkSamples);
    const isFirst = start === 0;
    const isLast = sampleEnd >= totalSamples;
    const trim = Math.floor(overlapSamples / 2);
    const keepStart = isFirst ? 0 : start + trim;
    const keepEnd = isLast ? totalSamples : sampleEnd - trim;
    chunks.push({
      sampleStart: start,
      sampleEnd,
      keepFrameStart: Math.floor(keepStart / frameStride),
      keepFrameEnd: Math.min(totalFrames, Math.floor(keepEnd / frameStride)),
    });
    if (isLast) break;
  }
  return chunks;
}

/**
 * 就地把 logits 变成 log-softmax。
 * 全程在 log 域：先减去每帧最大值再取 exp，避免 exp 溢出。
 */
export function logSoftmaxInPlace(data: Float32Array, frames: number, vocabSize: number): void {
  for (let t = 0; t < frames; t++) {
    const base = t * vocabSize;
    let max = -Infinity;
    for (let v = 0; v < vocabSize; v++) if (data[base + v] > max) max = data[base + v];
    let sum = 0;
    for (let v = 0; v < vocabSize; v++) sum += Math.exp(data[base + v] - max);
    const logSum = max + Math.log(sum);
    for (let v = 0; v < vocabSize; v++) data[base + v] -= logSum;
  }
}

type CtcModel = {
  (inputs: Record<string, Tensor>): Promise<{ logits: { data: Float32Array; dims: number[] } }>;
  dispose?: () => Promise<void>;
};

/** 加载好的模型缓存在模块级：一次会话里连续对齐多课不该重复加载 200MB。 */
let cached: { key: string; model: CtcModel; processor: unknown } | null = null;

async function loadModel(config: AlignModelConfig, plan: DevicePlan, onProgress?: (p: EmissionsProgress) => void) {
  const key = `${config.modelId}|${plan.device}|${plan.dtype}`;
  if (cached?.key === key) return cached;
  await configureRuntime(config);
  const progress_callback = (p: { status?: string; loaded?: number; total?: number }) => {
    if (p.status === 'progress') onProgress?.({ stage: 'model', loaded: p.loaded, total: p.total });
  };
  const [model, processor] = await Promise.all([
    AutoModelForCTC.from_pretrained(config.modelId, {
      device: plan.device,
      dtype: plan.dtype,
      progress_callback,
    }),
    AutoProcessor.from_pretrained(config.modelId, { progress_callback }),
  ]);
  cached = { key, model: model as unknown as CtcModel, processor };
  return cached;
}

/** 换模型或彻底释放显存时用。 */
export async function disposeModel(): Promise<void> {
  await cached?.model.dispose?.();
  cached = null;
}

/**
 * 本机 provider。参数与返回值的含义见 emissionMatrix.ts 的 `EmissionsProvider`。
 *
 * 显式标注成 `EmissionsProvider` 而不是让它自己长出签名：这样签名一旦漂移，
 * 编译期就红 —— 而不是等到接第二个 provider 时才发现两边对不上。
 */
export const computeEmissions: EmissionsProvider = async (
  audio: Float32Array,
  config: AlignModelConfig,
  plan: DevicePlan,
  onProgress?: (p: EmissionsProgress) => void,
): Promise<EmissionMatrix> => {
  onProgress?.({ stage: 'model' });
  const { model, processor } = await loadModel(config, plan, onProgress);

  const totalFrames = Math.floor(audio.length / config.frameStride);
  const logProbs = new Float32Array(totalFrames * config.vocabSize);
  // 没被任何块覆盖到的帧（理论上不该有）保持全 0 会被 Viterbi 当成 log(1)=确定，
  // 那是最坏的默认值。填一个均匀分布的 log 值，让它变成「完全不确定」。
  logProbs.fill(Math.log(1 / config.vocabSize));

  const chunks = planChunks(audio.length, config.sampleRate, config.frameStride);
  const prepare = processor as (a: Float32Array) => Promise<Record<string, Tensor>>;

  // 第一块算完之前先把**分母**报出去。手机上一块要几十秒，界面在那之前
  // 只能显示上一个阶段 —— 而「模型加载完了没有」正是那几分钟里唯一想知道的事。
  onProgress?.({ stage: 'infer', fraction: 0, chunk: 0, chunks: chunks.length });

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const slice = audio.subarray(chunk.sampleStart, chunk.sampleEnd);
    const inputs = await prepare(slice);
    const { logits } = await model(inputs);
    const [, chunkFrames, vocabSize] = logits.dims;
    if (vocabSize !== config.vocabSize) {
      throw new Error(`模型词表大小是 ${vocabSize}，配置写的是 ${config.vocabSize}`);
    }
    const local = logits.data as Float32Array;
    logSoftmaxInPlace(local, chunkFrames, vocabSize);

    // 把采用区间搬到全局缓冲。全局帧 g 对应块内帧 g - floor(sampleStart/stride)。
    const chunkFrameBase = Math.floor(chunk.sampleStart / config.frameStride);
    for (let g = chunk.keepFrameStart; g < chunk.keepFrameEnd; g++) {
      const localFrame = g - chunkFrameBase;
      if (localFrame < 0 || localFrame >= chunkFrames) continue;
      logProbs.set(
        local.subarray(localFrame * vocabSize, (localFrame + 1) * vocabSize),
        g * vocabSize,
      );
    }
    onProgress?.({
      stage: 'infer',
      fraction: (i + 1) / chunks.length,
      chunk: i + 1,
      chunks: chunks.length,
    });
  }

  return {
    logProbs,
    frames: totalFrames,
    vocabSize: config.vocabSize,
    duration: audio.length / config.sampleRate,
    source: { kind: 'local', plan },
  };
};
