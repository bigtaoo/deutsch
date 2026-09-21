// FR-9.5：查词面板里的「加入生词本」。
//
// 这条路径独有的两件事在别处测不到：
//   ① 建出来的卡**没有课**。它不是「课程丢了」，所以 `lookup` 这个标记必须在 ——
//      少了它，复习页会把这张卡送进「去这一课重新对齐」那条出口，而那一课不存在。
//   ② 词头用词典给的那一份。查 `Plattformen` 建出来的卡必须是 `Plattform`：
//      卡面要念这个词、卡背要显示 `die Plattform`，而变形没有性也没有复数。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useVocabStore } from './useVocabStore';
import { useSettingsStore } from './useSettingsStore';
import { DEFAULT_SETTINGS } from '@/db/meta';
import { cardAudioStatus } from '@/srs/queue';
import type { DictEntry } from '@/dict/types';

const prefetchWordAudio = vi.fn(async (words: string[]) => ({ human: words.length, missing: 0 }));

vi.mock('@/dict/lookup', () => ({
  loadDeck: vi.fn(async () => null),
  lookupDict: vi.fn(async () => null),
  dedupeKey: vi.fn(async (s: string) => s.toLowerCase()),
  dictMeta: vi.fn(async () => null),
}));
vi.mock('@/dict/audio', () => ({ prefetchWordAudio: (w: string[]) => prefetchWordAudio(w) }));
vi.mock('@/dict/online', () => ({ lookupOnline: vi.fn(async () => null) }));

const PLATTFORM: DictEntry = {
  w: 'Plattform',
  s: [{ p: 'noun', g: 'f', pl: 'Plattformen', ipa: 'platˈfɔʁm', de: ['ebene Fläche'], zh: ['平台'] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  useVocabStore.setState({ entries: [], loaded: true });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
});

describe('createFromLookup', () => {
  it('词头取词典那一份，性/复数/IPA/释义一起落进卡里', async () => {
    const entry = await useVocabStore.getState().createFromLookup({
      surface: 'Plattformen',
      dict: PLATTFORM,
    });
    expect(entry.surface).toBe('Plattform');
    expect(entry.lemma).toBe('Plattform');
    expect(entry.gender).toBe('f');
    expect(entry.plural).toBe('Plattformen');
    expect(entry.ipa).toBe('platˈfɔʁm');
    // 德语释义在前、中文跟在括号里（与标记生词时同一套 fieldsFromDict）
    expect(entry.meaning).toBe('ebene Fläche （平台）');
    expect(useVocabStore.getState().entries).toHaveLength(1);
  });

  it('没有课，但也不是「课程已删除」—— lookup 标记必须在', async () => {
    const entry = await useVocabStore.getState().createFromLookup({ surface: 'Zuversicht', dict: null });
    expect(entry.lookup).toBe(true);
    expect(entry.lessonId).toBeUndefined();
    expect(entry.sentenceIndex).toBeUndefined();
    expect(entry.contextSentence).toBeUndefined();
    expect(entry.preset).toBeUndefined();
    // 复习页据此走「孤立词发音」那一档，而不是「去这一课重新对齐」
    expect(cardAudioStatus(entry, false)).toBe('word-only');
  });

  it('词典查不到也收：原样存词形，释义留空让人自己填', async () => {
    const entry = await useVocabStore
      .getState()
      .createFromLookup({ surface: '  sich bewusst sein  ', dict: null });
    expect(entry.surface).toBe('sich bewusst sein');
    expect(entry.meaning).toBeUndefined();
    expect(entry.hasTimestamp).toBe(false);
    expect(entry.fsrs.state).toBe(0); // 新卡
  });

  it('FR-21.6：查词面板拿到的例句一并收下，最多两条', async () => {
    const entry = await useVocabStore.getState().createFromLookup({
      surface: 'Plattform',
      dict: PLATTFORM,
      examples: ['Erster Satz.', 'Zweiter Satz.', 'Dritter Satz.'],
    });
    // 这一趟不收，就永远没有第二次机会：`lookup` 卡多半是牌组外的词，
    // 内置词典里没有它的例句，开读卡时再查也是空的。
    expect(entry.examples).toEqual(['Erster Satz.', 'Zweiter Satz.']);
  });

  it('没有例句时不留一个空数组 —— 空数组会让开读卡时那条「已经有了」的判断误判', async () => {
    const entry = await useVocabStore.getState().createFromLookup({
      surface: 'Plattform',
      dict: PLATTFORM,
      examples: [],
    });
    expect(entry.examples).toBeUndefined();
  });

  it('加词时就把发音下下来（FR-17.6 的理由在这里逐字成立）', async () => {
    await useVocabStore.getState().createFromLookup({ surface: 'Plattformen', dict: PLATTFORM });
    expect(prefetchWordAudio).toHaveBeenCalledWith(['Plattform']);
  });
});
