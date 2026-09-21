// 矩阵在线缆上的样子。客户端那一半在 `src/align/remoteEmissions.ts`，**两边要一起改**。
//
// 这里最要紧的一条是**头部补齐到 4 的整数倍**：不补的话负载起点不是 4 的倍数，
// 客户端 `new Float32Array(buf, offset)` 直接抛 RangeError —— 而那只在某些
// frames/vocabSize 组合下发生，本机跑一课全绿、线上换一课就炸。所以逐个长度扫一遍。

import { describe, expect, it } from 'vitest';
import { MATRIX_CONTENT_TYPE, encodeMatrix, type MatrixHeader } from './wire.ts';

/** 照客户端的读法解一遍：这才是「能不能用」的真判据。 */
function decodeMatrix(bytes: Uint8Array): { header: MatrixHeader; logProbs: Float32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonBytes = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + jsonBytes)),
  ) as MatrixHeader;
  const offset = bytes.byteOffset + 4 + jsonBytes;
  const count = (bytes.byteLength - 4 - jsonBytes) / 4;
  // 零拷贝的那一步 —— 起点不是 4 的倍数时它会抛。
  return { header, logProbs: new Float32Array(bytes.buffer, offset, count) };
}

function matrix(frames: number, vocabSize: number): Float32Array {
  return Float32Array.from({ length: frames * vocabSize }, (_, i) => -i / 10);
}

describe('encodeMatrix', () => {
  it('头部 + 负载往返不变', () => {
    const header: MatrixHeader = { frames: 3, vocabSize: 35, duration: 6.25 };
    const logProbs = matrix(3, 35);

    const { header: back, logProbs: probs } = decodeMatrix(encodeMatrix(header, logProbs));

    expect(back).toEqual(header);
    expect(Array.from(probs)).toEqual(Array.from(logProbs));
  });

  it('负载起点永远是 4 的倍数 —— 客户端靠它零拷贝', () => {
    // duration 的位数会改变头部 JSON 的长度，四种余数都要走到。
    for (const duration of [1, 12, 123, 1234, 1.5, 12.25, 123.125, 1234.0625]) {
      const bytes = encodeMatrix({ frames: 2, vocabSize: 35, duration }, matrix(2, 35));
      const jsonBytes = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
      expect((4 + jsonBytes) % 4, `duration=${duration}`).toBe(0);
      expect(() => decodeMatrix(bytes)).not.toThrow();
    }
  });

  it('补的是空格，JSON 照样解得开', () => {
    const bytes = encodeMatrix({ frames: 1, vocabSize: 1, duration: 1 }, matrix(1, 1));
    const jsonBytes = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    const text = new TextDecoder().decode(bytes.subarray(4, 4 + jsonBytes));
    expect(text).toMatch(/^\{.*\} *$/);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('总长度 = 4 + 头部 + 帧数 × 词表 × 4', () => {
    const bytes = encodeMatrix({ frames: 7, vocabSize: 35, duration: 1 }, matrix(7, 35));
    const jsonBytes = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    expect(bytes.byteLength).toBe(4 + jsonBytes + 7 * 35 * 4);
  });

  it('float32 原样过去，不做量化 —— log-prob 的量级横跨 -30..0', () => {
    const logProbs = Float32Array.from([-0.0234375, -12.5, -29.75, 0]);
    const { logProbs: back } = decodeMatrix(
      encodeMatrix({ frames: 4, vocabSize: 1, duration: 0.08 }, logProbs),
    );
    expect(Array.from(back)).toEqual(Array.from(logProbs));
  });

  it('空矩阵也编得出来（0 帧不该炸在这一层）', () => {
    const bytes = encodeMatrix({ frames: 0, vocabSize: 35, duration: 0 }, new Float32Array(0));
    expect(decodeMatrix(bytes).logProbs).toHaveLength(0);
  });

  it('对一课的量级（24000 帧 × 35）仍然正确，大小约 3.2MB', () => {
    const frames = 24_000;
    const bytes = encodeMatrix(
      { frames, vocabSize: 35, duration: frames * 0.02 },
      new Float32Array(frames * 35),
    );
    expect(bytes.byteLength).toBeGreaterThan(3_300_000);
    expect(bytes.byteLength).toBeLessThan(3_400_000);
    expect(decodeMatrix(bytes).header.frames).toBe(frames);
  });
});

describe('content type', () => {
  it('不是 application/json —— 客户端按它决定走二进制那条路', () => {
    expect(MATRIX_CONTENT_TYPE).toBe('application/x-emission-matrix');
  });
});
