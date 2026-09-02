// FR-17.4：每日惰性激活。
//
// 这条路径的两个要点在别处都测不到：
//   ① **报名一整档 ≠ 建一整档的卡**。第 4 档是 3000 个词，一次建完要 60 次
//      MediaWiki 往返和 100MB 以上的录音 —— 所以每次只发当天缺的那几张。
//   ② **课上标的生词也算在当天额度里**。不算的话，标了 8 个词的那天会变成
//      18 张新卡，而 newPerDay 这道闸存在的理由正是不让这种事发生。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useVocabStore } from './useVocabStore';
import { useSettingsStore } from './useSettingsStore';
import { DEFAULT_SETTINGS } from '@/db/meta';
import { newCard } from '@/srs/fsrs';
import type { DictDeck } from '@/dict/types';
import type { VocabEntry } from '@/types/models';

const DECK: DictDeck = {
  id: 4,
  label: '3001–6000',
  words: Array.from({ length: 50 }, (_, i) => ({ w: `Wort${i}`, r: 3001 + i })),
};

const prefetchWordAudio = vi.fn(async (words: string[]) => ({ human: words.length, tts: 0, none: 0 }));

vi.mock('@/dict/lookup', () => ({
  loadDeck: vi.fn(async (band: number) => (band === 4 ? DECK : null)),
  lookupDict: vi.fn(async (w: string) => ({
    entry: { w, s: [{ p: 'noun', g: 'f', de: [`Bedeutung von ${w}`] }] },
    via: 'exact',
  })),
  dedupeKey: vi.fn(async (s: string) => s.toLowerCase()),
  dictMeta: vi.fn(async () => null),
}));

vi.mock('@/dict/audio', () => ({ prefetchWordAudio: (w: string[]) => prefetchWordAudio(w) }));
vi.mock('@/dict/online', () => ({ lookupOnline: vi.fn(async () => null) }));

const NOW = new Date('2026-09-02T12:00:00Z');

function lessonWord(id: string): VocabEntry {
  return {
    id,
    surface: id,
    lemma: id,
    lessonId: 'L1',
    sentenceIndex: 0,
    hasTimestamp: true,
    suspended: false,
    fsrs: newCard(NOW),
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useVocabStore.setState({ entries: [], loaded: true });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, enrolledBands: [4] }, loaded: true });
});

describe('topUpNewCards', () => {
  it('没报名任何档时什么都不做', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, enrolledBands: [] }, loaded: true });
    const { added } = await useVocabStore.getState().topUpNewCards();
    expect(added).toEqual([]);
    expect(prefetchWordAudio).not.toHaveBeenCalled();
  });

  it('只发当天缺的那几张，不是整档 3000 个', async () => {
    const { added } = await useVocabStore.getState().topUpNewCards();
    expect(added).toHaveLength(DEFAULT_SETTINGS.newPerDay);
    expect(added.map((e) => e.surface)).toEqual(['Wort0', 'Wort1', 'Wort2', 'Wort3', 'Wort4', 'Wort5', 'Wort6', 'Wort7', 'Wort8', 'Wort9']);
  });

  it('卡上带档号与档内名次，且释义/性从词典拷进来（卡不可重建，词典可重建）', async () => {
    const { added } = await useVocabStore.getState().topUpNewCards();
    expect(added[0].preset).toEqual({ band: 4, rank: 3001 });
    expect(added[0].gender).toBe('f');
    expect(added[0].meaning).toContain('Bedeutung von Wort0');
    expect(added[0].hasTimestamp).toBe(false);
  });

  it('额度满了就一张都不发（第二次进复习页不该再发一批）', async () => {
    await useVocabStore.getState().topUpNewCards();
    const second = await useVocabStore.getState().topUpNewCards();
    expect(second.added).toEqual([]);
  });

  it('课上标的生词占额度 —— 标了 8 个词的那天只补 2 个', async () => {
    useVocabStore.setState({
      entries: Array.from({ length: 8 }, (_, i) => lessonWord(`Glossar${i}`)),
      loaded: true,
    });
    const { added } = await useVocabStore.getState().topUpNewCards();
    expect(added).toHaveLength(2);
  });

  it('顺手预取下一批的发音，但**不建卡**', async () => {
    const { added } = await useVocabStore.getState().topUpNewCards();
    await vi.waitFor(() => expect(prefetchWordAudio).toHaveBeenCalledTimes(2));
    // 第一次是今天这批，第二次是下一批
    expect(prefetchWordAudio.mock.calls[0][0]).toEqual(added.map((e) => e.surface));
    expect(prefetchWordAudio.mock.calls[1][0]).toEqual(
      Array.from({ length: 10 }, (_, i) => `Wort${i + 10}`),
    );
    // 预取的那批没有变成卡
    expect(useVocabStore.getState().entries).toHaveLength(10);
  });

  it('已经在生词本里的词不会再发一次（按词元键比，不是 surface）', async () => {
    useVocabStore.setState({ entries: [lessonWord('wort0')], loaded: true });
    const { added } = await useVocabStore.getState().topUpNewCards();
    expect(added.map((e) => e.surface)).not.toContain('Wort0');
    expect(added).toHaveLength(9); // 额度 10 减去那张已有的课程卡
  });

  it('预取失败不影响今天的卡（离线时激活照样算成功）', async () => {
    prefetchWordAudio.mockRejectedValueOnce(new Error('offline'));
    await expect(useVocabStore.getState().topUpNewCards()).rejects.toThrow('offline');
    // 卡已经落库了 —— 失败发生在取发音那一步，卡本身是好的
    expect(useVocabStore.getState().entries).toHaveLength(10);
  });
});
