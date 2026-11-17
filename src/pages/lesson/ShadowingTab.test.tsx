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
import { audioPlayer } from '@/audio/player';
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

// jsdom 在这套配置下不给 localStorage（opaque origin，见 align/journal.test.ts），自己给一个。
// FR-6.11 的进度就记在这里面，**必须每个用例之间清掉**：不清的话上一个用例练到第 2 句，
// 下一个用例打开就是「继续跟读」，`getByText('开始跟读')` 当场找不到。
const localStore = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => void localStore.delete(k),
});

beforeEach(() => {
  // 只清调用记录，不动实现（`resetAllMocks` 会把 playRange 变成返回 undefined 的空壳）。
  vi.clearAllMocks();
  localStore.clear();
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

describe('ShadowingTab — 换句之前的那一口气（FR-6.10）', () => {
  it('这一秒里卡片已经是下一句，但一个音都没响、一个词都不亮', async () => {
    vi.useFakeTimers();
    try {
      await startShadowing();
      await act(async () => {
        tick?.(4.5); // 第一句的最后一个词
      });
      expect(document.querySelectorAll('[data-active]')).toHaveLength(1);

      await act(async () => {
        onEnded?.(); // 原句放完 → 静默间隔
      });
      await act(async () => {
        vi.advanceTimersByTime(6000); // 间隔到点（5 秒的句子 × 1.2）→ 本该直接读下一句
      });

      // 卡片当场换成第二句：换句的信号不只是「停了一下」，而是「你看，下一句」。
      expect(document.body.textContent).toContain('Was aber wenn die Beamten Hilfe brauchen');
      // 但这一秒里主播放器一声没响，也不该有哪个词亮着。
      expect(vi.mocked(audioPlayer.playRange)).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll('[data-active]')).toHaveLength(0);

      await act(async () => {
        vi.advanceTimersByTime(1000); // 一口气过去了
      });
      expect(vi.mocked(audioPlayer.playRange)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(audioPlayer.playRange).mock.calls[1]!.slice(0, 2)).toEqual([5, 10]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// FR-6.11（变更 92）：练到第几句要留得住。
//
// 他报的原话：「学了一多半了，然后关闭 app 或者去看了一个信息，回来后跟读的进度没了，
// 又要从头开始」。根子是切后台走的 `stop()` 把位置清成了 -1 —— 所以这里守的不是
// 「存得对不对」（那在 lesson/shadowingProgress.test.ts），而是**界面上回得去**。
describe('ShadowingTab — 练到第几句留得住（FR-6.11）', () => {
  /** 切后台：和真机一样先把 document.hidden 改掉，再发事件。 */
  async function goBackground() {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    if (original) Object.defineProperty(document, 'hidden', original);
  }

  /** 开始跟读，再按 → 走到第 2 句。 */
  async function startAndAdvance() {
    await startShadowing();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(document.body.textContent).toContain('Was aber wenn die Beamten Hilfe brauchen');
  }

  it('切后台回来：停在第 2 句，按钮写「继续跟读」而不是「开始跟读」', async () => {
    await startAndAdvance();
    await goBackground();

    expect(screen.getByText('继续跟读（第 2 句）')).toBeInTheDocument();
    expect(screen.queryByText('开始跟读')).toBeNull();
    // 卡片没被清空 —— 回来时看得见停在哪一句
    expect(document.body.textContent).toContain('Was aber wenn die Beamten Hilfe brauchen');
    expect(document.body.textContent).toContain('停在这一句');
    // 停着的时候不报遍数：那时 pass 是 0，「第 0 遍」只会让人以为坏了
    expect(document.body.textContent).not.toContain('第 0 遍');
  });

  it('点「继续跟读」从停住的那一句接着放，不是从第一句', async () => {
    await startAndAdvance();
    await goBackground();
    vi.mocked(audioPlayer.playRange).mockClear();

    await act(async () => {
      screen.getByText('继续跟读（第 2 句）').click();
    });
    expect(vi.mocked(audioPlayer.playRange).mock.calls[0]!.slice(0, 2)).toEqual([5, 10]);
  });

  it('关掉再打开（组件重挂载）：进度从本机读回来', async () => {
    await startAndAdvance();
    await goBackground();
    cleanup();

    render(<ShadowingTab lesson={LESSON} cache={undefined} />);
    await act(async () => {});
    expect(screen.getByText('继续跟读（第 2 句）')).toBeInTheDocument();
  });

  it('「从头开始」把记下的那一句清掉，下次打开又是「开始跟读」', async () => {
    await startAndAdvance();
    await goBackground();

    await act(async () => {
      screen.getByText('从头开始').click();
    });
    expect(vi.mocked(audioPlayer.playRange).mock.calls.at(-1)!.slice(0, 2)).toEqual([0, 5]);

    await goBackground();
    cleanup();
    render(<ShadowingTab lesson={LESSON} cache={undefined} />);
    await act(async () => {});
    expect(screen.getByText('开始跟读')).toBeInTheDocument();
  });

  it('第一句上没有「从头开始」—— 那个按钮此刻没有任何意义', async () => {
    await startShadowing();
    await goBackground();
    expect(screen.queryByText('从头开始')).toBeNull();
    expect(screen.getByText('开始跟读')).toBeInTheDocument();
  });

  it('切后台会把进度写进 Lesson（跨设备那一份），而且写的是停住的那一句', async () => {
    await startAndAdvance();
    await goBackground();
    expect(useLessonStore.getState().lessons[0]!.shadowingAt).toBe(1);
  });

  it('换了台设备（本机没记录）：按 Lesson 上同步回来的那一句接着练', async () => {
    render(<ShadowingTab lesson={{ ...LESSON, shadowingAt: 1 }} cache={undefined} />);
    await act(async () => {});
    expect(screen.getByText('继续跟读（第 2 句）')).toBeInTheDocument();
  });
});

// —— 变更 94 / §12.27：手机上那一屏 ——
//
// 他的原话：「在手机上，跟读时的内容部分也要一直居中，现在很多时候我要自己操作」。
// 这里验的是「什么时候该滚」这条策略；滚完之后真的落在屏幕中间，只有真浏览器说得准
// （jsdom 的 getBoundingClientRect 恒为 0），那条判据在 e2e/shadowing.spec.ts 里。
describe('ShadowingTab — 当前句一直在屏幕中间（变更 94 / §12.27）', () => {
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollSpy = vi.fn();
    // jsdom 根本没有 scrollIntoView —— 不补上去的话 centerIfNeeded 会一路安静返回。
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollSpy,
      configurable: true,
      writable: true,
    });
  });

  /** rAF 里那一次测量：等它跑完。 */
  async function nextFrame() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  it('开始跟读就把当前句拉到中间', async () => {
    await startShadowing();
    await nextFrame();
    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
  });

  it('换一句再拉一次 —— 手机上下一句本来就落在屏幕外', async () => {
    await startShadowing();
    await nextFrame();
    scrollSpy.mockClear();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    await nextFrame();
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('没在跟读的时候一下都不滚 —— 那会儿人多半正自己翻着看别的句子', async () => {
    render(<ShadowingTab lesson={LESSON} cache={undefined} />);
    await act(async () => {});
    await nextFrame();
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe('ShadowingTab — 设置收进折叠块（变更 94 / §12.27）', () => {
  it('默认收起：手机那一屏不该被开练之前调一次的东西占掉', async () => {
    render(<ShadowingTab lesson={LESSON} cache={undefined} />);
    await act(async () => {});
    // jsdom 不做 <details> 的布局隐藏（变更 56 的教训），断言只能看 open 属性。
    const details = document.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
  });

  it('摘要里摆着当前值 —— 不展开也知道现在是什么设置', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, shadowingRepeat: 2, shadowingGapRatio: 1.5 },
      loaded: true,
    });
    render(<ShadowingTab lesson={LESSON} cache={undefined} />);
    await act(async () => {});
    const summary = document.querySelector('summary')!;
    expect(summary.textContent).toContain('每句 2 遍');
    expect(summary.textContent).toContain('×1.5');
    expect(summary.textContent).toContain('练全部');
  });

  it('「手动推进」说人话，不说「每句 0 遍」', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, shadowingRepeat: 0 },
      loaded: true,
    });
    render(<ShadowingTab lesson={LESSON} cache={undefined} />);
    await act(async () => {});
    const summary = document.querySelector('summary')!;
    expect(summary.textContent).toContain('手动推进');
    expect(summary.textContent).not.toContain('每句 0 遍');
  });
});
