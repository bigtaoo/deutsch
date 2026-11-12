// 跟读的逐词高亮（FR-6.9 / §12.17）。
//
// 起因（2026-11-12 的反馈）：通听里早就有逐词高亮，跟读里一直是一块平文本 ——
// 而跟读才是每天都在用的那一页。
//
// 这个文件守两件事，它们是一体的：
//   1. **原句在响的时候，当前词要看得出来**，而且底色不许和卡片底同色（变更 58 的教训）；
//   2. **原句不在响的时候，一个词都不许亮**。静默间隔是该自己开口的那几秒，
//      屏幕上留着一个亮着的词就是在撒谎（时间戳停在上一句末尾，它指的根本不是现在）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ShadowingTab } from './ShadowingTab';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/db/meta';
import type { Lesson, Sentence } from '@/types/models';

// 订阅进来的时间回调 + 最近一次 playRange 的 onEnded：jsdom 里既没有音频也没有真时钟，
// 「这一句放完了」只能由测试自己喊。
let tick: ((time: number) => void) | null = null;
let onEnded: (() => void) | null = null;

vi.mock('@/audio/player', () => ({
  audioPlayer: {
    subscribe: (fn: (time: number) => void) => {
      tick = fn;
      return () => {
        tick = null;
      };
    },
    playRange: vi.fn(async (_s: number, _e: number, opts: { onEnded: () => void }) => {
      onEnded = opts.onEnded;
    }),
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

// 麦克风整条不参与这个文件：`echoSupported` 回 false，录音那一遍就不存在，
// 相位只会在 playing / gap 之间走 —— 正是要验的那两档。
vi.mock('@/audio/echo', () => ({
  MicEcho: class {
    isOpen = false;
    open = vi.fn(async () => {});
    close = vi.fn();
    start = vi.fn(async () => {});
    stop = vi.fn(async () => null);
    play = vi.fn(async () => {});
    halt = vi.fn();
  },
  echoSupported: vi.fn(async () => false),
  describeMicError: (err: unknown) => String(err),
}));

// 音频 Blob 必须有：没有它「开始跟读」是禁用的，整条路都走不到。
vi.mock('@/db/cache', () => ({ getAudioBlob: vi.fn(async () => new Blob(['x'])) }));

function sentence(
  index: number,
  text: string,
  start: number,
  end: number,
  words: [string, number, number][],
): Sentence {
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

function lessonWith(sentences: Sentence[]): Lesson {
  return {
    id: 'l1',
    title: 'Auch Polizisten brauchen mal Hilfe',
    source: { type: 'manual' },
    audioDuration: 30,
    sentences,
    createdAt: 0,
    updatedAt: 0,
  };
}

const LESSON = lessonWith([
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
]);

beforeEach(() => {
  // 只清调用记录，不动实现（`resetAllMocks` 会把 playRange 变成返回 undefined 的空壳）。
  vi.clearAllMocks();
  tick = null;
  onEnded = null;
  useLessonStore.setState({ lessons: [LESSON], caches: { l1: { lessonId: 'l1', hasAudio: true, audioBytes: 1024, fetchedAt: 0 } } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
});

/** 渲染 + 等音频就绪 + 点「开始跟读」—— 走完这三步相位就是 playing。 */
async function startShadowing(lesson: Lesson = LESSON) {
  render(<ShadowingTab lesson={lesson} cache={undefined} />);
  await act(async () => {}); // useLessonAudio 读 Blob 是异步的
  await act(async () => {
    screen.getByText('开始跟读').click();
  });
}

describe('ShadowingTab — 原句播放时的逐词高亮', () => {
  it('当前词亮起来，而且是反白而不是卡片底色（手机上字重看不出来）', async () => {
    await startShadowing();
    await act(async () => {
      tick?.(3.2); // 第一句的 "jeder"
    });

    const word = screen.getByText('jeder');
    expect(word).toHaveAttribute('data-active');
    // §12.17：warn 实底 + surface 字。退回 `bg-warn-soft` 或只留 font-medium 这条就红。
    expect(word.className).toContain('bg-warn');
    expect(word.className).not.toContain('bg-warn-soft');
    expect(word.className).toContain('text-surface');
  });

  it('高亮跟着时间走，同一时刻只有一个当前词', async () => {
    await startShadowing();
    await act(async () => {
      tick?.(3.2);
    });
    expect(screen.getByText('jeder')).toHaveAttribute('data-active');
    expect(document.querySelectorAll('[data-active]')).toHaveLength(1);

    await act(async () => {
      tick?.(4.5); // 走到 "Situation"
    });
    expect(screen.getByText('Situation')).toHaveAttribute('data-active');
    expect(screen.getByText('jeder')).not.toHaveAttribute('data-active');
  });

  it('整句原文一个字不少 —— 高亮是贴上去的属性，不许吃掉标点或空白', async () => {
    await startShadowing();
    await act(async () => {
      tick?.(3.2);
    });
    // 逐词渲染之后整句被拆成了一串 <span>，所以要看整段的 textContent，
    // 而不是 getByText —— 后者只在单个元素里找。
    expect(screen.getByText('jeder').closest('p')!.textContent).toContain(
      'Stärke zeigen in jeder Situation',
    );
  });
});

describe('ShadowingTab — 不该高亮的那几档', () => {
  it('静默间隔里一个词都不亮 —— 那是该自己开口的时候', async () => {
    await startShadowing();
    await act(async () => {
      tick?.(4.5);
    });
    expect(document.querySelectorAll('[data-active]')).toHaveLength(1);

    // 原句放完 → 进入静默间隔（录音关着，所以是普通的 gap）
    await act(async () => {
      onEnded?.();
    });
    expect(screen.getByText(/现在跟读/)).toBeTruthy();
    expect(document.querySelectorAll('[data-active]')).toHaveLength(0);
  });

  it('还没开始跟读时不亮', async () => {
    render(<ShadowingTab lesson={LESSON} cache={undefined} />);
    await act(async () => {});
    await act(async () => {
      tick?.(3.2);
    });
    expect(document.querySelectorAll('[data-active]')).toHaveLength(0);
  });

  it('只有句级时间戳的课不亮，而且明说为什么（否则会被当成界面坏了来报）', async () => {
    const lesson = lessonWith([
      { ...sentence(0, 'Nur auf Satzebene', 0, 5, []), words: undefined },
    ]);
    cleanup();
    useLessonStore.setState({ lessons: [lesson] });
    await startShadowing(lesson);

    await act(async () => {
      tick?.(2);
    });
    expect(document.querySelectorAll('[data-active]')).toHaveLength(0);
    expect(screen.getByText(/只有句级时间戳/)).toBeTruthy();
    // 文本本身照样要在
    expect(screen.getByText(/Nur auf Satzebene/)).toBeTruthy();
  });

  it('词级时间戳齐全时不摆那条提示（§12.3：一切正常就静默）', async () => {
    await startShadowing();
    expect(screen.queryByText(/只有句级时间戳/)).toBeNull();
  });
});
