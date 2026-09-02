import { describe, expect, it } from 'vitest';
import {
  LONGEST_SENTENCE_CHARS,
  SLOWEST_CHARS_PER_SECOND,
  WINDOW_DEFAULTS,
  alignWindowed,
} from './windowed';
import { forcedAlign } from './viterbi';

const V = 16;

/**
 * 造一段有已知真值的音频：token i 占 dur 帧，之后插 gap 帧 blank。
 * 返回 log-prob 与每个 token 的真实帧区间。
 */
function synth(targets: number[], dur: number, gap: number) {
  const frames: number[] = [];
  const truth: Array<[number, number]> = [];
  for (const token of targets) {
    const start = frames.length;
    for (let i = 0; i < dur; i++) frames.push(token);
    truth.push([start, frames.length]);
    for (let i = 0; i < gap; i++) frames.push(0);
  }
  const logProbs = new Float32Array(frames.length * V).fill(-20);
  frames.forEach((token, t) => {
    logProbs[t * V + token] = -0.01;
  });
  return { logProbs, frames: frames.length, truth };
}

/**
 * 伪随机但确定的 token 序列，含相邻重复（考验 CTC 的 blank 约束）。
 *
 * 用 xorshift 并取**高位**：换成 LCG 取低位会让序列退化成几十个相同 token，
 * 那时「N 个相同 token 对 M 个相同发音块」是真歧义，任何单调分配得分都一样，
 * 于是测试断言的其实是对齐器的任意选择，什么都测不到。踩过一次，记在这。
 */
function targetsOf(n: number): Int32Array {
  const out = new Int32Array(n);
  let x = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = 4 + (((x >>> 16) & 0xffff) % (V - 4));
  }
  return out;
}

describe('alignWindowed', () => {
  it('格子数够小时走整段对齐，结果与 forcedAlign 完全一致', () => {
    const targets = targetsOf(20);
    const { logProbs, frames } = synth([...targets], 3, 2);
    const full = forcedAlign(logProbs, frames, V, targets);
    const windowed = alignWindowed(logProbs, frames, V, targets, { fullAlignCells: 1e9 });
    expect(windowed.spans).toEqual(full.spans);
  });

  it('被迫滑窗时仍然恢复出全部 token 的真实边界', () => {
    const targets = targetsOf(600);
    const { logProbs, frames, truth } = synth([...targets], 3, 2);
    const { spans } = alignWindowed(logProbs, frames, V, targets, {
      fullAlignCells: 20_000, // 强制滑窗
      windowFrames: 250,
    });
    expect(spans).toHaveLength(targets.length);
    // 真值区间内必定被覆盖到；允许 span 向 blank 侧多吃一点
    spans.forEach((span, i) => {
      const [ts, te] = truth[i];
      expect(span.startFrame).toBeLessThanOrEqual(ts);
      expect(span.endFrame).toBeGreaterThanOrEqual(te);
    });
  });

  it('滑窗结果与整段对齐结果一致（同一批输入两条路径互校）', () => {
    const targets = targetsOf(300);
    const { logProbs, frames } = synth([...targets], 3, 2);
    const full = forcedAlign(logProbs, frames, V, targets);
    const windowed = alignWindowed(logProbs, frames, V, targets, {
      fullAlignCells: 10_000,
      windowFrames: 200,
    });
    expect(windowed.spans.map((s) => s.startFrame)).toEqual(full.spans.map((s) => s.startFrame));
  });

  it('语速突变（后半段快一倍）也不丢 token', () => {
    const targets = targetsOf(400);
    const slow = synth([...targets.subarray(0, 200)], 6, 4);
    const fast = synth([...targets.subarray(200)], 2, 1);
    const frames = slow.frames + fast.frames;
    const logProbs = new Float32Array(frames * V);
    logProbs.set(slow.logProbs, 0);
    logProbs.set(fast.logProbs, slow.frames * V);
    const { spans } = alignWindowed(logProbs, frames, V, targets, {
      fullAlignCells: 20_000,
      windowFrames: 250,
    });
    expect(spans).toHaveLength(400);
    let prevEnd = 0;
    for (const s of spans) {
      expect(s.startFrame).toBeGreaterThanOrEqual(prevEnd);
      expect(s.endFrame).toBeGreaterThan(s.startFrame);
      prevEnd = s.endFrame;
    }
  });

  it('区间始终单调不重叠，且覆盖每一个 token', () => {
    const targets = targetsOf(500);
    const { logProbs, frames } = synth([...targets], 4, 3);
    const { spans } = alignWindowed(logProbs, frames, V, targets, {
      fullAlignCells: 15_000,
      windowFrames: 300,
    });
    expect(spans).toHaveLength(500);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].startFrame).toBeGreaterThanOrEqual(spans[i - 1].endFrame);
    }
  });

  it('报告进度，且最终到 1', () => {
    const targets = targetsOf(300);
    const { logProbs, frames } = synth([...targets], 3, 2);
    const seen: number[] = [];
    alignWindowed(logProbs, frames, V, targets, {
      fullAlignCells: 10_000,
      windowFrames: 200,
      onProgress: (f) => seen.push(f),
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBeCloseTo(1);
    // 单调不减
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('空目标返回空结果', () => {
    expect(alignWindowed(new Float32Array(0), 0, V, new Int32Array(0)).spans).toEqual([]);
  });
});

// ── 为什么这里钉的是「窗口装不装得下最长的句子」而不是钉住 6000 这个数 ──
// 窗口太短的真实后果是逐窗漂移，最后把一堆 token 挤成「一句 50 字符/秒」
// （2026-09-02 三课实测，数字记在 windowed.ts 的 WINDOW_DEFAULTS 上面）。
// 那个失败**造不出可信的单测**：试过用合成矩阵复现，匀速矩阵漂 0；
// 加了速率摆动仍然漂 0（合成的后验太「确定」，声学把一切钉死了）；
// 把正确 token 的概率压到 0.25（比真实模型还差）才在 30 秒窗上漂出 144 帧，
// 而 120 秒窗仍然是 0 —— 方向对，量级差太远，而且要 4000 个 token 才出得来，
// 一条测试就把整个 suite 的时间翻倍。所以不留那条测试，只钉住这条**能解释那个数的不变量**：
// 窗口必须装得下实测最长的句子还有余，否则「估歪的 token 数」就与「一整句」同量级。
describe('窗口长度的下限', () => {
  it('默认窗口装得下实测最长的句子，还留出一倍余量', () => {
    const longestSentenceFrames =
      (LONGEST_SENTENCE_CHARS / SLOWEST_CHARS_PER_SECOND) * 50;
    // 一倍余量：窗口里至少要能同时放下「最长句 + 它前后的上下文」，
    // 否则速率估计的误差没有地方被 tailDiscard 吸收。
    expect(WINDOW_DEFAULTS.windowFrames).toBeGreaterThanOrEqual(longestSentenceFrames * 2);
  });

  it('最坏情况下的回溯缓冲仍然是手机能吃下的量级', () => {
    // 缓冲 = windowFrames × (2×winTokens+1) 字节，而 winTokens 受 fullAlignCells 兜住 ——
    // 收尾窗那一把是这条路径上最大的一次分配。
    expect(WINDOW_DEFAULTS.fullAlignCells).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
