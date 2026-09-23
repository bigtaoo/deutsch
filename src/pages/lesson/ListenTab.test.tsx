// 通听的逐词高亮（FR-5.3）—— 这个文件只守一件事：**当前词必须看得出来**。
//
// 写它的起因是一个只在 iPhone 上出现的症状（§0 变更 58）：当前词原来用的是
// `bg-warn-soft`，而它所在的当前行底色**正是** `bg-warn-soft` —— 两者同色，
// 剩下的差别只有一档字重（font-medium）。Windows 上 400/500 一眼可辨，
// iPhone 的 SF Pro 在 19px 下几乎看不出来，于是「网页上有高亮、手机上没有」。
//
// 所以这里的断言故意写成**两个类之间的关系**，而不是「等于某个类名」：
// 当前词的底色不许是当前行的底色。换别的配色照样过，退回同色就红。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ListenTab } from './ListenTab';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/db/meta';
import type { Lesson, Sentence } from '@/types/models';

// 订阅进来的时间回调存在这里，测试自己推播放位置 —— jsdom 里既没有音频也没有 rAF 的真时钟。
let tick: ((time: number) => void) | null = null;

vi.mock('@/audio/player', () => ({
  audioPlayer: {
    subscribe: (fn: (time: number) => void) => {
      tick = fn;
      return () => {
        tick = null;
      };
    },
    element: () => document.createElement('audio'),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    load: vi.fn(async () => {}),
    seek: vi.fn(),
    setRate: vi.fn(),
    duration: 30,
    currentTime: 0,
    paused: true,
    loadedLessonId: null,
  },
  readAudioDuration: vi.fn(async () => 30),
}));

// 音频 Blob 不在这条路径上：没有它这一页照样要把文本和高亮画对（播放条自己说「素材未下载」）。
vi.mock('@/db/cache', () => ({ getAudioBlob: vi.fn(async () => undefined) }));

function sentence(index: number, text: string, start: number, end: number, words: [string, number, number][]): Sentence {
  return {
    index,
    text,
    charStart: 0,
    charEnd: text.length,
    startTime: start,
    endTime: end,
    endTimeExplicit: true,
    timingSource: 'auto',
    blanks: [],
    markedDifficult: false,
    excluded: false,
    words: words.map(([w, s, e]) => ({
      charStart: text.indexOf(w),
      charEnd: text.indexOf(w) + w.length,
      start: s,
      end: e,
    })),
  };
}

const LESSON: Lesson = {
  id: 'l1',
  title: 'Auch Polizisten brauchen mal Hilfe',
  source: { type: 'manual' },
  audioDuration: 30,
  sentences: [
    sentence(0, 'Stärke zeigen in jeder Situation', 0, 5, [
      ['Stärke', 0, 1],
      ['zeigen', 1, 2],
      ['in', 2, 3],
      ['jeder', 3, 4],
      ['Situation', 4, 5],
    ]),
    sentence(1, 'Was aber wenn die Beamten Hilfe brauchen', 5, 10, [
      ['Was', 5, 6],
      ['aber', 6, 7],
      ['wenn', 7, 8],
    ]),
  ],
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  // jsdom 没有 Element.scrollTo（自动滚动那条 effect 每次高亮换行都会调它）
  Element.prototype.scrollTo = vi.fn();
  tick = null;
  useLessonStore.setState({ lessons: [LESSON], caches: {} });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
});

async function expand(time: number) {
  render(<ListenTab lesson={LESSON} cache={undefined} />);
  await act(async () => {
    screen.getByText('展开文本').click();
  });
  await act(async () => {
    tick?.(time);
  });
}

describe('ListenTab — 逐词高亮', () => {
  it('当前词的底色不等于当前行的底色（否则手机上只剩字重可看）', async () => {
    await expand(3.2); // 第一句的 "jeder"

    const word = screen.getByText('jeder');
    const line = word.closest('li')!;

    expect(word).toHaveAttribute('data-active');
    // 行确实是「当前行」那一档
    expect(line.className).toContain('bg-warn-soft');
    // 而词的底色不许是同一个令牌 —— 这正是变更 58 修掉的那个坏法
    expect(word.className).toContain('bg-warn');
    expect(word.className).not.toContain('bg-warn-soft');
  });

  it('高亮跟着时间走，同一时刻只有一个词是当前词', async () => {
    await expand(3.2);
    expect(screen.getByText('jeder')).toHaveAttribute('data-active');
    expect(document.querySelectorAll('[data-active]')).toHaveLength(1);

    await act(async () => {
      tick?.(4.5); // 走到 "Situation"
    });
    expect(screen.getByText('Situation')).toHaveAttribute('data-active');
    expect(screen.getByText('jeder')).not.toHaveAttribute('data-active');
  });

  it('播放位置落在句间空档时不标任何词（只留「刚读完」那一行）', async () => {
    await expand(3.2);

    await act(async () => {
      tick?.(12); // 两句都结束了
    });
    expect(document.querySelectorAll('[data-active]')).toHaveLength(0);
  });
});
