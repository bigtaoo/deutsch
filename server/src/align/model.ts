// 权重的落地与 ORT 会话。
//
// ── 权重不进镜像 ──
// 230MB 的 `.onnx` 放进 Docker 镜像意味着每次 `docker compose up --build` 都要重下一遍
// （CI 每次部署都会跑那一行），而它是一个**永远不变的文件**。所以它落在挂进来的
// `/data/models/` 里：镜像重建不碰它，容器重启不碰它，`docker compose down` 也不碰它。
// 第一次用的时候自己去 HF 取；想省那几分钟就 `scp` 一份进去（deploy/README.md §对齐）。
//
// ── 为什么是 q4 ──
// 与手机原生插件那一档同一份权重（230.3 MiB，`MatMulNBits`）。选它不是为了省内存 ——
// 这台机器有 5G 可用 —— 而是为了**三条路算出同一份时间戳**：dtype 一换，
// 量化误差就换，同一课在桌面/手机/服务器上会得到细微不同的边界。
// 真要换（比如 ORT 的 node 分发里没有 `MatMulNBits`），改 `ALIGN_MODEL_DTYPE`，
// 并且要明白从那一刻起服务器算的和另外两条路不再逐位相同。

import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/** 与 src/align/config.ts 的 MMS_FA.modelId 一致。 */
export const MODEL_ID = 'onnx-community/mms-300m-1130-forced-aligner-ONNX';

export interface ModelOptions {
  /** 权重放哪（`${DATA_DIR}/models`） */
  dir: string;
  dtype: string;
  /** intra-op 线程数。4 vCPU 的机器上留一个给别人（这台还跑着公司的东西）。 */
  threads: number;
}

export interface CtcSession {
  /** 跑一块，返回 [frames, vocabSize] 与扁平 logits（**未** log-softmax）。 */
  run(samples: Float32Array): Promise<{ logits: Float32Array; frames: number; vocabSize: number }>;
}

function modelPath(options: ModelOptions): string {
  return join(options.dir, MODEL_ID, `onnx/model_${options.dtype}.onnx`);
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/**
 * 权重在不在，不在就下。返回文件路径。
 *
 * 先下到 `.part` 再改名：半个文件被 ORT 读到的报错（「protobuf 解析失败」）
 * 和「模型不兼容」长得一模一样，那是最费时间的一种误判。
 */
export async function ensureWeights(options: ModelOptions): Promise<string> {
  const dest = modelPath(options);
  const existing = await sizeOf(dest);
  // 100MB 是个下限哨兵：这个仓库里最小的那份变体是 212 MiB，
  // 比这还小说明上次下到一半就断了。
  if (existing !== null && existing > 100 * 1024 * 1024) return dest;
  if (existing !== null) await unlink(dest).catch(() => {});

  const url = `https://huggingface.co/${MODEL_ID}/resolve/main/onnx/model_${options.dtype}.onnx`;
  const part = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`取权重失败：${res.status} ${res.statusText} ← ${url}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(part));
  await rename(part, dest);
  return dest;
}

/**
 * 建一个 ORT 会话。**权重加载一次就留着** —— 这个函数由 engine.ts 缓存，
 * 一次加载 230MB 要十几秒，而这台服务器是常驻进程，没有理由每课重来。
 *
 * `onnxruntime-node` 是 optionalDependency：装不上（平台没有预编译产物）时
 * 这里抛，路由把它翻译成 503 + 明确原因，而**同步那一半照常工作**。
 * 这条服务的本职是备份，对齐是搭上来的，不能因为它装不上就整台不可用。
 */
export async function createSession(options: ModelOptions): Promise<CtcSession> {
  const path = await ensureWeights(options);
  let ort: typeof import('onnxruntime-node');
  try {
    ort = await import('onnxruntime-node');
  } catch (err) {
    throw new Error(
      `这台服务器上没有 onnxruntime-node（${err instanceof Error ? err.message : err}）—— ` +
        '它是 optionalDependency，装不上时对齐不可用，同步不受影响',
    );
  }

  const session = await ort.InferenceSession.create(path, {
    executionProviders: ['cpu'],
    intraOpNumThreads: options.threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  // 名字从会话里问，不写死：optimum 导出的 wav2vec2 是 input_values/logits，
  // 但那是导出器的约定，不是模型的契约。
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  return {
    async run(samples: Float32Array) {
      const tensor = new ort.Tensor('float32', samples, [1, samples.length]);
      const output = await session.run({ [inputName]: tensor });
      const logits = output[outputName];
      const dims = logits.dims;
      if (dims.length !== 3 || dims[0] !== 1) {
        throw new Error(`logits 的形状不是 [1, frames, vocab]，是 [${dims.join(', ')}]`);
      }
      return {
        logits: logits.data as Float32Array,
        frames: Number(dims[1]),
        vocabSize: Number(dims[2]),
      };
    },
  };
}
