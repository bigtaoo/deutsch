// FR-15 的编排层：音频 + 已切好的句子 → 句级/词级时间戳。
//
// 这一层不碰 IndexedDB、不碰 UI、也不知道自己在 Worker 里还是主线程 —— 只做计算。
// 落库和界面在 src/align/client.ts 与调用方。

import { computeEmissions, type EmissionsProgress } from './emissions';
import { MMS_FA, type AlignModelConfig, type DevicePlan } from './config';
import { buildTarget, toTimings, type Timings } from './target';
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
}

export interface AlignOutcome extends Timings {
  /** 解出来的真实音频时长，比 DW 页面上写的那个可靠 */
  duration: number;
  plan: DevicePlan;
  /** 整段对齐的平均 log-prob，可以当作「这一课整体靠不靠谱」 */
  score: number;
  /** 参与对齐的句子数（排除句与纯标点句不算） */
  covered: number;
}

/**
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
  const target = buildTarget(sentences);
  if (target.ids.length === 0) {
    throw new Error('没有可对齐的句子：要么全被标成了非朗读内容，要么正文里没有字母');
  }

  const emissions = await computeEmissions(audio, config, plan, (p: EmissionsProgress) =>
    onProgress?.({ stage: p.stage, fraction: p.fraction, loaded: p.loaded, total: p.total }),
  );

  onProgress?.({ stage: 'align', fraction: 0 });
  const { spans, score } = alignWindowed(
    emissions.logProbs,
    emissions.frames,
    emissions.vocabSize,
    target.ids,
    { onProgress: (fraction) => onProgress?.({ stage: 'align', fraction }) },
  );

  const timings = toTimings(target, spans);
  return {
    ...timings,
    duration: emissions.duration,
    plan: emissions.plan,
    score,
    covered: target.covered.length,
  };
}
