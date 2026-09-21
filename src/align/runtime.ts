// 对齐模型的运行时设置。需要 @huggingface/transformers，所以**只能被 Worker 侧引用**
// —— 主线程 import 到它就会把 500KB+ 的 transformers.js + onnxruntime-web 拽进首屏包。
// 纯配置在 config.ts。

import { env } from '@huggingface/transformers';
import { LOCAL_MODEL_PATH, WEIGHTS_BASE, hasLocalWeights, type AlignModelConfig } from './config';
import { createStreamingWeightsCache } from './rangedFetch';

// ORT 的 wasm 走 Vite 的 ?url，而不是自己复制一份到 public/ort/。
// 直接 import 有三个好处：不需要额外的 staging 步骤、路径由构建产出所以不可能 404、
// 而且 dist 里只有**一份** —— 复制到 public/ 的话，Vite 分析 onnxruntime-web 时
// 还是会把同一个 23MB 的 wasm 再打成一份 hash 资源，白占一倍体积。
//
// 注意：这些是绝对路径（/assets/…）。用 Electron 的 file:// 装起来时要给 vite 配
// base: './'，不过那对整个应用都成立，不是这里特有的问题。
import asyncifyWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import asyncifyMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import plainWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import plainMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';

/** 权重这一次是从哪儿取的。`none` = 两处都没有，本机对齐这条路走不通。 */
export type WeightsSource = 'local' | 'server' | 'none';

let configured: Promise<{ weights: WeightsSource }> | null = null;

/**
 * 配置 transformers.js 的取件路径。只做一次。
 *
 * 关键的一条：transformers.js **默认从 cdn.jsdelivr.net 拉 onnxruntime-web 的 wasm**
 * （见 dist/transformers.web.js 里那段 `cdn.jsdelivr.net/npm/onnxruntime-web@...`）。
 * 不覆盖它，断网时模型压根起不来 —— 而离线可用是这个功能存在的理由之一。
 * 所以无条件指到构建产出的那四个文件。
 *
 * 权重本身要探一下再决定，顺序是**随包 → 自己的权重站**（config.ts 的 WEIGHTS_BASE）。
 * 没有「退到 HF CDN」那一档了：浏览器要的 4-bit 权重是我们自己量化的，HF 上没有。
 * 所以 `allowRemoteModels` 一律 false —— 让它去 HF 只会拿到 404，而报错会说成
 * 「模型不存在」，把人引到完全错误的方向。
 *
 * Safari 用非 asyncify 版 —— 这也是 transformers.js 自己的默认分支逻辑
 * （transformers.web.js 里同样按 IS_SAFARI 分叉）。
 */
export function configureRuntime(config: AlignModelConfig): Promise<{ weights: WeightsSource }> {
  if (configured) return configured;
  configured = (async () => {
    const isSafari =
      typeof navigator !== 'undefined' &&
      /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    // @ts-expect-error transformers.js 的 env.backends 是宽松类型
    env.backends.onnx.wasm.wasmPaths = isSafari
      ? { mjs: plainMjs, wasm: plainWasm }
      : { mjs: asyncifyMjs, wasm: asyncifyWasm };

    // 没有 SharedArrayBuffer 就不可能多线程（原生壳与无 COOP/COEP 的站点都是这样）。
    // 显式写 1 而不是让 ORT 自己发现：它的探测路径会先尝试初始化线程环境，
    // 那一步在 WKWebView 里既没用又要多分配一次。
    if (typeof SharedArrayBuffer === 'undefined') {
      // @ts-expect-error 同上
      env.backends.onnx.wasm.numThreads = 1;
    }

    // 只有真的探到权重才允许走「本地」那条路。打开 allowLocalModels 却没有权重时，
    // 静态托管的 SPA fallback 会把 /models/**/config.json 回成一份 200 的 index.html，
    // transformers.js 拿去 JSON.parse 直接炸 —— 而且报的是「配置解析失败」，
    // 跟真正的原因（权重没放）完全对不上号。
    //
    // 探两处：随包（打包版）→ 自己的权重站（浏览器）。两处都是同一套目录结构，
    // 所以差别只有 env.localModelPath 这个前缀。
    const bundled = await hasLocalWeights(config, LOCAL_MODEL_PATH);
    const base = bundled
      ? LOCAL_MODEL_PATH
      : (await hasLocalWeights(config, WEIGHTS_BASE))
        ? WEIGHTS_BASE
        : '';
    env.localModelPath = base;
    env.allowLocalModels = base !== '';
    // HF 上没有我们量化的那一份，去那儿只会 404。见上面那段。
    env.allowRemoteModels = false;

    if (bundled) {
      // 随包权重：接管取件，并**关掉浏览器缓存** —— 见 rangedFetch.ts 顶部那段事故分析，
      // 把安装包里已有的两百多 MB 再抄一份进 Cache API 是那次崩溃的最大一笔无谓开销。
      env.useBrowserCache = false;
      env.useCustomCache = true;
      env.customCache = createStreamingWeightsCache(LOCAL_MODEL_PATH);
    }
    // 从权重站取的那一份**要**进 Cache API（env.useBrowserCache 默认 true）：
    // 230MB 下一次，之后离线可用 —— 这是「服务器挂了我自己算」成立的前提。

    return { weights: bundled ? 'local' : base ? 'server' : 'none' };
  })();
  return configured;
}
