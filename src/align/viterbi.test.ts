import { describe, expect, it } from 'vitest';
import { forcedAlign } from './viterbi';

/** 造一段「确定性」的 log-prob：每帧指定一个必胜 token，其余极低。 */
function emissions(frames: number[], vocabSize: number): Float32Array {
  const out = new Float32Array(frames.length * vocabSize).fill(-20);
  frames.forEach((token, t) => {
    out[t * vocabSize + token] = -0.01;
  });
  return out;
}

const V = 8;

describe('forcedAlign', () => {
  it('把每个 token 对到它实际出现的帧上', () => {
    // 目标 [4,5,6]；帧序列 blank blank 4 4 4 blank 5 6 6 blank
    const frames = [0, 0, 4, 4, 4, 0, 5, 6, 6, 0];
    const { spans } = forcedAlign(emissions(frames, V), frames.length, V, [4, 5, 6]);
    expect(spans.map((s) => [s.startFrame, s.endFrame])).toEqual([
      [2, 5],
      [6, 7],
      [7, 9],
    ]);
  });

  it('双写字母之间必须夹 blank —— 这是 CTC 的核心约束', () => {
    // 目标 [5,5]（如 "ll"）。只有 5 5 是非法的：解码时会折叠成一个 5。
    // 合法的最短形式是 5 blank 5，所以两个 span 必须分居 blank 两侧。
    const frames = [5, 5, 0, 5, 5];
    const { spans } = forcedAlign(emissions(frames, V), frames.length, V, [5, 5]);
    expect(spans[0].endFrame).toBeLessThanOrEqual(2);
    expect(spans[1].startFrame).toBeGreaterThanOrEqual(3);
  });

  it('不同字母之间可以不夹 blank', () => {
    const frames = [4, 5];
    const { spans } = forcedAlign(emissions(frames, V), frames.length, V, [4, 5]);
    expect(spans.map((s) => [s.startFrame, s.endFrame])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it('每个 token 都拿到至少一帧，且区间单调不重叠', () => {
    const targets = [4, 5, 6, 5, 5, 7, 4, 4];
    // 故意给一段完全模糊的音频：全帧等概率，逼它在无信息时也产出合法路径
    const frames = 40;
    const flat = new Float32Array(frames * V).fill(Math.log(1 / V));
    const { spans } = forcedAlign(flat, frames, V, targets);
    expect(spans).toHaveLength(targets.length);
    let prevEnd = 0;
    for (const s of spans) {
      expect(s.endFrame).toBeGreaterThan(s.startFrame);
      expect(s.startFrame).toBeGreaterThanOrEqual(prevEnd);
      prevEnd = s.endFrame;
    }
  });

  it('帧数放不下目标时报错，而不是编一条路径出来', () => {
    const flat = new Float32Array(3 * V).fill(-1);
    // [4,4,4] 需要 4 4 之间各一个 blank，至少 5 帧
    expect(() => forcedAlign(flat, 3, V, [4, 4, 4])).toThrow(/帧数不足/);
  });

  it('空目标返回空结果', () => {
    expect(forcedAlign(new Float32Array(0), 0, V, []).spans).toEqual([]);
  });

  it('对齐得上的段落分数明显高于对不上的', () => {
    const frames = [4, 4, 0, 5, 5, 0, 6, 6];
    const good = forcedAlign(emissions(frames, V), frames.length, V, [4, 5, 6]);
    const bad = forcedAlign(emissions(frames, V), frames.length, V, [7, 7, 7]);
    expect(good.score).toBeGreaterThan(bad.score);
  });
});
