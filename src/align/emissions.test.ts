import { describe, expect, it } from 'vitest';
import { logSoftmaxInPlace, planChunks } from './emissions';

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
    // 6 分 16 秒，就是一期 Alltagsdeutsch 的长度
    const samples = 376 * SR;
    const totalFrames = Math.floor(samples / STRIDE);
    const chunks = planChunks(samples, SR, STRIDE);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].keepFrameStart).toBe(0);
    expect(chunks[chunks.length - 1].keepFrameEnd).toBe(totalFrames);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].keepFrameStart).toBe(chunks[i - 1].keepFrameEnd);
    }
  });

  it('每个采用区间都落在本块的推理范围内 —— 否则搬运时会越界', () => {
    const samples = 376 * SR;
    for (const c of planChunks(samples, SR, STRIDE)) {
      expect(c.keepFrameStart).toBeGreaterThanOrEqual(Math.floor(c.sampleStart / STRIDE));
      expect(c.keepFrameEnd).toBeLessThanOrEqual(Math.ceil(c.sampleEnd / STRIDE));
      expect(c.keepFrameEnd).toBeGreaterThan(c.keepFrameStart);
    }
  });

  it('内部块两侧都丢掉了重叠的一半（边界帧不采用）', () => {
    const chunks = planChunks(376 * SR, SR, STRIDE, 20, 2);
    const mid = chunks[1];
    // 该块推理 [sampleStart, sampleEnd)，但只采用向内缩 1 秒（50 帧）后的部分
    expect(mid.keepFrameStart).toBe(Math.floor((mid.sampleStart + SR) / STRIDE));
    expect(mid.keepFrameEnd).toBe(Math.floor((mid.sampleEnd - SR) / STRIDE));
  });

  it('时长刚好等于一块时不产生空尾块', () => {
    const chunks = planChunks(20 * SR, SR, STRIDE, 20, 2);
    expect(chunks).toHaveLength(1);
  });

  it('时长略超一块时第二块仍然有效', () => {
    const samples = 21 * SR;
    const chunks = planChunks(samples, SR, STRIDE, 20, 2);
    expect(chunks[chunks.length - 1].keepFrameEnd).toBe(Math.floor(samples / STRIDE));
    for (const c of chunks) expect(c.sampleEnd).toBeGreaterThan(c.sampleStart);
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

  it('全是 log 域负值，最大项对应原始最大 logit', () => {
    const V = 4;
    const data = new Float32Array([0.5, 9, -3, 1]);
    logSoftmaxInPlace(data, 1, V);
    expect(Math.max(...data)).toBe(data[1]);
    for (const x of data) expect(x).toBeLessThanOrEqual(0);
  });

  it('大 logit 不溢出（减最大值那步在起作用）', () => {
    const V = 3;
    const data = new Float32Array([1000, 1001, 999]);
    logSoftmaxInPlace(data, 1, V);
    for (const x of data) expect(Number.isFinite(x)).toBe(true);
    expect(Math.exp(data[1])).toBeCloseTo(0.665, 2);
  });

  it('均匀 logit 给出 log(1/V)', () => {
    const V = 8;
    const data = new Float32Array(V).fill(3);
    logSoftmaxInPlace(data, 1, V);
    for (const x of data) expect(x).toBeCloseTo(Math.log(1 / V), 6);
  });
});
