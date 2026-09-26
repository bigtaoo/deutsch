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
import { playSfx, preloadSfx } from '@/audio/sfx';
import { audioPlayer } from '@/audio/player';
import { getAudioBlob } from '@/db/cache';
import { ensureWordAudio, germanVoice } from '@/dict/audio';
import { aiAvailable, explainWithAi, getCachedAiNote } from '@/ai/explain';
import type { DictDeck } from '@/dict/types';
import type { FSRSCard, Lesson, VocabEntry } from '@/types/models';

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
  // load/play/playRange 在真代码里都是 async（会被 `.catch()`），mock 也得回一个
  // Promise——早先的用例都在 getAudioBlob 早退那条路上，从没真的调用到这几个方法，
  // 直到变更 53 补的用例第一次走到这里，才发现同步 `vi.fn()` 的返回值上 `.catch`
  // 是 `undefined.catch`，一个未处理的 rejection。
  audioPlayer: {
    load: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    playRange: vi.fn(async () => {}),
    pause: vi.fn(),
  },
}));

vi.mock('@/db/cache', () => ({ getAudioBlob: vi.fn(async () => undefined) }));
vi.mock('@/sync/trigger', () => ({ syncVocabNow: vi.fn() }));
vi.mock('@/audio/sfx', () => ({ playSfx: vi.fn(), preloadSfx: vi.fn(async () => {}) }));
// FR-10.14：卡背自动补中文解释。默认「没配 AI」—— 已有的用例一条都不该
// 因为多了这个功能就去发网络请求，它们测的是别的东西。
vi.mock('@/ai/explain', () => ({
  aiAvailable: vi.fn(async () => false),
  explainWithAi: vi.fn(async () => ''),
  getCachedAiNote: vi.fn(async () => undefined),
}));

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
    // Again 之后绝不会跳到几天以后。**口径随 FR-10.13 改过**：学习步骤关掉之后
    // 最短的一档就是一天（原来是 1 分钟），所以这里钉的是「正好落在最短那一档」——
    // 上界仍要有，它挡的是「Again 被喂成了 Good」这种评分接错线的错。
    const gap = card.due - NOW.getTime();
    expect(gap).toBeGreaterThanOrEqual(86_400_000);
    expect(gap).toBeLessThan(2 * 86_400_000);
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

  it('孤立词发音的辨义题同样亮出词形，而且只亮一处（§12.19）', async () => {
    seed([
      entry('Vorhang', { gender: 'm', fsrs: reviewState() }),
      entry('heilen', { id: 'heilen' }),
      entry('Falke', { id: 'Falke' }),
      entry('Spind', { id: 'Spind' }),
    ]);
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    const shown = screen.getAllByText('Vorhang').filter((el) => el.closest('button') === null);
    expect(shown).toHaveLength(1);
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

// ── FR-21：读卡 ───────────────────────────────────────────────────
//
// 纯函数层（queue / choices / questionSource）已经各自测过组队列和组题。
// 这里补的是装起来之后才看得见的那几件，头一件最要命：
// **评分落在哪一张卡上**。写错一边不会报错、界面上也看不出来 ——
// 读卡答对了却把听卡的间隔拉长，几周后表现为「那个词的听力题再也不来了」。

describe('ReviewPage：识词卡（FR-21）', () => {
  const DAY = 86_400_000;
  /** 听卡在 Review 但**没到期** —— 它不该进今天的队列，读卡才是主角。 */
  function sleepingListen(): FSRSCard {
    return { ...newCard(NOW), state: 2, reps: 4, due: NOW.getTime() + 7 * DAY, last_review: NOW.getTime() - 3 * DAY };
  }
  /** 只当干扰项用：听卡在学习中且没到期，所以既不进队列，也够不着开读卡的门槛。 */
  function filler(surface: string): VocabEntry {
    return entry(surface, {
      id: surface,
      preset: undefined,
      lookup: true,
      fsrs: { ...newCard(NOW), state: 1, reps: 1, due: NOW.getTime() + DAY },
    });
  }
  const FILLERS = [filler('Erholung'), filler('Ansammlung'), filler('Gelassenheit'), filler('Umgebung')];

  it('读卡的正面是文字：题干说清考什么，且**没有播放键**', async () => {
    seed([
      entry('Zuversicht', { fsrs: sleepingListen(), fsrsRead: { ...newCard(NOW), due: NOW.getTime() - 1000 } }),
      ...FILLERS,
    ]);
    render(<ReviewPage />);

    await waitFor(() => expect(screen.getByText('这个词是什么意思')).toBeInTheDocument());
    // 题面就是那个词（听卡那边它只能作为选项出现，这里反过来）
    expect(screen.getByText('Zuversicht')).toBeInTheDocument();
    // FR-21.5：读卡不放声音。播放键出现就说明走错了分支，而那一步会顺带自动播一次音频
    expect(screen.queryByLabelText('播放')).not.toBeInTheDocument();
  });

  it('放弃那个出口在读卡上只写「不认识」—— 这张卡从头到尾没有声音', async () => {
    seed([
      entry('Zuversicht', { fsrs: sleepingListen(), fsrsRead: { ...newCard(NOW), due: NOW.getTime() - 1000 } }),
      ...FILLERS,
    ]);
    render(<ReviewPage />);

    await waitFor(() => expect(screen.getByText('这个词是什么意思')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '不认识' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '没听清 / 不认识' })).not.toBeInTheDocument();
  });

  it('**评分落在读卡上，听卡一个字都不动**', async () => {
    const listen = sleepingListen();
    seed([
      entry('Zuversicht', { fsrs: listen, fsrsRead: { ...newCard(NOW), due: NOW.getTime() - 1000 } }),
      ...FILLERS,
    ]);
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    await act(async () => {
      choiceButtons()[0].click();
    });

    await waitFor(() => {
      const after = useVocabStore.getState().entries.find((e) => e.id === 'Zuversicht');
      expect(after?.fsrsRead?.reps).toBe(1);
      // 这一条是整个 FR-21 最容易静默写错的地方
      expect(after?.fsrs).toEqual(listen);
    });
  });

  it('cloze：题面是挖好空的句子，而那个词**不在题面上**', async () => {
    seed([
      entry('Vorhang', {
        preset: undefined,
        lookup: true,
        fsrs: sleepingListen(),
        // Review + reps 偶数 → cloze（FR-21.4）
        fsrsRead: { ...newCard(NOW), state: 2, reps: 2, due: NOW.getTime() - 1000 },
        examples: ['Der Vorhang fiel nach dem letzten Akt.'],
      }),
      ...FILLERS,
    ]);
    render(<ReviewPage />);

    await waitFor(() => expect(screen.getByText('哪个词填得进这个空')).toBeInTheDocument());
    const prompt = screen.getByText(/fiel nach dem letzten Akt/);
    expect(prompt.textContent).toContain('_____');
    expect(prompt.textContent).not.toContain('Vorhang');
    // 选项里才有它
    expect(choiceButtons().map((b) => b.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Vorhang')]),
    );
  });

  it('进页面时把该开的读卡开出来（FR-21.2），并且当天就能练到', async () => {
    // 听卡进了 Review、有释义、还没有读卡 —— 正好卡在开卡的门槛上
    seed([entry('Zuversicht', { fsrs: sleepingListen() }), ...FILLERS]);
    render(<ReviewPage />);

    await waitFor(() => {
      expect(useVocabStore.getState().entries.find((e) => e.id === 'Zuversicht')?.fsrsRead).toBeDefined();
    });
    // 新开的读卡今天就到期，所以这一轮里它就是那张卡
    await waitFor(() => expect(screen.getByText('这个词是什么意思')).toBeInTheDocument());
  });

  it('同日互斥：听卡今天到期时，这个词的读卡不出现（FR-21.3）', async () => {
    seed([
      entry('Vorhang', {
        fsrs: { ...newCard(NOW), state: 2, reps: 4, due: NOW.getTime() - 1000 },
        fsrsRead: { ...newCard(NOW), state: 2, reps: 2, due: NOW.getTime() - 2 * DAY },
      }),
      ...FILLERS,
    ]);
    render(<ReviewPage />);

    // 出来的是听卡：有播放键、没有读卡的题干
    await waitFor(() => expect(screen.getByLabelText('播放')).toBeInTheDocument());
    expect(screen.queryByText('哪个词填得进这个空')).not.toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
  });
});

// ── 变更 53：课程听卡「挖空题音频放不出来」+ 三处静默失败 ────────────────
//
// 根因：自动播放那个 effect 把 `resolveRange()` 每次渲染新建的对象当依赖——
// 一变就重跑，清理函数又把刚起播的那句 `pause()` 掉，句子播几毫秒就被自己掐断。
// 用户实测就是「挖空的题，音频根本无法正常播放」。这里钉住的是「不再自己重放自己」，
// 以及顺手一起修的三处 FR-10.5 静默出口：blob 取不到、blob 解不了码、
// 读卡卡背「念一遍」没音源还给一个按下去没反应的键。
describe('ReviewPage：课程听卡的原句音频（变更 53）', () => {
  const DAY = 86_400_000;

  function lessonWith(sentences: Array<{ index: number; text: string; startTime?: number }>): Lesson {
    return {
      id: 'L1',
      title: '课程',
      source: { type: 'manual' },
      audioDuration: 60,
      sentences: sentences.map((s) => ({
        charStart: 0,
        charEnd: s.text.length,
        endTimeExplicit: false,
        blanks: [],
        markedDifficult: false,
        excluded: false,
        ...s,
      })),
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
    };
  }

  /** 一张课程听卡：有 `lessonId` + `sentenceIndex` + `hasTimestamp`，本机也有素材。 */
  function seedLessonListenCard(extra: Partial<VocabEntry> = {}, others: VocabEntry[] = []) {
    useVocabStore.setState({
      entries: [
        entry('Vorhang', {
          gender: 'm',
          preset: undefined,
          lessonId: 'L1',
          sentenceIndex: 0,
          hasTimestamp: true,
          ...extra,
        }),
        ...others,
      ],
      loaded: true,
    });
    useLessonStore.setState({
      lessons: [
        lessonWith([
          { index: 0, text: 'Der Vorhang fällt.', startTime: 1 },
          { index: 1, text: 'Zweiter Satz.', startTime: 5 },
        ]),
      ],
      caches: { L1: { lessonId: 'L1', hasAudio: true, audioBytes: 1000, fetchedAt: NOW.getTime() } },
    });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
  }

  it('只自动播一次，不会自己把自己掐掉', async () => {
    seedLessonListenCard();
    vi.mocked(getAudioBlob).mockResolvedValueOnce(new Blob(['x']));

    render(<ReviewPage />);
    await waitFor(() => expect(audioPlayer.playRange).toHaveBeenCalledTimes(1));
    // 清账的基准点卡在「自动播那一次已经发生之后」——而不是 t=0：mount 的第一个
    // act() 会顺带把上一条用例卸载组件时还没落地的 cleanup 一起冲掉（RTL 的
    // unmount 本身是异步的，pause() 可能晚到下一条用例的渲染里才触发），
    // 那不是这条用例要盯的东西。这里要盯的是**这之后**还会不会再来一轮。
    vi.mocked(audioPlayer.playRange).mockClear();
    vi.mocked(audioPlayer.pause).mockClear();

    // 真等一段真实时间：bug 需要渲染发生的空间才会露出来，立刻断言等于没测——
    // 复现时同样的窗口里，坏代码已经能看到 pause → playRange 一轮又一轮。
    await new Promise((r) => setTimeout(r, 300));

    expect(audioPlayer.playRange).not.toHaveBeenCalled();
    expect(audioPlayer.pause).not.toHaveBeenCalled();
  });

  /** 不在题面按钮里的那几处「Vorhang」—— 卡面上单独亮出来的词形。 */
  function wordOutsideChoices(word: string) {
    return screen.queryAllByText(word).filter((el) => el.closest('button') === null);
  }

  it('辨形题的题干说「听到的那个词」，不说「挖掉」—— 句子是整句播的（§12.19）', async () => {
    seedLessonListenCard();
    vi.mocked(getAudioBlob).mockResolvedValueOnce(new Blob(['x']));
    render(<ReviewPage />);

    // 干扰项凑几个不是这条要测的（规则 ⑥），题出来了就行
    await waitFor(() => expect(choiceButtons().length).toBeGreaterThan(0));
    expect(screen.getByText('听这一句，选出你听到的那个词')).toBeInTheDocument();
    expect(screen.queryByText(/挖掉/)).toBeNull();
    // FR-10.2：辨形题的正面照旧不给词形
    expect(wordOutsideChoices('Vorhang')).toHaveLength(0);
  });

  it('辨义题把目标词亮在卡面上，题干改问意思（§12.19）', async () => {
    seedLessonListenCard({ fsrs: reviewState() }, [
      entry('heilen', { id: 'heilen' }),
      entry('Falke', { id: 'Falke' }),
      entry('Spind', { id: 'Spind' }),
    ]);
    vi.mocked(getAudioBlob).mockResolvedValueOnce(new Blob(['x']));
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    expect(screen.getByText('这句里有这个词，选出它的意思')).toBeInTheDocument();
    // 恰好一处、不在选项里 —— 选项是释义（且词头遮掉了），词形只该出现在题面上
    expect(wordOutsideChoices('Vorhang')).toHaveLength(1);
    expect(choiceButtons().every((b) => !(b.textContent ?? '').includes('Vorhang'))).toBe(true);
  });

  it('hasMaterial 说有、audioBlobs 里实际取不到：明说，不是永久变灰的播放键（FR-10.5）', async () => {
    seedLessonListenCard();
    vi.mocked(getAudioBlob).mockResolvedValueOnce(undefined);

    render(<ReviewPage />);
    await waitFor(() =>
      expect(screen.getByText('这张卡没有音频：本机的音频文件找不到了')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '去重新下载素材' })).toBeInTheDocument();
    expect(screen.queryByLabelText('播放')).not.toBeInTheDocument();
  });

  it('blob 取到了但解码失败：同样明说，不是一个未处理的 rejection（FR-10.5）', async () => {
    seedLessonListenCard();
    vi.mocked(getAudioBlob).mockResolvedValueOnce(new Blob(['x']));
    vi.mocked(audioPlayer.load).mockRejectedValueOnce(new Error('音频解码失败'));

    render(<ReviewPage />);
    await waitFor(() =>
      expect(screen.getByText('这张卡没有音频：音频文件解码失败')).toBeInTheDocument(),
    );
  });

  it('课程卡开成读卡后，卡背「念一遍」放的是原句，不是孤立词形（用户选定的形状）', async () => {
    const listenNotDue: FSRSCard = {
      ...newCard(NOW),
      state: 2,
      reps: 4,
      due: NOW.getTime() + 7 * DAY,
      last_review: NOW.getTime() - 3 * DAY,
    };
    seedLessonListenCard({ fsrs: listenNotDue, fsrsRead: { ...newCard(NOW), due: NOW.getTime() - 1000 } });
    vi.mocked(getAudioBlob).mockResolvedValueOnce(new Blob(['x']));

    render(<ReviewPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: '不认识' })).toBeInTheDocument());
    await act(async () => screen.getByRole('button', { name: '不认识' }).click());

    await waitFor(() => expect(screen.getByRole('button', { name: /念一遍/ })).toBeInTheDocument());
    await act(async () => screen.getByRole('button', { name: /念一遍/ }).click());

    await waitFor(() => expect(audioPlayer.playRange).toHaveBeenCalledWith(1, 5));
    expect(ensureWordAudio).not.toHaveBeenCalled();
  });

  it('预置卡开成读卡、没有真人音也没有系统嗓音：卡背不给「念一遍」——不是给一个按下去没反应的键', async () => {
    vi.mocked(germanVoice).mockReturnValueOnce(null);
    const listenNotDue: FSRSCard = {
      ...newCard(NOW),
      state: 2,
      reps: 4,
      due: NOW.getTime() + 7 * 86_400_000,
      last_review: NOW.getTime() - 3 * 86_400_000,
    };
    seed([
      entry('Zuversicht', { fsrs: listenNotDue, fsrsRead: { ...newCard(NOW), due: NOW.getTime() - 1000 } }),
      entry('Erholung', { id: 'Erholung' }),
      entry('Ansammlung', { id: 'Ansammlung' }),
      entry('Gelassenheit', { id: 'Gelassenheit' }),
    ]);

    render(<ReviewPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: '不认识' })).toBeInTheDocument());
    await act(async () => screen.getByRole('button', { name: '不认识' }).click());

    await waitFor(() => expect(screen.getByRole('button', { name: /继续/ })).toBeInTheDocument());
    // 音源判定是异步的（ensureWordAudio + germanVoice），给它落定的时间
    await new Promise((r) => setTimeout(r, 100));

    expect(screen.queryByRole('button', { name: /念一遍/ })).not.toBeInTheDocument();
  });
});

// ── FR-10.12：三个音效 ─────────────────────────────────────────────
//
// 纯函数层（audio/sfx.ts）已经单独测过「取文件、resume、衰减」。这里测的是
// **装起来才看得见**的那半：哪一下响、响的是哪一个、以及设置关掉之后一声都不响。
//
// 这几条守的失败方式都是静默的：少一声没人会报 bug，但那正是他专门提的那条需求。
describe('ReviewPage：音效（FR-10.12）', () => {
  const played = () => vi.mocked(playSfx).mock.calls.map(([name]) => name);

  /**
   * 等这张卡组好题，然后把账清空再点。
   *
   * 清空这一下不是洁癖：判定音是隔 120ms 发的，上一条用例的那个定时器可能在
   * 这一条已经开始之后才落地（`afterEach` 的 clearAllMocks 早于它）。
   * 不清的话这一组用例会按执行顺序时绿时红 —— 而会随机变绿的门禁比没有门禁更糟。
   */
  async function ready() {
    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    // 先让上一条用例排下的判定定时器落地，再清账。只清不等是不够的：
    // 那个定时器排在 `afterEach` 的 clearAllMocks 之后才到，会算到这一条头上
    // （实测就是这样 —— 单独跑绿，连着跑红）。
    await new Promise((r) => setTimeout(r, 200));
    vi.mocked(playSfx).mockClear();
  }

  it('进页面就预取 —— 等第一次答题才取的话那一声会迟半秒到', async () => {
    seed([entry('Vorhang')]);
    render(<ReviewPage />);
    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    expect(preloadSfx).toHaveBeenCalled();
  });

  it('点一个选项：先一声「嗒」，随后是答对那一声', async () => {
    seed([entry('Vorhang', { gender: 'm' })]);
    render(<ReviewPage />);
    await ready();

    const correct = choiceButtons().find((b) => b.textContent?.includes('Vorhang'))!;
    await act(async () => correct.click());

    // 两声说的是两件事：「收到了」和「对」。顺序不能反 —— 点击音要在手势里发，
    // 它顺带 resume 了 AudioContext（iOS 的手势链），判定音才响得出来。
    await waitFor(() => expect(played()).toEqual(['tap', 'right']));
  });

  it('答错响的是另一声', async () => {
    seed([entry('Vorhang')]);
    render(<ReviewPage />);
    await ready();

    const wrong = choiceButtons().find((b) => !b.textContent?.includes('Vorhang'))!;
    await act(async () => wrong.click());

    await waitFor(() => expect(played()).toEqual(['tap', 'wrong']));
  });

  it('「没听清 / 不认识」也算一次作答，同样两声', async () => {
    seed([entry('Vorhang')]);
    render(<ReviewPage />);
    await ready();

    await act(async () => screen.getByRole('button', { name: /没听清/ }).click());

    await waitFor(() => expect(played()).toEqual(['tap', 'wrong']));
  });

  it('设置里关掉之后一声都不响，也不去预取', async () => {
    seed([entry('Vorhang', { gender: 'm' })]);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, soundEffects: false }, loaded: true });
    render(<ReviewPage />);
    await waitFor(() => expect(choiceButtons()).toHaveLength(4));

    const correct = choiceButtons().find((b) => b.textContent?.includes('Vorhang'))!;
    await act(async () => correct.click());

    // 等一会儿再断言：判定音是隔 120ms 才发的，立刻断言等于什么都没验。
    await new Promise((r) => setTimeout(r, 250));
    expect(playSfx).not.toHaveBeenCalled();
    expect(preloadSfx).not.toHaveBeenCalled();
  });
});

// ── FR-10.14：卡背上的中文（变更 55）─────────────────────────────────────────
//
// 起因是一张预置卡的卡背上一个中文字都没有：词典的中译只覆盖约 60%，
// 而德语释义 99.9%。于是「答错之后缺中文就自动问一次 AI」。
//
// 这里最值得测的是**什么时候不问** —— 每一次多余的调用都是真的花钱，
// 而「少问了一次」在界面上看得见，「多问了一次」看不见。
describe('ReviewPage：卡背缺中文时自动问 AI（FR-10.14）', () => {
  // **每条用例都把三个 mock 归位**：`vi.clearAllMocks()` 只清调用记录，不清
  // `mockResolvedValue` 设下的实现 —— 漏掉这一步的话「缓存命中」那条会把答案
  // 留给后面的用例，于是后面那两条永远等不到「AI 服务暂时不可用」。
  beforeEach(() => {
    vi.mocked(aiAvailable).mockResolvedValue(false);
    vi.mocked(getCachedAiNote).mockResolvedValue(undefined);
    vi.mocked(explainWithAi).mockReset();
  });

  /**
   * 一个由用例自己决定什么时候回答的 AI。
   *
   * **不能用零延迟的同步 mock**：那样「解释中…」这一档在任何一次渲染里都不存在，
   * 这条用例就退化成只测了结果（见 mock-delays-for-regression-tests 那次教训）。
   * 也不用 setTimeout —— `waitFor` 自己要轮询几十毫秒，定时器会和它赛跑。
   */
  function deferredAi() {
    let settle!: (note: string) => void;
    vi.mocked(aiAvailable).mockResolvedValue(true);
    vi.mocked(explainWithAi).mockImplementation(() => new Promise<string>((r) => (settle = r)));
    return (note: string) => act(async () => settle(note));
  }

  /** 「这条用例里 AI 是通的，但一次都不该被叫到」。 */
  function aiIsReadyButMustNotBeCalled() {
    vi.mocked(aiAvailable).mockResolvedValue(true);
    vi.mocked(explainWithAi).mockResolvedValue('不该出现');
  }

  /** 答错第一张卡，露出卡背。 */
  async function answerWrong() {
    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    const wrong = choiceButtons().find((b) => !b.textContent?.includes('Vorhang'))!;
    await act(async () => wrong.click());
    await waitFor(() => expect(screen.getByRole('button', { name: /继续/ })).toBeInTheDocument());
  }

  it('既没有中译也没有 AI 解释 → 自动问一次，答案显示在卡背上并落进词条', async () => {
    const answer = deferredAi();
    seed([entry('Vorhang')]);
    render(<ReviewPage />);

    await answerWrong();
    // 卡背不等 AI：德语释义此刻已经在上面了
    expect(screen.getByText('Sinn: gnahroV')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('AI 解释中…')).toBeInTheDocument());

    await answer('打死、击毙。也可以是被动的「被…压垮」。');
    await waitFor(() =>
      expect(screen.getByText('打死、击毙。也可以是被动的「被…压垮」。')).toBeInTheDocument(),
    );
    expect(screen.queryByText('AI 解释中…')).not.toBeInTheDocument();

    // 不可重建的数据要落库（FR-11.6）—— 下次再答错这张卡就不用再问一遍
    await waitFor(() =>
      expect(useVocabStore.getState().entries[0].note).toBe('打死、击毙。也可以是被动的「被…压垮」。'),
    );
    // 带上语境与词典已有的释义，让模型别重复
    expect(vi.mocked(explainWithAi).mock.calls[0][0]).toMatchObject({
      word: 'Vorhang',
      existing: 'Sinn: gnahroV',
    });
  });

  it('已经有中译就不问 —— 中文已经在卡背上了，再问一次只是重复花钱', async () => {
    aiIsReadyButMustNotBeCalled();
    seed([entry('Vorhang', { meaningZh: '窗帘' })]);
    render(<ReviewPage />);

    await answerWrong();
    expect(screen.getByText('窗帘')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(explainWithAi).not.toHaveBeenCalled();
    expect(getCachedAiNote).not.toHaveBeenCalled();
  });

  it('已经有 AI 解释也不问', async () => {
    aiIsReadyButMustNotBeCalled();
    seed([entry('Vorhang', { note: '上一次问到的解释' })]);
    render(<ReviewPage />);

    await answerWrong();
    expect(screen.getByText('上一次问到的解释')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(explainWithAi).not.toHaveBeenCalled();
  });

  it('答对不问 —— 那条路根本不露卡背，问了等于给「已经会了的词」花钱', async () => {
    aiIsReadyButMustNotBeCalled();
    seed([entry('Vorhang', { gender: 'm' }), entry('heilen', { id: 'heilen' })]);
    render(<ReviewPage />);

    await waitFor(() => expect(choiceButtons()).toHaveLength(4));
    const correct = choiceButtons().find((b) => b.textContent?.includes('Vorhang'))!;
    await act(async () => correct.click());
    await waitFor(() => expect(screen.getByText(/✓ der Vorhang/)).toBeInTheDocument());

    await new Promise((r) => setTimeout(r, 50));
    expect(explainWithAi).not.toHaveBeenCalled();
  });

  it('缓存里有就直接用，不再问一次模型 —— 这同时补上了「查词时问过、复习卡背看不到」', async () => {
    aiIsReadyButMustNotBeCalled();
    vi.mocked(getCachedAiNote).mockResolvedValue('查词面板里问过的那份答案');
    seed([entry('Vorhang')]);
    render(<ReviewPage />);

    await answerWrong();
    await waitFor(() => expect(screen.getByText('查词面板里问过的那份答案')).toBeInTheDocument());
    expect(explainWithAi).not.toHaveBeenCalled();
    await waitFor(() => expect(useVocabStore.getState().entries[0].note).toBe('查词面板里问过的那份答案'));
  });

  it('问不到就说问不到，并且给一个重试 —— 卡背的其余部分照常在上面', async () => {
    vi.mocked(aiAvailable).mockResolvedValue(true);
    vi.mocked(explainWithAi).mockRejectedValueOnce(new Error('网络错误'));
    seed([entry('Vorhang', { ipa: 'ˈfoːɐ̯ˌhaŋ' })]);
    render(<ReviewPage />);

    await answerWrong();
    await waitFor(() => expect(screen.getByText(/AI 服务暂时不可用/)).toBeInTheDocument());
    // 卡背没有因此空掉
    expect(screen.getByText('[ˈfoːɐ̯ˌhaŋ]')).toBeInTheDocument();

    vi.mocked(explainWithAi).mockResolvedValue('重试之后问到的解释');
    await act(async () => screen.getByRole('button', { name: '重试' }).click());
    await waitFor(() => expect(screen.getByText('重试之后问到的解释')).toBeInTheDocument());
    expect(screen.queryByText(/AI 服务暂时不可用/)).not.toBeInTheDocument();
  });

  it('同一张卡只问一次 —— revealed 期间的重渲染不该各发一次请求', async () => {
    const answer = deferredAi();
    seed([entry('Vorhang')]);
    render(<ReviewPage />);

    await answerWrong();
    await waitFor(() => expect(explainWithAi).toHaveBeenCalledTimes(1));
    await answer('第一次也是唯一一次');

    // 卡背在 revealed 期间会被重渲染好几次（例句异步回来、评分写库后 store 更新、
    // 音源状态落定）。**多问一次在界面上完全看不出来** —— 答案一样、闪都不闪一下，
    // 只有账单知道。所以这条钉的是 `askedRef`，它被删掉的症状是静默的。
    await waitFor(() => expect(screen.getByText('第一次也是唯一一次')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 80));
    expect(explainWithAi).toHaveBeenCalledTimes(1);
  });

  it('答案在翻页之后才回来，照样落到那个词条上 —— 已经付过钱了，丢掉才是亏', async () => {
    const answer = deferredAi();
    seed([entry('Vorhang'), entry('heilen', { id: 'heilen' })]);
    render(<ReviewPage />);

    await answerWrong();
    await waitFor(() => expect(explainWithAi).toHaveBeenCalledTimes(1));

    // 不等答案就翻到下一张（真实节奏里这太常见了：答错、扫一眼卡背、继续）
    await act(async () => screen.getByRole('button', { name: /继续/ }).click());
    await waitFor(() => expect(screen.getByText(/^2 \/ 2/)).toBeInTheDocument());

    await answer('迟到的解释');

    // 写的是 store，跟那个组件还在不在没关系。**这条如果有人「顺手」加上取消逻辑，
    // 症状是钱照花、答案没了**，而界面上一个字都不会变。
    await waitFor(() =>
      expect(useVocabStore.getState().entries.find((e) => e.id === 'Vorhang')!.note).toBe('迟到的解释'),
    );
    // 而且没有串到当前这张卡上
    expect(useVocabStore.getState().entries.find((e) => e.id === 'heilen')!.note).toBeUndefined();
  });

  it('两张卡各问各的，答案不会串到别的词条上', async () => {
    vi.mocked(aiAvailable).mockResolvedValue(true);
    vi.mocked(explainWithAi).mockImplementation(async ({ word }) => `关于 ${word} 的解释`);
    seed([entry('Vorhang'), entry('heilen', { id: 'heilen' })]);
    render(<ReviewPage />);

    await answerWrong();
    await waitFor(() => expect(screen.getByText('关于 Vorhang 的解释')).toBeInTheDocument());
    await act(async () => screen.getByRole('button', { name: /继续/ }).click());

    await waitFor(() => expect(screen.getByText(/^2 \/ 2/)).toBeInTheDocument());
    const wrong = choiceButtons().find((b) => !b.textContent?.includes('heilen'))!;
    await act(async () => wrong.click());

    await waitFor(() => expect(screen.getByText('关于 heilen 的解释')).toBeInTheDocument());
    await waitFor(() => {
      const byId = Object.fromEntries(useVocabStore.getState().entries.map((e) => [e.id, e.note]));
      expect(byId).toEqual({ Vorhang: '关于 Vorhang 的解释', heilen: '关于 heilen 的解释' });
    });
  });

  it('问的是词元，不是卡上那个变位形式', async () => {
    const answer = deferredAi();
    // `gelaufen` 的卡要问 `laufen` —— 问变位形式，回来的解释十有八九在讲
    // 「这是 laufen 的第二分词」，而那正是这张卡上唯一不缺的信息。
    seed([entry('gelaufen', { lemma: 'laufen' })]);
    render(<ReviewPage />);

    // 牌组里只有 Vorhang / heilen，`gelaufen` 凑不满四个干扰项 —— 这条用例不关心选项数
    await waitFor(() => expect(screen.getByRole('button', { name: /没听清/ })).toBeInTheDocument());
    await act(async () => screen.getByRole('button', { name: /没听清/ }).click());
    await waitFor(() => expect(screen.getByRole('button', { name: /继续/ })).toBeInTheDocument());

    await waitFor(() => expect(getCachedAiNote).toHaveBeenCalledWith('laufen'));
    expect(vi.mocked(explainWithAi).mock.calls[0][0].word).toBe('laufen');
    // 收尾要等这次写真的落完：`deferredAi` 的答案是在用例结束之后才写进 store 的，
    // 不等的话它会落到**下一条用例**刚 seed 好的库上，把那条弄红（前面「缓存命中」
    // 那条留下的 mock 实现是同一类坑，只是换了个载体）。
    await answer('随便什么');
    await waitFor(() => expect(screen.getByText('随便什么')).toBeInTheDocument());
  });

  it('缓存读坏了不该把「问一次」一起拖下水 —— 它只是一条省钱的近路', async () => {
    vi.mocked(aiAvailable).mockResolvedValue(true);
    vi.mocked(getCachedAiNote).mockRejectedValue(new Error('IndexedDB 出问题了'));
    vi.mocked(explainWithAi).mockResolvedValue('照样问到了');
    seed([entry('Vorhang')]);
    render(<ReviewPage />);

    await answerWrong();
    await waitFor(() => expect(screen.getByText('照样问到了')).toBeInTheDocument());
  });

  it('重试还能再失败一次，然后再重试 —— 那道闸是可以反复放开的', async () => {
    vi.mocked(aiAvailable).mockResolvedValue(true);
    vi.mocked(explainWithAi).mockRejectedValue(new Error('网络错误'));
    seed([entry('Vorhang')]);
    render(<ReviewPage />);

    await answerWrong();
    await waitFor(() => expect(screen.getByText(/AI 服务暂时不可用/)).toBeInTheDocument());

    await act(async () => screen.getByRole('button', { name: '重试' }).click());
    await waitFor(() => expect(explainWithAi).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/AI 服务暂时不可用/)).toBeInTheDocument();

    vi.mocked(explainWithAi).mockResolvedValue('第三次成了');
    await act(async () => screen.getByRole('button', { name: '重试' }).click());
    await waitFor(() => expect(screen.getByText('第三次成了')).toBeInTheDocument());
  });

  // ── 课程卡：语境是原句 ──────────────────────────────────────────────────
  //
  // 这一段单独 seed 一门课，因为「传哪一句给 AI」只有课程卡才问得出来。
  // 预置卡与查词卡都没有原句，走的是 `examples[0]`。
  const LESSON_DAY = 86_400_000;

  function seedLessonCard(extra: Partial<VocabEntry> = {}) {
    useVocabStore.setState({
      entries: [
        entry('Vorhang', {
          preset: undefined,
          lessonId: 'L1',
          sentenceIndex: 0,
          hasTimestamp: true,
          examples: ['一句不该被选中的例句。'],
          ...extra,
        }),
      ],
      loaded: true,
    });
    useLessonStore.setState({
      lessons: [
        {
          id: 'L1',
          title: '课程',
          source: { type: 'manual' },
          audioDuration: 60,
          sentences: [
            {
              index: 0,
              text: 'Der Vorhang fällt.',
              startTime: 1,
              charStart: 0,
              charEnd: 18,
              endTimeExplicit: false,
              blanks: [],
              markedDifficult: false,
              excluded: false,
            },
          ],
          createdAt: NOW.getTime(),
          updatedAt: NOW.getTime(),
        },
      ],
      caches: { L1: { lessonId: 'L1', hasAudio: true, audioBytes: 1000, fetchedAt: NOW.getTime() } },
    });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
  }

  it('课程卡问的时候带上原句，而不是词典里的例句 —— `Zug` 是火车还是一步棋全看这个', async () => {
    const answer = deferredAi();
    seedLessonCard();
    vi.mocked(getAudioBlob).mockResolvedValueOnce(new Blob(['x']));
    render(<ReviewPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: /没听清/ })).toBeInTheDocument());
    await act(async () => screen.getByRole('button', { name: /没听清/ }).click());
    await waitFor(() => expect(screen.getByRole('button', { name: /继续/ })).toBeInTheDocument());

    await waitFor(() => expect(explainWithAi).toHaveBeenCalled());
    expect(vi.mocked(explainWithAi).mock.calls[0][0].context).toBe('Der Vorhang fällt.');
    await answer('随便什么');
    await waitFor(() => expect(screen.getByText('随便什么')).toBeInTheDocument());
  });

  it('读卡的卡背同样会补中文 —— 它和听卡共用这一块，不该只有一半有', async () => {
    const answer = deferredAi();
    seedLessonCard({
      fsrs: { ...newCard(NOW), state: 2, reps: 4, due: NOW.getTime() + 7 * LESSON_DAY },
      fsrsRead: { ...newCard(NOW), due: NOW.getTime() - 1000 },
    });
    render(<ReviewPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: '不认识' })).toBeInTheDocument());
    await act(async () => screen.getByRole('button', { name: '不认识' }).click());
    await waitFor(() => expect(screen.getByRole('button', { name: /继续/ })).toBeInTheDocument());

    await waitFor(() => expect(screen.getByText('AI 解释中…')).toBeInTheDocument());
    await answer('读卡上也给中文');
    await waitFor(() => expect(screen.getByText('读卡上也给中文')).toBeInTheDocument());
  });

  it('压根没配 AI（没登录 / 服务器没 key）：不发请求，卡背上也不提这回事', async () => {
    vi.mocked(aiAvailable).mockResolvedValue(false);
    seed([entry('Vorhang', { ipa: 'ˈfoːɐ̯ˌhaŋ' })]);
    render(<ReviewPage />);

    await answerWrong();
    // 卡背照常，只是没有中文 —— 这里没有任何下一步动作，唠叨一行「不可用」是噪音
    expect(screen.getByText('[ˈfoːɐ̯ˌhaŋ]')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(explainWithAi).not.toHaveBeenCalled();
    expect(screen.queryByText(/AI 服务暂时不可用/)).not.toBeInTheDocument();
    expect(screen.queryByText('AI 解释中…')).not.toBeInTheDocument();
  });
});
