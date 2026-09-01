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
 * 缺失的路径会拿到 **200 + index.html**。
 *
 * 曾经是 `HEAD` + 验 content-type，Capacitor 原生壳（SPEC §7.10）把这条路堵了：
 * 壳里的 dist 不是被 HTTP 服务器托管的，而是 iOS 的 `capacitor://` scheme handler /
 * Android 的 WebViewAssetLoader 在读本地文件 —— 它们对 HEAD 和响应头的支持都不保证，
 * 而这里一旦误判成「没有本地权重」，随包带的 200MB 就白带了，用户第一次用还是要联网。
 * 所以改成 GET 那份 1KB 的 config.json 并**真的 parse 一遍**：这个判据不依赖任何响应头，
 * 在静态托管、原生壳、`vite preview` 三种情况下都成立（SPA fallback 回的 index.html
 * parse 一定失败）。
 */
export async function hasLocalWeights(config: AlignModelConfig): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_MODEL_PATH}${config.modelId}/config.json`);
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null;
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
 * 后端阶梯。**顺序 = 从最省内存到最能兜底**，不是从快到慢（虽然这里恰好一致）。
 *
 * 之所以是「阶梯」而不是一个函数算出来的唯一答案：手机上加载权重会把应用整个搞死
 * （见 journal.ts 顶部那次事故），而崩溃是 try/catch 抓不到的。能做的只有
 * 「记住哪一档崩过，下次换一档」—— 阶梯就是给这件事用的。
 *
 * 两档的实际字节数（onnx-community/mms-300m-1130-forced-aligner-ONNX）：
 *   - model_q4f16.onnx  187.6 MiB  —— 需要 fp16，只有 WebGPU 路径支持
 *   - model_int8.onnx   302.6 MiB  —— WASM 唯一能跑的组合，单线程，慢一个量级
 * 也只有这两份进了 public/models/（scripts/stage-align-assets.mjs），所以阶梯只有两档：
 * 加第三档就意味着 IPA 再胖 200MB。
 */
export const PLAN_LADDER: DevicePlan[] = [
  { device: 'webgpu', dtype: 'q4f16' },
  { device: 'wasm', dtype: 'int8' },
];

/**
 * 选后端。step 是 PLAN_LADDER 的下标（由 journal.nextPlanStep() 给出）。
 *
 * 没有 WebGPU 时第 0 档自动落到第 1 档 —— 返回值里带回**实际用的** step，
 * 因为黑匣子要记的是真实档位，不是请求的档位。
 */
export async function pickPlan(step = 0): Promise<{ plan: DevicePlan; step: number }> {
  if (step === 0) {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu) {
      try {
        if (await gpu.requestAdapter()) return { plan: PLAN_LADDER[0], step: 0 };
      } catch {
        // 有 navigator.gpu 但要不到 adapter（虚拟机、无 GPU 的容器）—— 退下一档
      }
    }
  }
  return { plan: PLAN_LADDER[1], step: 1 };
}

/** 诊断页用：这台设备默认会走哪一档。 */
export async function pickDevice(): Promise<DevicePlan> {
  return (await pickPlan(0)).plan;
}
