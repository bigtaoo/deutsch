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
/** transformers.js 的 dtype 名，对应 onnx/model_<dtype>.onnx */
export type Dtype = 'q4f16' | 'q4' | 'bnb4' | 'int8' | 'fp32';

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
 * ── 为什么第 2 档是 q4 而不是 int8（2026-09-02 实测改正）──
 * 原来写的是 `wasm/int8`，理由是「WASM 唯一能跑的组合」。**那句话是错的**：
 * 4-bit 那两份（q4 / bnb4）的算子在 wasm EP 上都有实现，实测都跑通了。
 * 而 int8 那份根本跑不起来 —— 在 Windows/Chrome、32GB 内存的机器上，
 * 光是加载就会让渲染进程被干掉，JS 侧一行报错都没有（302.6 MiB 的权重在 ORT 的
 * wasm 堆里同时存在三份左右：JS 缓冲 + protobuf 解析 + 权重张量）。
 * 也就是说「没有 WebGPU 的浏览器」以前是**必死**，不是「慢一个量级」。
 *
 * 这个仓库里各档的实际字节与实测结果（同一台机器、同一条 Worker 通路）：
 *   - model_q4f16.onnx  187.6 MiB  ✅ 真实一课 8:05，45/45 句，26 秒。需要 fp16，只有 WebGPU 支持
 *   - model_bnb4.onnx   212.2 MiB  ✅ wasm 跑通（25 秒音频 32 秒）
 *   - model_q4.onnx     230.3 MiB  ✅ wasm 跑通（25 秒音频 36 秒，约 1.4× 实时）
 *   - model_int8.onnx   302.6 MiB  💥 加载即被杀
 *   - model_uint8 / model_quantized 同为 302.6 MiB，不必再试
 * 选 q4 而不是更小的 bnb4：两者体积只差 8%，都在能跑的一侧，而 q4 走的是 ORT 自己的
 * MatMulNBits，是 optimum / transformers.js 的默认 4-bit 通路 —— 出问题时可查的东西多得多。
 * 若哪天 q4 也被杀，降到 bnb4 是现成的下一步（改这一行 + stage-align-assets.mjs）。
 *
 * 只有这两份进 public/models/（scripts/stage-align-assets.mjs），所以阶梯只有两档：
 * 加第三档就意味着 IPA 再胖 200MB。顺带，换掉 int8 让随包权重从 490.2 MiB 降到 417.9 MiB。
 *
 * ── 手机上两档都不够 ──
 * iPhone 13 实测两档都在「加载对齐模型」这一步被系统杀掉，而 q4f16 已经是这个模型
 * **最小的一个变体**。所以降档在手机上救不了 —— 要么换个小一个数量级的模型，
 * 要么把 emissions 那一半挪出 WebView（原生插件或远端，见 emissionMatrix.ts）。
 */
export const PLAN_LADDER: DevicePlan[] = [
  { device: 'webgpu', dtype: 'q4f16' },
  { device: 'wasm', dtype: 'q4' },
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
