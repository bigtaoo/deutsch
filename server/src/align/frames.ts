// 分块、归一化、log-softmax —— emissions 那一半里**不需要模型**的全部数学。
//
// 这个文件是 `src/align/emissions.ts`（浏览器）与 `native-plugins/align-native/`
// 的 `EmissionsEngine.swift`（iOS）的**第三份**逐条移植。三份必须逐字等价：
// 同一课在桌面、iPhone 和这台服务器上算出来的时间戳必须是同一份，
// 否则「在哪台机器上算的」会变成一个用户看不见、却能听出来的差别。
//
// **改任何一处都要改另外两处**，这条写在三个文件里各一遍。三处的锚点：
//   · 20 秒块 / 2 秒重叠 / 每块只采用中间段
//   · 每块各自零均值单位方差，eps = 1e-7（wav2vec2 的 do_normalize）
//   · 全局帧号一律 floor(sample / 320)，不按每块实际输出帧数累加
//   · 没被任何块覆盖到的帧填 log(1 / vocabSize)
//
// 为什么不从前端那份 import 进来：`server/` 是独立的 npm 工程，CI 只把 `server/` 那一棵
// 打包上传（deploy/ci-deploy.sh 只搬 src/、package.json、package-lock.json、Dockerfile），
// 跨出去 import 会把「部署载荷」和「前端构建」绑在一起。三份拷贝的代价由这里的单测兜：
// `frames.test.ts` 里的期望值与前端 `emissions.test.ts` 是同一组。

export interface Chunk {
  /** 该块在整段音频里的起始采样点 */
  sampleStart: number;
  sampleEnd: number;
  /** 采用区间（全局帧号，右开）—— 两侧重叠的一半被丢掉 */
  keepFrameStart: number;
  keepFrameEnd: number;
}

/** wav2vec2 的 do_normalize：每块自己零均值单位方差。eps 与 transformers 一致。 */
export const NORMALIZE_EPS = 1e-7;

export function planChunks(
  totalSamples: number,
  sampleRate: number,
  frameStride: number,
  chunkSeconds = 20,
  overlapSeconds = 2,
): Chunk[] {
  const chunkSamples = Math.round(chunkSeconds * sampleRate);
  const overlapSamples = Math.round(overlapSeconds * sampleRate);
  const strideSamples = chunkSamples - overlapSamples;
  const totalFrames = Math.floor(totalSamples / frameStride);
  if (totalSamples <= chunkSamples) {
    return [{ sampleStart: 0, sampleEnd: totalSamples, keepFrameStart: 0, keepFrameEnd: totalFrames }];
  }

  const chunks: Chunk[] = [];
  for (let start = 0; start < totalSamples; start += strideSamples) {
    const sampleEnd = Math.min(totalSamples, start + chunkSamples);
    const isFirst = start === 0;
    const isLast = sampleEnd >= totalSamples;
    const trim = Math.floor(overlapSamples / 2);
    const keepStart = isFirst ? 0 : start + trim;
    const keepEnd = isLast ? totalSamples : sampleEnd - trim;
    chunks.push({
      sampleStart: start,
      sampleEnd,
      keepFrameStart: Math.floor(keepStart / frameStride),
      keepFrameEnd: Math.min(totalFrames, Math.floor(keepEnd / frameStride)),
    });
    if (isLast) break;
  }
  return chunks;
}

/**
 * 就地 log-softmax。全程在 log 域：先减去每帧最大值再取 exp，避免 exp 溢出。
 */
export function logSoftmaxInPlace(data: Float32Array, frames: number, vocabSize: number): void {
  for (let t = 0; t < frames; t++) {
    const base = t * vocabSize;
    let max = -Infinity;
    for (let v = 0; v < vocabSize; v++) if (data[base + v] > max) max = data[base + v];
    let sum = 0;
    for (let v = 0; v < vocabSize; v++) sum += Math.exp(data[base + v] - max);
    const logSum = max + Math.log(sum);
    for (let v = 0; v < vocabSize; v++) data[base + v] -= logSum;
  }
}

/**
 * 一块波形的归一化。**返回新数组**而不是就地改：调用方拿到的是整段音频的
 * `subarray`，就地改会把重叠部分归一化两次（第二次的均值算在已经归一化过的值上）。
 * 那种错不会报任何错，只会让块边界附近的后验悄悄变差。
 */
export function normalizeChunk(samples: Float32Array): Float32Array {
  const n = samples.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i];
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = samples[i] - mean;
    variance += d * d;
  }
  variance /= n;
  const scale = 1 / Math.sqrt(variance + NORMALIZE_EPS);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (samples[i] - mean) * scale;
  return out;
}
