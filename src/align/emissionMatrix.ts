// 帧级 log-prob 矩阵 —— **对齐流水线的中间产物,也是它唯一的一道缝**。
//
// ── 为什么要有这道缝 ──
// FR-15 的两半性质完全不同,而且是正交的:
//
//   ① 音频 → 帧级 log-prob（emissions）
//      需要那份 300M 参数的声学模型 + GPU/多核。**全部的时间和内存都在这一半。**
//      而它压根不看文稿 —— CTC 前向只吃波形。
//   ② log-prob + token 序列 → 时间戳（viterbi/windowed）
//      纯 JS,只碰一个约 3MB 的矩阵。手机上几秒钟。**它不需要模型,也不需要 GPU。**
//
// 把 ① 的产物定成一个「可序列化、不带任何运行时依赖」的数据结构,直接的后果是
// ① 可以换地方跑而 ② 一行都不用改:
//   · 本机 ORT（`emissions.ts`,目前唯一实现)
//   · 原生插件（Capacitor + onnxruntime-objc/-android —— WebView 的 jetsam 线远低于
//     原生进程,而原生可以 mmap 那份 .onnx,峰值从「约 3 倍模型体积」掉到「约 1 倍」)
//   · 远端（只上行音频、下行这个矩阵。因为 ① 不看文稿,**德语正文一个字都不出设备** ——
//     SPEC §3.1 那一整套关于正文的约束因此完全不受影响,要认的只剩「音频经手」一条)
//
// 所以这个文件里**不许出现任何 import 自 @huggingface/transformers 的东西**。
// 它连着 onnxruntime-web 一共 500KB+,而主线程、单测、以及将来的远端编解码器
// 都只需要这里的类型。真正需要 ORT 的那一半在 emissions.ts。
//
// ── 序列化 ──
// `logProbs` 是 Float32Array,天生 structured-clone 可传、可 transfer（零拷贝进 Worker）。
// 8 分钟一课是 24275 × 31 个 float32 ≈ 2.9MB —— 比音频本身小一个量级,
// 所以「先全部算完再对齐」是划算的,不需要流式。
// 上到线缆时还可以压（float16 减半、gzip 再减半),但那是 provider 自己的事:
// 这里定的是**内存里的形状**,编解码器等真的有远端 provider 时再写。

import type { AlignModelConfig, DevicePlan, NativePlan } from './config';

/** 这个矩阵是谁算出来的。只给诊断和黑匣子看 —— 对齐算法不读它。 */
export type EmissionSource =
  /** 本机 ORT（WASM/WebGPU),权重在设备上。目前唯一实现,见 emissions.ts */
  | { kind: 'local'; plan: DevicePlan }
  /** 原生插件算的（Capacitor + onnxruntime，见 native-plugins/align-native) */
  | { kind: 'native'; plan: NativePlan }
  /** 远端算的。只记 origin,不记路径与参数 */
  | { kind: 'remote'; origin: string };

export interface EmissionMatrix {
  /**
   * 帧优先的扁平数组,长度 `frames * vocabSize`,**已做过 log-softmax**。
   * 帧 t 的第 v 个 log-prob 在 `logProbs[t * vocabSize + v]`。
   */
  logProbs: Float32Array;
  frames: number;
  /** = 模型 logits 的最后一维。与 AlignModelConfig.vocabSize 一致,加载后断言过 */
  vocabSize: number;
  /** 音频总时长（秒)。比 DW 页面上写的可靠,会写回 Lesson.audioDuration */
  duration: number;
  source: EmissionSource;
}

export interface EmissionsProgress {
  /**
   * `decode` 只有**自己解码的 provider** 会报（原生那条：mp3 过桥、AVAudioFile 在
   * 原生侧解）。本机 provider 收到的已经是波形,它从 `model` 开始。
   */
  stage: 'decode' | 'model' | 'infer';
  /** 0..1,仅 infer 阶段有意义 */
  fraction?: number;
  /** model 阶段:已下载字节 / 总字节 */
  loaded?: number;
  total?: number;
  /**
   * infer 阶段:已算完第几块 / 一共几块。
   *
   * 有了 `fraction` 还要这两个数,是 2026-09-03 iPhone 那次「开始之后好几分钟
   * 一动不动」逼出来的:比例是个**没有单位**的量,4% 既可能是「正在正常爬」
   * 也可能是「卡在这里了」。块数有单位 —— 分母一出来就能算出「一块大约多久」,
   * 于是界面能说「还要 11 分钟」,而不是让人盯着一个不动的百分数猜。
   */
  chunk?: number;
  chunks?: number;
}

/**
 * ① 那一半的契约。换地方跑就是换一个这个。
 *
 * @param audio 单声道、`config.sampleRate` 采样率的波形（主线程 decodeToMono16k 产出)
 * @param plan 本机/原生 provider 用哪套后端。**由主线程决定**（client.ts) ——
 *   崩溃降档要靠 localStorage 里的黑匣子,而 Worker 里没有 localStorage。
 *   远端 provider 忽略它。
 */
export type EmissionsProvider = (
  audio: Float32Array,
  config: AlignModelConfig,
  plan: DevicePlan,
  onProgress?: (p: EmissionsProgress) => void,
) => Promise<EmissionMatrix>;

/**
 * postMessage 的 transfer 列表。矩阵有 3MB,拷一份没必要;
 * 交出去之后调用方不要再读 `logProbs`。
 */
export function emissionTransferables(matrix: EmissionMatrix): Transferable[] {
  return [matrix.logProbs.buffer as ArrayBuffer];
}
