// 对齐模型的**纯配置**。
//
// ── 用的是哪个模型（变更 42）──
// `oliverguhr/wav2vec2-large-xlsr-53-german-cv9` —— **德语原生的 CTC 模型**，
// Apache-2.0，Common Voice 9 上 WER 9.48% / CER 1.92%（贪心，不带 LM）。
// 词表 35 个 token：`|` + a-z + ä/ö/ü/ß + `[UNK]`/`[PAD]` + 两个用不到的 `<s>`/`</s>`。
//
// 上一个是 MMS-FA（`facebook/mms-300m-1130-forced-aligner`），换掉它有三个理由，
// 按重要性排：
//   1. **它是罗马化的**：词表只有 a-z，德语进去之前 ä→a、ö→o、ü→u、ß→ss，
//      而那几个音恰恰是德语里最要紧的区别。德语原生模型不用丢这些。
//   2. **它没有词分隔符**：MMS 的词表里没有空格，词间静音只能由 blank 吸收；
//      这个模型有 `|`，词边界因此是被显式建模的（见 vocab.ts 顶部那段）。
//   3. MMS-FA 是 **CC-BY-NC-4.0**（非商用）。自己精听没问题，但 §3.1 本来就是
//      一整节法律约束，能换成 Apache-2.0 就没有理由不换。
//
// 换模型要动的是：modelId、vocabSize/blankId、vocab.ts 那张表与字符映射。
// 对齐算法（viterbi/windowed/target）**一行都不用改** —— blankId 是参数，不是常量。
//
// ── 权重从哪儿来 ──
// 这个仓库在 HF 上只有 fp32 那一份（1204 MiB，服务器用的就是它）。浏览器要的
// 4-bit 量化版是**我们自己量化的**（scripts/quantize-align-model.py），HF 上没有，
// 所以取件顺序是：随包（public/models/，只有 Android 打包版有）→ 自己的权重站
// （同步服务器的 /v1/align/weights/，见 WEIGHTS_BASE）。没有「退到 HF CDN」这一档了。
//
// ── §3.1.1 R-1 与模型权重 ──
// R-1 管的是**学习内容**的通路：请求只能从用户设备发出，不许有我们运营的中转代抓。
// 模型权重不是学习内容，所以从自己的服务器取权重不碰 R-1。
// （音频确实会经手服务器 —— 那是 FR-15.17 那条路自己的事，见 remoteEmissions.ts。）

// ── 为什么配置和运行时设置分成两个文件 ──
// 这个文件被主线程侧的 client.ts 引用（只为了拿 sampleRate），而 configureRuntime 需要
// import @huggingface/transformers —— 它连着 onnxruntime-web 一共 500KB+。
// 合在一起的话首屏就得为一个绝大多数时候用不到的功能背上这 500KB。
// 需要 transformers.js 的那半边在 runtime.ts。

import { SYNC_API_BASE } from '@/sync/config';

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

export const GERMAN_CTC: AlignModelConfig = {
  modelId: 'oliverguhr/wav2vec2-large-xlsr-53-german-cv9',
  // 35 而不是 33：`added_tokens.json` 里的 `<s>`/`</s>` 也算在 logits 的最后一维里。
  vocabSize: 35,
  // **不是 0。** 0 是词分隔符 `|`，blank 是 `[PAD]`=32。给错了对齐会静默地全错。
  blankId: 32,
  sampleRate: 16000,
  frameStride: 320,
};

/** 随包权重的位置（相对站点根）。只有跑过 `npm run stage:align` 的打包版有。 */
export const LOCAL_MODEL_PATH = '/models/';

/**
 * 自己的权重站：同步服务器上那份静态目录（`server/src/align/weights.ts`）。
 *
 * 为什么不是 HF CDN：浏览器要的是 4-bit 量化版，而那份文件是我们自己量化出来的，
 * HF 上并不存在（见文件顶部）。为什么不是 Cloudflare：那边单文件上限 25 MiB，
 * 230MB 的权重放不进去。所以放在这台本来就要有的服务器上，浏览器取一次、
 * transformers.js 自己存进 Cache API，之后离线可用。
 *
 * 没配同步服务器时是空串 —— 那时本机对齐整个不可用，UI 要说得出这句话
 * （设置页「对齐后端」那一段）。
 */
export const WEIGHTS_BASE = SYNC_API_BASE ? `${SYNC_API_BASE}/v1/align/weights/` : '';

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
export async function hasLocalWeights(
  config: AlignModelConfig,
  base: string = LOCAL_MODEL_PATH,
): Promise<boolean> {
  if (!base) return false;
  try {
    const res = await fetch(`${base}${config.modelId}/config.json`);
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
 * 服务器那一档（SPEC §0 变更 35 / FR-15.17）。
 * **不在 `PLAN_LADDER` 里**，`planStep` 也用 -1 —— 这台设备的内存和它一点关系都没有，
 * 把它算进崩溃计数会让桌面的降档判据跟着坏。
 *
 * dtype 记 `fp32`：服务器跑的是**未量化**的那一份（1204 MiB，`ALIGN_MODEL_DTYPE`
 * 的默认值），而浏览器跑的是自己量化的 q4。变更 42 之前三条路刻意用同一份权重，
 * 为的是「同一课在哪儿算都得到同一份时间戳」；现在那个要求主动放弃了 ——
 * 服务器上没有体积和内存的理由去将就 4-bit，而两条路的差别本来就查得到（黑匣子里
 * 记着这一档）。**所以同一课重对一次、换个地方算，边界会有几十毫秒级的出入。**
 */
export interface RemotePlan {
  device: 'remote';
  dtype: Dtype;
}

/** 黑匣子与诊断里记的「用的哪套后端」。浏览器那两档 + 服务器。 */
export type RunPlan = DevicePlan | RemotePlan;

export const REMOTE_PLAN: RemotePlan = { device: 'remote', dtype: 'fp32' };
/** -1 的含义是「不在阶梯上」，不是「哪一档」。 */
export const REMOTE_PLAN_STEP = -1;

/**
 * 「第几档」这句话只对浏览器那两档成立。服务器不在阶梯上，
 * 给它编一个档号会让诊断页说出「第 0 档」这种没有意义的话。
 *
 * `planStep < 0` 那一支还兼容**历史记录**：黑匣子在 localStorage 里，
 * 会比代码活得久 —— 变更 42 之前那台 iPhone 上的 `native/q4` 还躺在里面。
 */
export function planLabel(plan: RunPlan, planStep: number): string {
  const backend = `${plan.device}/${plan.dtype}`;
  if (plan.device === 'remote') return `${backend}（服务器，不在阶梯上）`;
  if (planStep < 0) return `${backend}（不在阶梯上）`;
  return `${backend}（第 ${planStep + 1} 档）`;
}

/**
 * 后端阶梯。**顺序 = 从最快到最能兜底**。
 *
 * 之所以是「阶梯」而不是一个函数算出来的唯一答案：加载权重会把整个进程搞死
 * （见 journal.ts 顶部那次事故），而崩溃是 try/catch 抓不到的。能做的只有
 * 「记住哪一档崩过，下次换一档」—— 阶梯就是给这件事用的。
 *
 * ── 为什么两档用同一份权重（变更 42）──
 * 以前是 `webgpu/q4f16` + `wasm/q4` 两份文件（187.6 + 230.3 MiB 全都随包带）。
 * 现在权重是我们自己量化的（scripts/quantize-align-model.py），多出一份 fp16 变体
 * 就意味着多量化一次、多托管一份、多一条「这台机器到底加载了哪份」的排查路径 ——
 * 而 q4f16 唯一的好处是 WebGPU 上省一半显存和一点时间，在桌面上都不是问题。
 * 所以只做 `q4`：MatMulNBits 在 WebGPU 和 wasm 两个 EP 上都有实现，一份文件通吃。
 *
 * 实测（MMS-FA 时代，同一台机器、同一条 Worker 通路，可以当量级参考）：
 *   - 4-bit / WebGPU  真实一课 8:05，45/45 句，26 秒
 *   - 4-bit / wasm    25 秒音频 36 秒，约 1.4× 实时
 *   - int8（302.6 MiB）在 wasm 上加载即被系统杀掉 —— 所以 8-bit 那一档从来不在阶梯上
 */
export const PLAN_LADDER: DevicePlan[] = [
  { device: 'webgpu', dtype: 'q4' },
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
