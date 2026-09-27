// 学词页：点词秒加（FR-9.14）+ 本课生词候选（FR-9.13）+ 加完排队补中文（FR-9.15）。
// store 用真的（fake-indexeddb 上），只把词典、音频、AI 这三样外部依赖换掉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StudyTab } from './StudyTab';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/db/meta';
import { putLesson } from '@/db/lessons';
import type { DictEntry } from '@/dict/types';
import type { Lesson, VocabEntry } from '@/types/models';

const queueZhGloss = vi.fn();
vi.mock('@/ai/gloss', () => ({ queueZhGloss: (ids: string[]) => queueZhGloss(ids) }));
vi.mock('@/audio/useLessonAudio', () => ({ useLessonAudio: () => ({ status: 'none', error: null, duration: 0 }) }));

const DICT: Record<string, DictEntry> = {
  zuversicht: { w: 'Zuversicht', f: 100, s: [{ p: 'noun', g: 'f', de: ['feste Hoffnung'] }] },
  plattform: { w: 'Plattform', f: 500, s: [{ p: 'noun', g: 'f', de: ['erhöhte Fläche'] }] },
  und: { w: 'und', f: 900000, s: [{ p: 'conj' }] },
};
vi.mock('@/dict/lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/dict/lookup')>();
  const lookupDict = async (s: string) => {
    const entry = DICT[s.toLowerCase()];
    return entry ? { entry, via: 'exact' as const } : null;
  };
  return {
    ...actual,
    lookupDict,
    dedupeKey: async (s: string) => ((await lookupDict(s))?.entry.w ?? s).toLowerCase(),
    // 前 3000 名只放一个 `und`
    loadDeck: async (id: number) => (id === 1 ? { id: 1, label: '', words: [{ w: 'und', r: 1 }] } : { id, label: '', words: [] }),
  };
});

const TEXT = 'Zuversicht und Plattform';

function lesson(): Lesson {
  return {
    id: 'L1',
    title: 'Kapitel 1',
    source: { type: 'manual' },
    sentences: [
      {
        index: 0,
        text: TEXT,
        charStart: 0,
        charEnd: TEXT.length,
        startTime: 0,
        endTime: 3,
        endTimeExplicit: true,
        blanks: [],
        markedDifficult: false,
        excluded: false,
      },
    ],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Lesson;
}

/** 与 LessonPage 一样从 store 读这一课 —— 挖空写回去之后界面要跟着变 */
function Live() {
  const l = useLessonStore((st) => st.lessons[0]);
  return <StudyTab lesson={l} cache={undefined} />;
}

async function setup(existing: VocabEntry[] = []) {
  const l = lesson();
  await putLesson(l);
  useLessonStore.setState({ lessons: [l], caches: {} });
  useVocabStore.setState({ entries: existing, loaded: true });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, onlineDictFallback: false }, loaded: true });
  render(<Live />);
}

/** 正文里的那个词（候选列表里也有同名文字，所以限定在正文段落里找） */
function wordInText(word: string): HTMLElement {
  const para = screen.getAllByText(word, { selector: 'p.text-de span' });
  return para[0];
}

const blanks = () => useLessonStore.getState().lessons[0].sentences[0].blanks;

beforeEach(() => {
  queueZhGloss.mockClear();
  // 前一万的常见词形只放一个 `und`；另外两个词都不在里面
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(['und']))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('点词秒加（FR-9.14）', () => {
  it('点一下就建好词条和挖空，不弹确认；排队补中文；撤销等于一起删', async () => {
    await setup();
    fireEvent.click(wordInText('Zuversicht'));

    await screen.findByText(/已加「Zuversicht」/);
    expect(screen.queryByText('标记为生词并挖空')).toBeNull();
    const [entry] = useVocabStore.getState().entries;
    expect(entry).toMatchObject({ surface: 'Zuversicht', lemma: 'Zuversicht', gender: 'f', lessonId: 'L1' });
    expect(blanks()).toHaveLength(1);
    expect(queueZhGloss).toHaveBeenCalledWith([entry.id]);

    fireEvent.click(screen.getByText('撤销'));
    await waitFor(() => expect(blanks()).toHaveLength(0));
    await waitFor(() => expect(useVocabStore.getState().entries).toHaveLength(0));
  });

  it('生词本里已有这个词 → 挂到原词条上并如实说；撤销只取消挖空，原词条留着', async () => {
    const old = { id: 'old', surface: 'Zuversicht', lemma: 'Zuversicht', lessonId: 'other', createdAt: 0, updatedAt: 0 } as VocabEntry;
    await setup([old]);
    fireEvent.click(wordInText('Zuversicht'));

    await screen.findByText(/「Zuversicht」生词本里已有，挂到了原词条上/);
    expect(useVocabStore.getState().entries).toHaveLength(1);
    expect(blanks()[0].vocabEntryId).toBe('old');
    expect(queueZhGloss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('撤销'));
    await waitFor(() => expect(blanks()).toHaveLength(0));
    expect(useVocabStore.getState().entries.map((e) => e.id)).toEqual(['old']);
  });

  it('开着「连选」时点词只是选中，回到「选中 → 标记」两步', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: '连选' }));
    fireEvent.click(wordInText('Zuversicht'));
    fireEvent.click(wordInText('Plattform'));

    expect(await screen.findByText('标记为生词并挖空')).toBeInTheDocument();
    expect(useVocabStore.getState().entries).toHaveLength(0);
  });

  it('按住 Shift 点也是选中', async () => {
    await setup();
    fireEvent.click(wordInText('Zuversicht'), { shiftKey: true });
    expect(await screen.findByText('标记为生词并挖空')).toBeInTheDocument();
    expect(useVocabStore.getState().entries).toHaveLength(0);
  });
});

describe('本课生词候选（FR-9.13）', () => {
  it('去掉前 3000 名，按难度列；勾上的一次加进去并排队补中文', async () => {
    await setup();
    const section = (await screen.findByText('本课生词候选（2）')).closest('section')!;
    const boxes = within(section).getAllByRole('checkbox');
    // 难的在前：Zuversicht（f=100）比 Plattform（f=500）更少见
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual(['Zuversicht', 'Plattform']);
    expect(within(section).queryByText('und')).toBeNull();

    fireEvent.click(boxes[1]);
    fireEvent.click(within(section).getByRole('button', { name: '加入选中的 1 个' }));

    await waitFor(() => expect(useVocabStore.getState().entries.map((e) => e.surface)).toEqual(['Plattform']));
    expect(blanks()).toHaveLength(1);
    expect(queueZhGloss).toHaveBeenCalledWith([useVocabStore.getState().entries[0].id]);
    // 加进去的词不再是候选
    await screen.findByText('本课生词候选（1）');
  });

  it('「没勾的都认识」写进全局的 knownWords，列表随之清空', async () => {
    await setup();
    const section = (await screen.findByText('本课生词候选（2）')).closest('section')!;
    fireEvent.click(within(section).getAllByRole('checkbox')[0]);
    fireEvent.click(within(section).getByRole('button', { name: '没勾的 1 个都认识' }));

    await waitFor(() => expect(useSettingsStore.getState().settings.knownWords).toEqual(['plattform']));
    await screen.findByText('本课生词候选（1）');
  });
});
