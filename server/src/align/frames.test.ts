// 这一组期望值与前端 `src/align/emissions.test.ts` 是**同一组**（那边测的是同一套数学的
// 浏览器副本）。三份实现（浏览器 / Swift / 这里）里，只有这两份能用单测钉住 ——
// 所以这个文件的作用不是「测一遍纯函数」，而是**在两份拷贝之间充当契约**：
// 谁改了分块或帧号，两边的期望值必须一起变，否则同一课在不同机器上会得到不同的时间戳。

import { describe, expect, it } from 'vitest';
import { logSoftmaxInPlace, normalizeChunk, planChunks, NORMALIZE_EPS } from './frames.ts';

const SR = 16000;
const STRIDE = 320;

describe('planChunks', () => {
  it('短音频只出一块，采用区间就是全部', () => {
    const samples = 10 * SR;
    const chunks = planChunks(samples, SR, STRIDE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].keepFrameStart).toBe(0);
    expect(chunks[0].keepFrameEnd).toBe(samples / STRIDE);
  });

  it('采用区间恰好无缝铺满全部帧 —— 不重叠、不漏帧', () => {
    const samples = 376 * SR; // 6 分 16 秒，一期 Alltagsdeutsch 的长度
    const totalFrames = Math.floor(samples / STRIDE);
    const chunks = planChunks(samples, SR, STRIDE);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].keepFrameStart).toBe(0);
    expect(chunks[chunks.length - 1].keepFrameEnd).toBe(totalFrames);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].keepFrameStart).toBe(chunks[i - 1].keepFrameEnd);
    }
  });

  it('内部块两侧都丢掉了重叠的一半（边界帧不采用）', () => {
    const chunks = planChunks(376 * SR, SR, STRIDE, 20, 2);
    const mid = chunks[1];
    expect(mid.keepFrameStart).toBe(Math.floor((mid.sampleStart + SR) / STRIDE));
    expect(mid.keepFrameEnd).toBe(Math.floor((mid.sampleEnd - SR) / STRIDE));
  });

  it('时长刚好等于一块时不产生空尾块', () => {
    expect(planChunks(20 * SR, SR, STRIDE, 20, 2)).toHaveLength(1);
  });

  it('一期八分钟切成 27 块 —— 这个数就是界面上进度条的分母', () => {
    // 480 秒 / 18 秒步长。KICKOFF 里那个「27 块」的估算依据在这里钉住。
    expect(planChunks(480 * SR, SR, STRIDE, 20, 2)).toHaveLength(27);
  });
});

describe('logSoftmaxInPlace', () => {
  it('每帧的 exp 之和为 1', () => {
    const V = 5;
    const data = new Float32Array([1, 2, 3, 4, 5, -1, 0, 1, 0, -1]);
    logSoftmaxInPlace(data, 2, V);
    for (let t = 0; t < 2; t++) {
      let sum = 0;
      for (let v = 0; v < V; v++) sum += Math.exp(data[t * V + v]);
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('大 logit 不溢出（减最大值那步在起作用）', () => {
    const data = new Float32Array([800, 799, 0]);
    logSoftmaxInPlace(data, 1, 3);
    for (const x of data) expect(Number.isFinite(x)).toBe(true);
    expect(data[0]).toBeCloseTo(Math.log(1 / (1 + Math.exp(-1) + Math.exp(-800))), 5);
  });
});

describe('normalizeChunk', () => {
  it('零均值、单位方差（wav2vec2 的 do_normalize）', () => {
    const input = new Float32Array([1, 2, 3, 4, 5]);
    const out = normalizeChunk(input);
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    const variance = out.reduce((a, b) => a + (b - mean) ** 2, 0) / out.length;
    expect(mean).toBeCloseTo(0, 5);
    expect(variance).toBeCloseTo(1, 4);
  });

  it('**不就地改**输入 —— 相邻块共享同一段重叠，就地改会把它归一化两次', () => {
    const input = new Float32Array([1, 2, 3, 4, 5]);
    normalizeChunk(input);
    expect(Array.from(input)).toEqual([1, 2, 3, 4, 5]);
  });

  it('全静音不产生 NaN（eps 兜住了除零）', () => {
    const out = normalizeChunk(new Float32Array(100));
    for (const x of out) expect(x).toBe(0);
    expect(NORMALIZE_EPS).toBeGreaterThan(0);
  });
});
