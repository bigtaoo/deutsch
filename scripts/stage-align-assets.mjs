// 把对齐模型的权重下载进 public/models/，让打包版（Electron/Capacitor）随包带上、
// 从第一次使用起就完全离线。
//
// ORT 的 wasm **不在这里** —— 它由 src/align/runtime.ts 里的 Vite `?url` 导入，
// 构建时自动进 dist/assets/。曾经在这里复制到 public/ort/，结果 dist 里出现两份
// 同样的 23MB wasm（Vite 分析 onnxruntime-web 时还会自己打一份），白占一倍体积。
//
// 纯 web 版可以完全不跑这个脚本：首次对齐时 transformers.js 会从 HF CDN 取权重，
// 之后自己存进 Cache API（env.useBrowserCache 默认 true），所以只有第一次需要联网。
// 但随包发布的版本一定要跑，否则用户第一次用必须联网下 200MB。
//
// 用法：npm run stage:align
//
// public/models/ 在 .gitignore 里：200MB 不该进 git，而且它完全可从 HF 重建 ——
// 就是 §6 说的「丢了能重建」。

import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 必须与 src/align/config.ts 的 MMS_FA.modelId 一致 —— transformers.js 在
// env.localModelPath 下按 modelId 找目录。
const MODEL_ID = 'onnx-community/mms-300m-1130-forced-aligner-ONNX';

// 两种权重都要带：pickDevice() 有 WebGPU 时走 q4f16，退到 WASM 时走 int8。
// 只带一个的话，换台没有 WebGPU 的设备就又得联网。
const MODEL_FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.json',
  'onnx/model_q4f16.onnx',
  'onnx/model_int8.onnx',
];

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function download(url, dest) {
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} ← ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return (await stat(dest)).size;
}

const destDir = join(ROOT, 'public', 'models', MODEL_ID);
console.log(`下载 ${MODEL_ID} → public/models/（约 200MB，取决于网速要几分钟）…`);
let total = 0;
for (const name of MODEL_FILES) {
  const dest = join(destDir, name);
  const existing = await sizeOf(dest);
  if (existing) {
    console.log(`  · ${name}  已存在，跳过（${mib(existing)}）`);
    total += existing;
    continue;
  }
  const size = await download(`https://huggingface.co/${MODEL_ID}/resolve/main/${name}`, dest);
  total += size;
  console.log(`  ✓ ${name}  ${mib(size)}`);
}
console.log(`模型就位：共 ${mib(total)}`);
console.log(
  '\n注意：这个模型是 CC-BY-NC-4.0（非商用）。自用与免费分发没问题，\n' +
    '要商用得换成宽松许可的德语 CTC 模型 —— 换法见 src/align/config.ts 顶部。',
);
