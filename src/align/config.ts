// 对齐模型的**纯配置**。
//
// ── 为什么模型是可插拔的 ──
// 默认用 MMS-FA（facebook/mms-300m-1130-forced-aligner），它是**CC-BY-NC-4.0**。
// 自己精听没问题，但这个项目的 §3.1 本来就是一整节法律约束，
// 把「换一个宽松许可的德语 CTC 模型」做成改配置而不是重写代码，是这里唯一负责任的形状。
// 换模型要动的是：modelId、vocab、以及 romanize 是否还需要（德语专用模型自带 ä/ö/ü/ß，
// 那时罗马化应该退化成恒等映射）。对齐算法（viterbi/windowed/target）一行都不用改。
//
// ── §3.1.1 R-1 与模型权重 ──
// R-1 管的是**学习内容**的通路：请求只能从用户设备发出，不许有我们运营的中转代抓。
// 模型权重不是学习内容，音频也从不离开设备（对齐全程在本机跑）。
// 所以自托管权重、或首次使用时从 HF CDN 取权重，都不碰 R-1。
// 但「离线可用」是 FR-11/§7.6 的硬要求，所以打包版必须把权重放进 public/models/
// （npm run stage:align），只有纯 web 版才退到 CDN。

// ── 为什么配置和运行时设置分成两个文件 ──
// 这个文件被主线程侧的 client.ts 引用（只为了拿 sampleRate），而 configureRuntime 需要
// import @huggingface/transformers —— 它连着 onnxruntime-web 一共 500KB+。
// 合在一起的话首屏就得为一个绝大多数时候用不到的功能背上这 500KB。
// 需要 transformers.js 的那半边在 runtime.ts。

export interface AlignModelConfig {
  /** HF 仓库 id，或 public/models/ 下的目录名 */
  modelId: string;
  /** 词表大小（= 模型 logits 的最后一维），加载后会断言 */
  vocabSize: number;
  /** CTC blank 的 id */
  blankId: number;
  /** 采样率，wav2vec2 系列一律 16000 */
  sampleRate: number;
  /** inputs_to_logits_ratio，wav2vec2 系列一律 320 */
  frameStride: number;
}

export const MMS_FA: AlignModelConfig = {
  modelId: 'onnx-community/mms-300m-1130-forced-aligner-ONNX',
  vocabSize: 31,
  blankId: 0,
  sampleRate: 16000,
  frameStride: 320,
};

/** 权重与 ORT wasm 的自托管位置（相对站点根）。 */
export const LOCAL_MODEL_PATH = '/models/';

/**
 * 探一下自托管权重在不在。也用来在 UI 上区分「随包带」和「要下载 200MB」。
 *
 * 不能只看 res.ok：wrangler.jsonc 里 not_found_handling 是 single-page-application，
 * 缺失的路径会拿到 **200 + index.html**。所以必须验 content-type 真的是 JSON。
 */
export async function hasLocalWeights(config: AlignModelConfig): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_MODEL_PATH}${config.modelId}/config.json`, { method: 'HEAD' });
    return res.ok && (res.headers.get('content-type') ?? '').includes('json');
  } catch {
    return false;
  }
}

export type Device = 'webgpu' | 'wasm';
export type Dtype = 'q4f16' | 'int8' | 'fp32';

export interface DevicePlan {
  device: Device;
  dtype: Dtype;
}

/**
 * WebGPU 能用就用，快一个数量级；q4f16 需要 fp16，只有 WebGPU 路径支持。
 * WASM 退到 int8 —— 317MB，但它是唯一在没有 WebGPU 的设备上能跑起来的组合。
 */
export async function pickDevice(): Promise<DevicePlan> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu) {
    try {
      if (await gpu.requestAdapter()) return { device: 'webgpu', dtype: 'q4f16' };
    } catch {
      // 有 navigator.gpu 但要不到 adapter（虚拟机、无 GPU 的容器）—— 退 WASM
    }
  }
  return { device: 'wasm', dtype: 'int8' };
}
