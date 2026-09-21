// 权重的落地与 ORT 会话。
//
// ── 权重不进镜像 ──
// 1.2GB 的 `.onnx` 放进 Docker 镜像意味着每次 `docker compose up --build` 都要重下一遍
// （CI 每次部署都会跑那一行），而它是一个**永远不变的文件**。所以它落在挂进来的
// `/data/models/` 里：镜像重建不碰它，容器重启不碰它，`docker compose down` 也不碰它。
// 第一次用的时候自己去 HF 取（fp32 那份在 HF 上是现成的）。
//
// ── 为什么是 fp32（变更 42）──
// 以前是 q4（230 MiB），理由是「三条路算出同一份时间戳」—— 手机原生插件、桌面浏览器、
// 服务器共用一份权重。手机那条路删掉之后这个理由只剩一半，而**服务器这边本来就没有
// 省内存的必要**：它不是手机，1.2GB 的权重在一台 8G 的机器上放得下。
// 所以服务器跑未量化的那一份，浏览器跑自己量化的 q4。
// 代价写在明处：同一课在服务器上算和在桌面上算，边界会有几十毫秒级的出入。
//
// ── 代价之二：常驻内存 ──
// fp32 的会话一旦建起来就是 2.1 GiB 常驻，而这台机器上还跑着公司的东西。
// 所以 engine.ts 给它加了**闲置释放**（ALIGN_IDLE_MS，默认 10 分钟）：
// 一周用一次的东西没有理由 7×24 占着那 2.1 GiB，重新加载十几秒完全可以接受。

import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/** 与 src/align/config.ts 的 GERMAN_CTC.modelId 一致。 */
export const MODEL_ID = 'oliverguhr/wav2vec2-large-xlsr-53-german-cv9';

/**
 * 每种权重变体的文件名与「下到一半」的判据。
 *
 * fp32 那份在 HF 上叫 `model.onnx`（没有 dtype 后缀）—— 这是模型作者自己导出的那一份，
 * 不是 optimum 的命名习惯。其余变体是**我们自己量化的**，HF 上没有，
 * 只能由 `scripts/quantize-align-model.py` 产出之后 scp 上来（deploy/README.md §对齐）。
 */
const VARIANTS: Record<string, { file: string; minBytes: number; onHub: boolean }> = {
  fp32: { file: 'onnx/model.onnx', minBytes: 1_000_000_000, onHub: true },
  q4: { file: 'onnx/model_q4.onnx', minBytes: 100_000_000, onHub: false },
};

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
  /** 把那 2.1 GiB 还给系统。闲置释放用，见 engine.ts。 */
  release(): Promise<void>;
}

function variantOf(dtype: string) {
  const variant = VARIANTS[dtype];
  if (!variant) {
    throw new Error(`不认识的权重变体 ${dtype} —— 可选：${Object.keys(VARIANTS).join(' / ')}`);
  }
  return variant;
}

/** 权重在 `/data/models/` 下的绝对路径。权重站（weights.ts）也按这个布局对外提供。 */
export function modelPath(dir: string, dtype: string): string {
  return join(dir, MODEL_ID, variantOf(dtype).file);
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
  const variant = variantOf(options.dtype);
  const dest = modelPath(options.dir, options.dtype);
  const existing = await sizeOf(dest);
  // 下限哨兵：比这还小说明上次下到一半就断了。
  if (existing !== null && existing > variant.minBytes) return dest;
  if (existing !== null) await unlink(dest).catch(() => {});
  if (!variant.onHub) {
    throw new Error(
      `${variant.file} 不在 HF 上（它是我们自己量化的）—— ` +
        `跑 scripts/quantize-align-model.py 产出之后放到 ${dest}`,
    );
  }

  const url = `https://huggingface.co/${MODEL_ID}/resolve/main/${variant.file}`;
  const part = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`取权重失败：${res.status} ${res.statusText} ← ${url}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(part));
  await rename(part, dest);
  return dest;
}

/**
 * 建一个 ORT 会话。加载一次要十几秒，所以 engine.ts 会把它缓存一段时间
 * （闲置超过 ALIGN_IDLE_MS 才放掉，见那边）。
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
    release: () => session.release(),
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
