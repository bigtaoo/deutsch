// 复习页的行为测试（FR-10）。
//
// 这是这个项目第一个组件测试。写它的理由很具体：**这一页的对错判定、评分落库、
// 答对自动跳转、答错才亮卡背，全是时序行为** —— 纯函数层（grade / choices /
// questionSource）已经各自测过了，但「点下去之后到底发生了什么」只有把它们
// 装起来才测得到。而这一页正是手机上唯一每天都会用的界面。
//
// 只 mock 三类外部依赖：音频（jsdom 里没有）、词典取文件、备份触发。
// **store 用真的**（fake-indexeddb 在 src/test/setup.ts 里已经就位）——
// 评分有没有真的落库，是这里最值得测的一条。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ReviewPage } from './ReviewPage';
import { useVocabStore } from '@/state/useVocabStore';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/db/meta';
import { newCard } from '@/srs/fsrs';
import type { DictDeck } from '@/dict/types';
import type { FSRSCard, VocabEntry } from '@/types/models';

const DECK: DictDeck = {
  id: 4,
  label: '3001–6000',
  words: [
    { w: 'Vorhang', r: 3001, d: ['Vorgang', 'Vorrang', 'Vorfall'] },
    { w: 'heilen', r: 3002, d: ['heulen', 'teilen', 'weilen'] },
  ],
};

vi.mock('@/dict/lookup', () => ({
  loadDeck: vi.fn(async () => DECK),
  lookupDict: vi.fn(async () => ({
    entry: { w: 'Vorhang', s: [{ p: 'noun', g: 'm' }], ex: ['Der Vorhang fällt.'] },
    via: 'exact',
  })),
  dictMeta: vi.fn(async () => null),
}));

vi.mock('@/dict/audio', () => ({
  ensureWordAudio: vi.fn(async () => undefined),
  germanVoice: vi.fn(() => ({ name: 'Anna' })),
  speak: vi.fn(() => true),
  prefetchWordAudio: vi.fn(async () => ({ human: 0, tts: 0, none: 0 })),
}));

vi.mock('@/audio/player', () => ({
  audioPlayer: { load: vi.fn(), play: vi.fn(), playRange: vi.fn(), pause: vi.fn() },
}));

vi.mock('@/db/cache', () => ({ getAudioBlob: vi.fn(async () => undefined) }));
vi.mock('@/sync/trigger', () => ({ syncVocabNow: vi.fn() }));

const NOW = new Date('2026-09-02T12:00:00Z');

function entry(surface: string, extra: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id: surface,
    surface,
    lemma: surface,
    meaning: `Sinn: ${[...surface].reverse().join('')}`,
    preset: { band: 4, rank: 3001 },
    hasTimestamp: false,
    suspended: false,
    fsrs: newCard(NOW),
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
    ...extra,
  };
}

function reviewState(): FSRSCard {
  return { ...newCard(NOW), state: 2, reps: 3, due: NOW.getTime() - 1000 };
}

function seed(entries: VocabEntry[]) {
  useVocabStore.setState({ entries, loaded: true });
  useLessonStore.setState({ lessons: [], caches: {} });
  // enrolledBands 留空：这些测试测的是复习流程，不是惰性激活
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
}

/** 题面上的四个选项按钮（排除「不认识」和「继续」）。 */
function choiceButtons() {
  return screen
    .getAllByRole('button')
    .filter((b) => /^\d/.test(b.textContent ?? '') && !/继续/.test(b.textContent ?? ''));
}

beforeEach(() => {
  // **只 fake `Date`，不 fake 定时器。**
  // 整个时钟都 fake 掉的话，fake-indexeddb 的事务永远不会 resolve ——
  // 于是 `await updateEntry(...)` 之后的代码一行都不跑，
  // 症状是「点了选项什么也没发生」，而看着像是点击没被 React 收到。
  // 代价是那 600ms 的自动跳转要用 waitFor 真等一下，不能 advanceTimersByTime。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ReviewPage：听音四选一', () => {
  it('新卡出辨形题：四个音近选项，题面上没有任何文字提示', async () => {
    seed([entry('Vorhang')]);
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    const texts = choiceButtons().map((b) => b.textContent?.replace(/^\d/, '').trim());
    expect(texts).toEqual(expect.arrayContaining(['Vorhang', 'Vorgang', 'Vorrang', 'Vorfall']));

    // FR-10.2：正面只有声音。词形只能作为**选项**出现，不能另有一份文字题面
    const occurrences = screen.getAllByText('Vorhang');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].closest('button')).not.toBeNull();
    expect(screen.getByLabelText('播放')).toBeInTheDocument();
  });

  it('答对 → 闪出带冠词的词形 → 600ms 后自动进下一张', async () => {
    seed([entry('Vorhang', { gender: 'm' }), entry('heilen', { id: 'heilen' })]);
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    expect(screen.getByText(/^1 \/ 2/)).toBeInTheDocument();

    const correct = choiceButtons().find((b) => b.textContent?.includes('Vorhang'))!;
    await act(async () => correct.click());

    // FR-10.11：那 600ms 是名词的性在主路径上唯一露脸的机会。
    // 要 waitFor 而不是直接断言：评分先 `await updateEntry`（一次 IndexedDB 写），
    // 那是个宏任务，act() 只 flush 到微任务就返回了。
    await waitFor(() => expect(screen.getByText(/✓ der Vorhang/)).toBeInTheDocument());
    // 答对不展开卡背
    expect(screen.queryByRole('button', { name: /继续/ })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/^2 \/ 2/)).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.queryByText(/✓ der Vorhang/)).not.toBeInTheDocument();
  });

  it('答错 → 正确项亮出来 + 完整卡背 + 继续按钮，且不出现任何间隔选项', async () => {
    seed([entry('Vorhang', { gender: 'm', plural: 'Vorhänge', ipa: 'ˈfoːɐ̯ˌhaŋ' })]);
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    const wrong = choiceButtons().find((b) => !b.textContent?.includes('Vorhang'))!;
    await act(async () => wrong.click());

    // 卡背（FR-10.3）
    await waitFor(() => expect(screen.getByText('der Vorhang')).toBeInTheDocument());
    expect(screen.getByText('Vorhänge')).toBeInTheDocument();
    expect(screen.getByText('[ˈfoːɐ̯ˌhaŋ]')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Der Vorhang fällt.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /继续/ })).toBeInTheDocument();

    // FR-10.4：旧的手动评分那一排必须彻底不在了
    for (const label of ['忘了', '勉强', '记得', '太简单', '显示答案']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('「没听清 / 不认识」判 Again 并展开卡背 —— 这个出口挡的是 25% 瞎猜命中率', async () => {
    seed([entry('Vorhang', { gender: 'm' })]);
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    await act(async () => screen.getByRole('button', { name: /没听清/ }).click());

    await waitFor(() => expect(screen.getByText('der Vorhang')).toBeInTheDocument());
    const card = useVocabStore.getState().entries[0].fsrs;
    expect(card.lapses + card.reps).toBeGreaterThan(0);
    // Again 之后是「学习中/重学中」，绝不会跳到几天以后
    expect(card.due - NOW.getTime()).toBeLessThan(86_400_000);
  });

  it('评分真的落库：答对之后 due 被推到以后，reps 涨了', async () => {
    seed([entry('Vorhang', { gender: 'm' })]);
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    const before = useVocabStore.getState().entries[0].fsrs;
    const correct = choiceButtons().find((b) => b.textContent?.includes('Vorhang'))!;
    await act(async () => correct.click());

    await waitFor(() => {
      const after = useVocabStore.getState().entries[0].fsrs;
      expect(after.reps).toBe(before.reps + 1);
      expect(after.due).toBeGreaterThan(before.due);
    });
  });

  it('进入 Review 的卡改考辨义：选项是释义，不是词形', async () => {
    seed([
      entry('Vorhang', { gender: 'm', fsrs: reviewState() }),
      entry('heilen', { id: 'heilen' }),
      entry('Falke', { id: 'Falke' }),
      entry('Spind', { id: 'Spind' }),
    ]);
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    const texts = choiceButtons().map((b) => b.textContent ?? '');
    expect(texts.some((t) => t.includes('gnahroV'))).toBe(true); // Vorhang 的释义
    expect(texts.every((t) => !t.includes('Vorhang'))).toBe(true); // 词形不该出现
  });

  it('一轮做完后给出下次到期时间，不留在最后一张卡上', async () => {
    seed([entry('Vorhang', { gender: 'm' })]);
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    const correct = choiceButtons().find((b) => b.textContent?.includes('Vorhang'))!;
    await act(async () => correct.click());

    await waitFor(() => expect(screen.getByText('这一轮做完了。')).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByRole('button', { name: '看生词本' })).toBeInTheDocument();
  });
});
