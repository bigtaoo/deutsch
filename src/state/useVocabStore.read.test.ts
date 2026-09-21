// FR-21.2 / FR-21.6：开读卡，以及开卡时把 cloze 要用的句子**拷**进词条。
//
// 这条路径值得单独一个文件，因为它坏掉的时候**界面上什么也看不出来**：
// 句子没拷进去 → cloze 组不出来 → questionSource 悄悄降级成 read-form，
// 而 read-form 是一道完全正常的题。症状是「挖空题再也没出现过」，
// 那要练上几周才察觉得到，而且察觉了也说不清是不是自己记错了。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useVocabStore } from './useVocabStore';
import { useSettingsStore } from './useSettingsStore';
import { getAllVocabEntries } from '@/db/vocab';
import { DEFAULT_SETTINGS } from '@/db/meta';
import { newCard } from '@/srs/fsrs';
import type { FSRSCard, VocabEntry } from '@/types/models';

const lookupDict = vi.fn(async (_word: string) => null as { entry: { w: string; s: []; ex?: string[] } } | null);

vi.mock('@/dict/lookup', () => ({
  loadDeck: vi.fn(async () => null),
  lookupDict: (w: string) => lookupDict(w),
  dedupeKey: vi.fn(async (s: string) => s.toLowerCase()),
  dictMeta: vi.fn(async () => null),
}));
vi.mock('@/dict/audio', () => ({ prefetchWordAudio: vi.fn(async () => ({ human: 0, missing: 0 })) }));
vi.mock('@/dict/online', () => ({ lookupOnline: vi.fn(async () => null) }));

const NOW = new Date('2026-09-21T12:00:00Z');

function reviewed(): FSRSCard {
  return { ...newCard(NOW), state: 2, reps: 4, due: NOW.getTime() + 86_400_000 };
}

function entry(id: string, extra: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id,
    surface: id,
    meaning: `Sinn von ${id}`,
    hasTimestamp: false,
    suspended: false,
    fsrs: reviewed(),
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
    ...extra,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  lookupDict.mockResolvedValue(null);
  for (const e of await getAllVocabEntries()) await useVocabStore.getState().removeEntry(e.id);
  useVocabStore.setState({ entries: [], loaded: true });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
});

describe('openReadCards', () => {
  it('开出来的读卡是一张真正的新卡，并且**落了库**', async () => {
    useVocabStore.setState({ entries: [entry('Vorhang')] });
    const opened = await useVocabStore.getState().openReadCards(5);

    expect(opened).toHaveLength(1);
    expect(opened[0].fsrsRead?.state).toBe(0);
    expect(opened[0].fsrsRead?.reps).toBe(0);
    // 听卡一个字都不能动 —— 开读卡不是一次复习
    expect(opened[0].fsrs).toEqual(entry('Vorhang').fsrs);

    const stored = await getAllVocabEntries();
    expect(stored[0].fsrsRead?.state).toBe(0);
    // store 里那份也要跟着换，否则复习页要刷新才看得到今天开的卡
    expect(useVocabStore.getState().entries[0].fsrsRead).toBeDefined();
  });

  it('课程卡拿**原句**当 cloze 的句子，不去查词典', async () => {
    useVocabStore.setState({
      entries: [entry('Vorhang', { contextSentence: 'Der Vorhang fiel nach dem Akt.', lessonId: 'L1' })],
    });
    const [opened] = await useVocabStore.getState().openReadCards(5);

    expect(opened.examples).toEqual(['Der Vorhang fiel nach dem Akt.']);
    // 原句是**真语料**，比词典例句更值得练；而且它一定挖得动（词就是从那句里选出来的）
    expect(lookupDict).not.toHaveBeenCalled();
  });

  it('没有原句的卡（预置 / 查词）去词典取例句，最多两条', async () => {
    lookupDict.mockResolvedValue({
      entry: { w: 'Vorhang', s: [], ex: ['Erster Satz.', 'Zweiter Satz.', 'Dritter Satz.'] },
    });
    useVocabStore.setState({ entries: [entry('Vorhang', { preset: { band: 4, rank: 3001 } })] });
    const [opened] = await useVocabStore.getState().openReadCards(5);

    expect(opened.examples).toEqual(['Erster Satz.', 'Zweiter Satz.']);
  });

  it('加词时已经收下的例句**不被覆盖**（FR-21.6：查词那一趟拿到的那份）', async () => {
    lookupDict.mockResolvedValue({ entry: { w: 'Vorhang', s: [], ex: ['Aus dem Wörterbuch.'] } });
    useVocabStore.setState({
      entries: [entry('Vorhang', { lookup: true, examples: ['Beim Nachschlagen geholt.'] })],
    });
    const [opened] = await useVocabStore.getState().openReadCards(5);

    expect(opened.examples).toEqual(['Beim Nachschlagen geholt.']);
    expect(lookupDict).not.toHaveBeenCalled();
  });

  it('词典也没有例句时照样开卡 —— 那张卡的 cloze 会降级，不是坏卡', async () => {
    lookupDict.mockResolvedValue({ entry: { w: 'Vorhang', s: [] } });
    useVocabStore.setState({ entries: [entry('Vorhang', { preset: { band: 4, rank: 3001 } })] });
    const [opened] = await useVocabStore.getState().openReadCards(5);

    expect(opened.fsrsRead).toBeDefined();
    expect(opened.examples).toBeUndefined();
  });

  it('查词典抛异常也不挡着开卡', async () => {
    lookupDict.mockRejectedValue(new Error('词典没部署'));
    useVocabStore.setState({ entries: [entry('Vorhang', { preset: { band: 4, rank: 3001 } })] });
    const [opened] = await useVocabStore.getState().openReadCards(5);
    expect(opened.fsrsRead).toBeDefined();
  });

  it('limit 是硬上限，且先开先标的那些（与新卡的顺序一致）', async () => {
    useVocabStore.setState({
      entries: [
        entry('spaet', { createdAt: NOW.getTime() }),
        entry('frueh', { createdAt: NOW.getTime() - 10 * 86_400_000 }),
        entry('mitte', { createdAt: NOW.getTime() - 5 * 86_400_000 }),
      ],
    });
    const opened = await useVocabStore.getState().openReadCards(2);
    expect(opened.map((e) => e.id)).toEqual(['frueh', 'mitte']);
  });

  it('额度是 0 时一张也不开，也不去碰词典', async () => {
    useVocabStore.setState({ entries: [entry('Vorhang')] });
    expect(await useVocabStore.getState().openReadCards(0)).toEqual([]);
    expect(lookupDict).not.toHaveBeenCalled();
  });

  it('不够格的词条一张也开不出来（听卡还没进 Review / 没有释义 / 已暂停）', async () => {
    useVocabStore.setState({
      entries: [
        entry('neu', { fsrs: newCard(NOW) }),
        entry('ohneSinn', { meaning: undefined }),
        entry('pausiert', { suspended: true }),
      ],
    });
    expect(await useVocabStore.getState().openReadCards(10)).toEqual([]);
  });

  it('开过的不会再开一次 —— 第二次进复习页不该把读卡重置回新卡', async () => {
    useVocabStore.setState({ entries: [entry('Vorhang')] });
    await useVocabStore.getState().openReadCards(5);
    expect(await useVocabStore.getState().openReadCards(5)).toEqual([]);
  });
});

describe('updateEntries', () => {
  it('一次写回一批，落库也换 store', async () => {
    useVocabStore.setState({ entries: [entry('a'), entry('b'), entry('c')] });
    await useVocabStore.getState().updateEntries([
      { ...entry('a'), meaningZh: '甲' },
      { ...entry('c'), meaningZh: '丙' },
    ]);

    expect(useVocabStore.getState().entries.map((e) => e.meaningZh)).toEqual(['甲', undefined, '丙']);
    const stored = await getAllVocabEntries();
    expect(stored.find((e) => e.id === 'a')?.meaningZh).toBe('甲');
  });

  it('**不覆盖 updatedAt** —— 那是调用方（applyZh）打好的，覆盖了「值没变就不算改过」就白设了', async () => {
    useVocabStore.setState({ entries: [entry('a')] });
    await useVocabStore.getState().updateEntries([{ ...entry('a'), meaningZh: '甲', updatedAt: 123 }]);
    expect(useVocabStore.getState().entries[0].updatedAt).toBe(123);
  });

  it('空数组是空操作', async () => {
    useVocabStore.setState({ entries: [entry('a')] });
    await useVocabStore.getState().updateEntries([]);
    expect(useVocabStore.getState().entries).toHaveLength(1);
  });
});
