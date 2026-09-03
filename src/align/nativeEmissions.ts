// 帧级 log-prob 的**原生实现**：那道缝（emissionMatrix.ts）的第二个 provider。
// 只在 iOS 原生壳里存在，插件源码在 `native-plugins/align-native/`。
//
// ── 为什么必须有这一条 ──
// iPhone 13 上 WebView 里的两档后端**都被系统杀掉**（SPEC §7.10、变更 21）：
// `q4f16` 已经是这个模型最小的变体，所以降档救不了。原因不是设备内存不够，
// 而是 WKWebView 的 WebContent 进程 jetsam 线远低于原生进程，且 ORT-web 至少要
// 「JS 堆一份 + wasm 堆一份」。挪进原生进程之后这两条都不成立了。
//
// ── 边界上传的是 mp3，不是波形 ──
// 反直觉的一点：解码**也**交给原生做，尽管 WebView 里的 `decodeToMono16k()`
// 在 iOS 上是好的。理由是桥上的字节数：
//   · 8 分钟波形 = 16000 × 480 × 4B ≈ 30MB，base64 之后 41MB
//   · 同一课的 mp3 ≈ 7MB，base64 之后 9MB
// 而 Capacitor 的桥只能过 JSON（二进制一律 base64），那 41MB 会在 WebView 里
// 同时存在「Float32Array + base64 字符串」两份 —— 正是我们要躲开的那种峰值。
// 所以 JS 侧连解码都不做，`AVAudioFile` 在原生侧解，顺带把 Web Audio 那份
// 解码缓冲也省了。
//
// 回程是 3MB 的矩阵（base64 后 4MB），这个量级无所谓。

import { MMS_FA, NATIVE_PLAN, type AlignModelConfig } from './config';
import type { EmissionMatrix, EmissionsProgress } from './emissionMatrix';
import { nativePlatform } from '@/platform/native';

/** 插件返回的形状。`logProbs` 是 float32 小端字节的 base64。 */
interface NativeEmissionsResult {
  logProbs: string;
  frames: number;
  vocabSize: number;
  duration: number;
}

interface AlignNativePlugin {
  computeEmissions(options: {
    /** 音频文件原始字节的 base64（mp3/m4a —— 交给 AVFoundation 认） */
    audio: string;
    /** 临时文件的扩展名。ExtAudioFile 先看扩展名再嗅探内容，给错只会得到「格式不支持」 */
    extension: string;
    /** 权重在 app bundle 里的相对路径，从 `public/` 算起 */
    modelPath: string;
    /** 断言用：模型 logits 的最后一维 */
    vocabSize: number;
    sampleRate: number;
    frameStride: number;
    chunkSeconds: number;
    overlapSeconds: number;
    /**
     * 断点续算的键（用 lesson id）。原生侧按它在 Caches 里存「已经算完的块」，
     * 下一次同一个键 + 同一份音频就从那儿接着算。见插件里的 Checkpoint.swift。
     */
    checkpointKey?: string;
  }): Promise<NativeEmissionsResult>;
  /** 在下一个块边界停下。已经算完的块留在断点里 —— 这才是手机上「停止」敢做的事。 */
  cancelEmissions(): Promise<void>;
  addListener(
    event: 'emissionsProgress',
    handler: (data: NativeProgressEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/**
 * 插件报进度的形状。**每个阶段都报一次，哪怕那个阶段给不出比例** ——
 * 见下面 `computeNativeEmissions` 里那段关于「静默窗口」的注释。
 *
 * 每一项都是可选的：这条事件的解析必须能容忍旧壳。应用壳会自己更新（变更 30），
 * 但更新是异步的，中间必然存在「新 JS + 旧壳」的一小段时间，那时只有 `fraction`。
 */
interface NativeProgressEvent {
  phase?: 'decode' | 'model' | 'infer';
  fraction?: number;
  chunk?: number;
  chunks?: number;
}

/**
 * 插件在不在。缓存结果 —— 这个判断出现在自动对齐的闸门上（useAlignStore.blocked），
 * 每次渲染都问一遍原生桥没有必要。
 *
 * 判据是「平台是 iOS **且** 桥上真的注册了这个插件」，不是只看平台：
 * 少了后半截，装着旧壳（没这个插件）的机器上会把 `blocked` 判成 false，
 * 于是自动对齐重新开始每次导入都把应用杀一次 —— 那正是 §7.10 那条黄条终结的循环。
 */
let availability: Promise<boolean> | null = null;

export function nativeEmissionsAvailable(): Promise<boolean> {
  availability ??= (async () => {
    if ((await nativePlatform()) !== 'ios') return false;
    try {
      const { Capacitor } = await import('@capacitor/core');
      return Capacitor.isPluginAvailable('AlignNative');
    } catch {
      return false;
    }
  })();
  return availability;
}

async function plugin(): Promise<AlignNativePlugin> {
  const { registerPlugin } = await import('@capacitor/core');
  return registerPlugin<AlignNativePlugin>('AlignNative');
}

/**
 * MIME → 扩展名。原生侧要把字节落成临时文件才能交给 `AVAudioFile`，
 * 而 ExtAudioFile 先看扩展名再嗅探内容 —— 名字给错会得到一句没有信息量的
 * 「格式不支持」。认不出来时退到 mp3：DW 的音频一律是 mp3，手动导入的才可能是别的。
 */
function extensionOf(blob: Blob): string {
  const type = blob.type.split(';')[0].trim().toLowerCase();
  return (
    {
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/mp4': 'm4a',
      'audio/x-m4a': 'm4a',
      'audio/aac': 'aac',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/wave': 'wav',
      'audio/flac': 'flac',
      'audio/aiff': 'aiff',
    }[type] ?? 'mp3'
  );
}

/** Blob → base64（不带 data: 前缀）。走 FileReader 而不是手写循环：7MB 手写要几百毫秒。 */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('读音频失败'));
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      resolve(comma === -1 ? '' : url.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * base64 → Float32Array。
 *
 * 一定要先落进一个**自己独占的** Uint8Array 再取它的 buffer：
 * `new Float32Array(buffer)` 要求 4 字节对齐，而从别处借来的 buffer 不保证。
 */
function decodeFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, bytes.length >> 2);
}

/**
 * 停掉正在跑的那一课。**不清断点** —— 下一次点「接着算」从上次那一块继续。
 *
 * 只在块边界生效（一块几十秒），所以按下去之后不会立刻停。旧壳上没有这个方法，
 * 桥会回一个 rejection，这里咽掉：取消失败不该在界面上变成一条错误。
 */
export async function cancelNativeEmissions(): Promise<void> {
  try {
    await (await plugin()).cancelEmissions();
  } catch {
    // 旧壳（0.2.1）没有 cancelEmissions。那台机器上「停止」照旧是不生效的。
  }
}

/**
 * 插件的事件 → 那道缝的进度形状。
 *
 * 没有 `phase` 的事件当成 infer：那是旧壳（0.2.1）的形状，它只报比例。
 */
function toProgress(event: NativeProgressEvent): EmissionsProgress {
  if (event.phase === 'decode') return { stage: 'decode' };
  if (event.phase === 'model') return { stage: 'model' };
  return {
    stage: 'infer',
    fraction: event.fraction ?? 0,
    chunk: event.chunk,
    chunks: event.chunks,
  };
}

/**
 * 原生 provider。签名跟 `EmissionsProvider` 差在第一个参数（Blob 而不是波形）——
 * 那道缝的契约管的是**产物**，不是入口；解码在哪一侧做是这两个实现各自的自由。
 */
export async function computeNativeEmissions(
  audio: Blob,
  config: AlignModelConfig = MMS_FA,
  onProgress?: (p: EmissionsProgress) => void,
  /** 断点续算的键。给 lesson id；不给就每次从头算 */
  checkpointKey?: string,
): Promise<EmissionMatrix> {
  const api = await plugin();
  // ── 这一段为什么这么啰嗦 ──
  // 2026-09-03 真机（iPhone 13、iOS 0.2.1，第一个带这个插件的包）上的症状是
  // 「自动对齐一开始就卡住，好几分钟没有进展」。真正的问题不是慢，是**静默**：
  // 这条路上原来只有一种事件（每块算完报一个比例），而在它之前排着三件在手机上
  // 都要几十秒到几分钟的事 ——
  //   ① 7MB mp3 → 9MB base64 → 过 WKWebView 的消息桥
  //   ② 原生侧 AVAudioFile 解码
  //   ③ ORTSession 加载 230MB 的 q4 权重（读文件 + 解 protobuf + 预打包）
  // 加上第一块推理本身（20 秒音频，iPhone CPU 上几十秒），第一个事件要到
  // 开始后好几分钟才可能出现。那几分钟里进度条停在「加载对齐模型 …」5%，
  // 与「进程卡死」在界面上**完全无法区分** —— 而这个功能真实的历史故障
  // （2026-09-01，进程被 jetsam 杀掉）恰好就长这样。所以现在每一步都要出声。
  onProgress?.({ stage: 'decode' });

  const listener = await api
    .addListener('emissionsProgress', (event) => onProgress?.(toProgress(event)))
    .catch(() => null);

  try {
    const result = await api.computeEmissions({
      audio: await toBase64(audio),
      extension: extensionOf(audio),
      // 原生侧从 `Bundle.main` 里的 `public/` 算起找权重 —— 那正是 cap sync
      // 把 dist（含 public/models）刷进去的位置。
      modelPath: `models/${config.modelId}/onnx/model_${NATIVE_PLAN.dtype}.onnx`,
      vocabSize: config.vocabSize,
      sampleRate: config.sampleRate,
      frameStride: config.frameStride,
      // 与 emissions.ts 的 planChunks 默认值必须一致：两个 provider 出来的矩阵
      // 要能互换，而块边界策略会改变边界那几帧的后验。
      chunkSeconds: 20,
      overlapSeconds: 2,
      checkpointKey,
    });

    if (result.vocabSize !== config.vocabSize) {
      throw new Error(`模型词表大小是 ${result.vocabSize}，配置写的是 ${config.vocabSize}`);
    }
    const logProbs = decodeFloat32(result.logProbs);
    if (logProbs.length !== result.frames * result.vocabSize) {
      throw new Error(`原生返回的矩阵大小不对：${logProbs.length} ≠ ${result.frames} × ${result.vocabSize}`);
    }

    return {
      logProbs,
      frames: result.frames,
      vocabSize: result.vocabSize,
      duration: result.duration,
      source: { kind: 'native', plan: NATIVE_PLAN },
    };
  } finally {
    await listener?.remove().catch(() => undefined);
  }
}
