// 矩阵在线缆上的样子。客户端那一半在 `src/align/remoteEmissions.ts`，**两边要一起改**。
//
//   [0, 4)            u32 LE：头部 JSON 的字节数（**已补齐到 4 的整数倍**）
//   [4, 4+n)          UTF-8 JSON：{ frames, vocabSize, duration }，尾部用空格补齐
//   [4+n, ...)        frames × vocabSize 个 float32 LE，帧优先
//
// 头部补齐到 4 的整数倍**不是洁癖**：不补的话负载起点不是 4 的倍数，
// 而 `new Float32Array(buf, offset)` 会直接抛 RangeError，客户端只能先拷一份 3MB。
// 补几个空格（JSON 允许尾部空白）换来的是零拷贝。这条被单测钉住了。
//
// ── 为什么不是 JSON + base64 ──
// 一课 3MB 的浮点，base64 之后 4MB，还要在两侧各解析一遍。原生插件那条路只能这么干
// （Capacitor 的桥只过 JSON），HTTP 没有这个限制。
//
// ── 为什么不压成 float16 ──
// 减半很诱人（3MB → 1.5MB），但 log-prob 的量级横跨 -30..0，float16 只有约 3 位十进制，
// Viterbi 在 24000 帧上累加这些数 —— 于是**同一课在服务器上算和在桌面上算会得到
// 细微不同的边界**。那正是这条路最不该引入的差别（见 model.ts 里选 q4 的同一条理由）。
// gzip 对随机浮点几乎无效，所以也不做。3MB 一课、一周一课，不值得为它牺牲可复现性。

export interface MatrixHeader {
  frames: number;
  vocabSize: number;
  duration: number;
}

export function encodeMatrix(header: MatrixHeader, logProbs: Float32Array): Uint8Array {
  let text = JSON.stringify(header);
  while ((4 + text.length) % 4 !== 0) text += ' ';
  // 头部里只有数字和 ASCII 键名，所以「字符数 = 字节数」，上面那个补齐才成立。
  const json = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + json.byteLength + logProbs.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength, true);
  out.set(json, 4);
  out.set(
    new Uint8Array(logProbs.buffer, logProbs.byteOffset, logProbs.byteLength),
    4 + json.byteLength,
  );
  return out;
}

export const MATRIX_CONTENT_TYPE = 'application/x-emission-matrix';
