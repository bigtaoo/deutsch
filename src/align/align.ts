// FR-15 的编排层：音频 + 已切好的句子 → 句级/词级时间戳。
//
// 这一层不碰 IndexedDB、不碰 UI、也不知道自己在 Worker 里还是主线程 —— 只做计算。
// 落库和界面在 src/align/client.ts 与调用方。
//
// ── 两个入口，一道缝 ──
// `alignAudio()`  = 本机全程：算 emissions（要 300M 权重 + GPU）再对齐。
// `alignEmissions()` = 只做后半段：矩阵已经有了（原生插件算的、远端算的），只跑 viterbi。
// 后者不 import emissions.ts，因此也不连着 transformers.js —— 这道缝的意义见 emissionMatrix.ts。

import { computeEmissions } from './emissions';
import { MMS_FA, type AlignModelConfig, type DevicePlan } from './config';
import type { EmissionMatrix, EmissionSource, EmissionsProgress } from './emissionMatrix';
import { buildTarget, toTimings, type AlignTarget, type Timings } from './target';
import { alignWindowed } from './windowed';
import type { Sentence } from '@/types/models';

export interface AlignProgress {
  /**
   * decode 与 apply 由主线程（client.ts）发，model/infer/align 由 Worker 发。
   * 放在同一个联合里是因为界面只关心「现在在哪一步」，不关心它是谁发的。
   */
  stage: 'decode' | 'model' | 'infer' | 'align' | 'apply';
  /** 0..1 */
  fraction?: number;
  /** model 阶段的下载进度 */
  loaded?: number;
  total?: number;
  /** infer 阶段：已算完第几块 / 一共几块。理由见 EmissionsProgress 上那段 */
  chunk?: number;
  chunks?: number;
}

export interface AlignOutcome extends Timings {
  /** 解出来的真实音频时长，比 DW 页面上写的那个可靠 */
  duration: number;
  /** 帧级 log-prob 是谁算出来的（本机哪套后端 / 原生 / 远端）。只给诊断看 */
  source: EmissionSource;
  /** 整段对齐的平均 log-prob，可以当作「这一课整体靠不靠谱」 */
  score: number;
  /** 参与对齐的句子数（排除句与纯标点句不算） */
  covered: number;
}

/**
 * 摊平成对齐目标，顺便挡掉「没有可对齐的句子」。
 *
 * **必须在算 emissions 之前调**：否则一整课全被标成排除时，
 * 会先白加载 187MB 权重再发现无事可做。
 */
export function assertAlignable(sentences: Sentence[]): AlignTarget {
  const target = buildTarget(sentences);
  if (target.ids.length === 0) {
    throw new Error('没有可对齐的句子：要么全被标成了非朗读内容，要么正文里没有字母');
  }
  return target;
}

/** 后半段：矩阵 + 目标 → 时间戳。纯 JS，不需要模型也不需要 GPU。 */
function alignTarget(
  target: AlignTarget,
  emissions: EmissionMatrix,
  onProgress?: (p: AlignProgress) => void,
): AlignOutcome {
  onProgress?.({ stage: 'align', fraction: 0 });
  const { spans, score } = alignWindowed(
    emissions.logProbs,
    emissions.frames,
    emissions.vocabSize,
    target.ids,
    { onProgress: (fraction) => onProgress?.({ stage: 'align', fraction }) },
  );

  return {
    ...toTimings(target, spans),
    duration: emissions.duration,
    source: emissions.source,
    score,
    covered: target.covered.length,
  };
}

/**
 * 只做后半段。矩阵从别处来时用这个。
 *
 * @param emissions 帧级 log-prob。它的 vocabSize 必须与算它的那个模型一致 ——
 *   这里不再校验，因为 provider 那边已经断言过（emissions.ts 里那句「模型词表大小是…」）。
 */
export function alignEmissions(
  emissions: EmissionMatrix,
  sentences: Sentence[],
  onProgress?: (p: AlignProgress) => void,
): AlignOutcome {
  return alignTarget(assertAlignable(sentences), emissions, onProgress);
}

/**
 * 本机全程。
 *
 * @param audio 主线程 decodeToMono16k() 解出的单声道 16kHz 波形
 * @param plan 用哪套后端（主线程按黑匣子里的崩溃记录选，见 journal.ts）
 */
export async function alignAudio(
  audio: Float32Array,
  sentences: Sentence[],
  plan: DevicePlan,
  onProgress?: (p: AlignProgress) => void,
  config: AlignModelConfig = MMS_FA,
): Promise<AlignOutcome> {
  const target = assertAlignable(sentences);

  const emissions = await computeEmissions(audio, config, plan, (p: EmissionsProgress) =>
    onProgress?.({ stage: p.stage, fraction: p.fraction, loaded: p.loaded, total: p.total }),
  );

  return alignTarget(target, emissions, onProgress);
}
