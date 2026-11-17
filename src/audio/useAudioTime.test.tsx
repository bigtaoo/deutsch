// 变更 93：播放位置的两个闸门。
//
// 判据是**渲染次数**，不是时间值本身 —— 这两个闸门存在的全部理由就是
// 「别让整棵子树跟着音频每秒重渲染 60 次」。所以每条用例都数渲染。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useAudioTime } from './useLessonAudio';

const subscribers = new Set<(t: number) => void>();

vi.mock('./player', () => ({
  audioPlayer: {
    subscribe: (fn: (t: number) => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  },
}));

const emit = (t: number) => act(() => subscribers.forEach((fn) => fn(t)));

beforeEach(() => subscribers.clear());

function probe(options?: Parameters<typeof useAudioTime>[0]) {
  const renders = { count: 0, last: 0 };
  function Probe() {
    renders.count += 1;
    renders.last = useAudioTime(options);
    return null;
  }
  const view = render(<Probe />);
  return { renders, view };
}

describe('useAudioTime', () => {
  it('默认按帧：每一次推送都重渲染（逐词高亮要的就是这个）', () => {
    const { renders } = probe();
    const before = renders.count;
    emit(0.01);
    emit(0.02);
    emit(0.03);
    expect(renders.count).toBe(before + 3);
    expect(renders.last).toBeCloseTo(0.03);
  });

  it('quantizeMs：同一格里的推送一次都不重渲染', () => {
    const { renders } = probe({ quantizeMs: 100 });
    emit(0.0);
    const before = renders.count;
    // 0.00~0.09 全落在第一格里
    emit(0.01);
    emit(0.05);
    emit(0.099);
    expect(renders.count).toBe(before);
    expect(renders.last).toBeCloseTo(0);
  });

  it('quantizeMs：跨过一格才重渲染一次，值是这一格的起点', () => {
    const { renders } = probe({ quantizeMs: 100 });
    emit(0.05);
    const before = renders.count;
    emit(0.12);
    expect(renders.count).toBe(before + 1);
    expect(renders.last).toBeCloseTo(0.1);
  });

  it('enabled: false 时压根不订阅 —— 文本折叠的通听页据此退出这条链', () => {
    const { renders } = probe({ enabled: false });
    expect(subscribers.size).toBe(0);
    const before = renders.count;
    emit(1.23);
    expect(renders.count).toBe(before);
    expect(renders.last).toBe(0);
  });

  it('卸载时退订 —— 订阅漏了就是「学久了越来越卡」的那一类', () => {
    const { view } = probe({ quantizeMs: 100 });
    expect(subscribers.size).toBe(1);
    view.unmount();
    expect(subscribers.size).toBe(0);
  });
});
