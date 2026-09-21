// 把对齐权重放进 public/models/，让打包版（Android）随包带上、从第一次使用起完全离线。
//
// ── 权重从哪儿来 ──
// 两处，按顺序试：
//   ① `.cache/align/<modelId>/onnx/model_q4.onnx` —— 本机量化过的那份
//      （scripts/quantize-align-model.py）。有它就直接抄，不走网络。
//   ② 权重站 —— 同步服务器的 `/v1/align/weights/`（server/src/align/weights.ts）。
//      CI 里走的是这条：环境变量 `WEIGHTS_BASE` 或 `VITE_SYNC_API_BASE` 给出地址。
// **HF 不在这个列表里**：那上面只有 fp32 那一份（1204 MiB），浏览器跑不动它，
// 而 4-bit 这份是我们自己量化的。
//
// 两个配置文件也**不从 HF 下**，从 `scripts/align-model/` 拷 —— 那里那份
// preprocessor_config.json 被我们改过一处，理由见那个目录的 README。
//
// ORT 的 wasm **不在这里** —— 它由 src/align/runtime.ts 里的 Vite `?url` 导入，
// 构建时自动进 dist/assets/。
//
// 纯 web 版完全不需要跑这个脚本：浏览器会直接从权重站取，transformers.js 自己存进
// Cache API，所以只有第一次需要联网。
//
// 用法：npm run stage:align
//
// public/models/ 在 .gitignore 里：230MB 不该进 git，而且它完全可重建 ——
// 就是 §6 说的「丢了能重建」。

import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 必须与 src/align/config.ts 的 GERMAN_CTC.modelId 一致 —— transformers.js 在
// env.localModelPath 下按 modelId 找目录。
const MODEL_ID = 'oliverguhr/wav2vec2-large-xlsr-53-german-cv9';

// 只带 4-bit 那一份：阶梯上的两档（webgpu/wasm）用的是同一个文件，
// 理由见 src/align/config.ts 的 PLAN_LADDER。
const MODEL_FILES = ['config.json', 'preprocessor_config.json', 'onnx/model_q4.onnx'];

const weightsBase = (process.env.WEIGHTS_BASE ?? process.env.VITE_SYNC_API_BASE ?? '').replace(
  /\/+$/,
  '',
);
const remoteBase = weightsBase
  ? weightsBase.endsWith('/v1/align/weights')
    ? `${weightsBase}/`
    : `${weightsBase}/v1/align/weights/`
  : '';

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
const cacheDir = join(ROOT, '.cache', 'align', MODEL_ID);

console.log(`把 ${MODEL_ID} 放进 public/models/（约 230MB）…`);
let total = 0;
for (const name of MODEL_FILES) {
  const dest = join(destDir, name);
  const existing = await sizeOf(dest);
  if (existing) {
    console.log(`  · ${name}  已存在，跳过（${mib(existing)}）`);
    total += existing;
    continue;
  }

  // ① 两个配置文件在仓库里（改过一处，见 scripts/align-model/README.md）
  if (name.endsWith('.json')) {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(ROOT, 'scripts', 'align-model', name), dest);
    const size = await sizeOf(dest);
    total += size;
    console.log(`  ✓ ${name}  ${mib(size)}（来自 scripts/align-model/）`);
    continue;
  }

  // ② 本机量化过的那份
  const cached = join(cacheDir, name);
  if (await sizeOf(cached)) {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(cached, dest);
    const size = await sizeOf(dest);
    total += size;
    console.log(`  ✓ ${name}  ${mib(size)}（来自 .cache/align/）`);
    continue;
  }

  // ③ 权重站
  const url = remoteBase ? `${remoteBase}${MODEL_ID}/${name}` : null;
  if (!url) {
    console.error(
      `\n${name} 取不到：没有本机量化的产物，也没配权重站地址。\n` +
        '  · 本机量化：python scripts/quantize-align-model.py\n' +
        '  · 或者给地址：WEIGHTS_BASE=https://sync.gamestao.com npm run stage:align',
    );
    process.exit(1);
  }
  const size = await download(url, dest);
  total += size;
  console.log(`  ✓ ${name}  ${mib(size)}`);
}
console.log(`权重就位：共 ${mib(total)}`);
