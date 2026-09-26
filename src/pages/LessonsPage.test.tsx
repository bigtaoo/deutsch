// FR-1.9 / FR-3.6a：课程列表的分组、组内顺序、展开状态、整组补音频。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLessonStore } from '@/state/useLessonStore';
import type { Lesson, LessonCache } from '@/types/models';

vi.mock('@/components/AppNav', () => ({ useDueCount: () => 0 }));
vi.mock('@/sync/trigger', () => ({ syncNow: vi.fn(), scheduleLessonSync: vi.fn(), syncLessonDeletion: vi.fn() }));
const bindPickedAudio = vi.fn();
vi.mock('@/lesson/bindAudio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lesson/bindAudio')>()),
  bindPickedAudio: (lesson: Lesson, files: File[]) => bindPickedAudio(lesson, files),
}));

const { LessonsPage, groupBindSummary, groupLessons } = await import('./LessonsPage');

function lesson(id: string, title: string, collection?: string, extra: Partial<Lesson> = {}): Lesson {
  return {
    id,
    title,
    source: { type: 'manual' },
    sentences: [],
    createdAt: 0,
    updatedAt: 0,
    ...(collection ? { collection } : {}),
    ...extra,
  };
}

const cached = (id: string): LessonCache => ({ lessonId: id, hasAudio: true, audioBytes: 1, fetchedAt: 0 });

function seed(lessons: Lesson[], caches: Record<string, LessonCache> = {}) {
  useLessonStore.setState({ lessons, caches, loaded: true });
}

const summary = (name: string) => screen.getByText(name).closest('summary')!;
const details = (name: string) => screen.getByText(name).closest('details')!;

function pickInGroup(name: string, files: string[]) {
  const input = details(name).querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files.map((n) => new File([], n)), configurable: true });
  fireEvent.change(input);
}

// jsdom 在这套配置下不给 localStorage（opaque origin，见 align/journal.test.ts），自己给一个。
let store: Map<string, string>;
function stubStorage(overrides: Partial<Storage> = {}) {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LessonsPage 的分组块', () => {
  it('默认折叠；摘要行报课数与已对齐数', () => {
    seed([
      lesson('a', 'Kapitel 1 · A', 'Aspekte neu C1', {
        sentences: [{ index: 0, text: 'x', charStart: 0, charEnd: 1, startTime: 0, endTimeExplicit: false, blanks: [], markedDifficult: false, excluded: false }],
      }),
      lesson('b', 'Kapitel 1 · B', 'Aspekte neu C1'),
    ], { a: cached('a'), b: cached('b') });
    render(<LessonsPage />);
    expect(details('Aspekte neu C1')).not.toHaveAttribute('open');
    expect(within(summary('Aspekte neu C1')).getByText('2 课 · 已对齐 1')).toBeInTheDocument();
  });

  it('展开状态记在本机：卸载重进之后仍然展开，收起之后也记得收起', () => {
    seed([lesson('a', 'A', 'Aspekte neu C1')], { a: cached('a') });
    const first = render(<LessonsPage />);
    const d = details('Aspekte neu C1');
    d.open = true;
    fireEvent(d, new Event('toggle'));
    expect(JSON.parse(store.get('lessons.openGroups')!)).toEqual(['Aspekte neu C1']);
    first.unmount();

    render(<LessonsPage />);
    expect(details('Aspekte neu C1')).toHaveAttribute('open');
    const again = details('Aspekte neu C1');
    again.open = false;
    fireEvent(again, new Event('toggle'));
    expect(JSON.parse(store.get('lessons.openGroups')!)).toEqual([]);
  });

  it('localStorage 读写都抛（私密窗口）：照样渲染、照样能展开', () => {
    const boom = () => {
      throw new Error('SecurityError');
    };
    stubStorage({ getItem: boom, setItem: boom });
    seed([lesson('a', 'A', 'Aspekte neu C1')], { a: cached('a') });
    render(<LessonsPage />);
    const d = details('Aspekte neu C1');
    d.open = true;
    expect(() => fireEvent(d, new Event('toggle'))).not.toThrow();
    expect(d).toHaveAttribute('open');
  });

  it('压根没有 localStorage（引用即抛 ReferenceError）也照样渲染', () => {
    vi.unstubAllGlobals();
    seed([lesson('a', 'A', 'Aspekte neu C1')], { a: cached('a') });
    render(<LessonsPage />);
    expect(details('Aspekte neu C1')).not.toHaveAttribute('open');
  });

  it('存进去的不是数组（被别的东西写坏了）当作什么都没展开', () => {
    store.set('lessons.openGroups', '{"kaputt":1}');
    seed([lesson('a', 'A', 'Aspekte neu C1')], { a: cached('a') });
    render(<LessonsPage />);
    expect(details('Aspekte neu C1')).not.toHaveAttribute('open');
  });

  it('组里没有缺音频的课时，不出现「一次选齐音频」', () => {
    seed([lesson('a', 'A', 'X', { source: { type: 'manual', audioFileName: 'a.mp3' } })], { a: cached('a') });
    render(<LessonsPage />);
    expect(within(details('X')).queryByText('一次选齐音频…')).toBeNull();
  });

  it('没记过文件名的课不算「缺音频」—— 它只能在自己的课程页里手动选', () => {
    seed([lesson('a', 'A', 'X')]);
    render(<LessonsPage />);
    expect(screen.queryByText(/课缺音频/)).toBeNull();
  });

  it('一次选齐：只把认领到的课交给 bindPickedAudio，结果摘要里有认领不到的与读不出来的', async () => {
    bindPickedAudio
      .mockResolvedValueOnce({ ok: true, realigned: false })
      .mockRejectedValueOnce(new Error('decode'));
    seed([
      lesson('a', 'Kapitel 1 · A', 'X', { source: { type: 'manual', audioFileName: '1.mp3' } }),
      lesson('b', 'Kapitel 1 · B', 'X', { source: { type: 'manual', audioFiles: ['2.mp3', '3.mp3'] } }),
      lesson('c', 'Kapitel 1 · C', 'X', { source: { type: 'manual', audioFileName: '9.mp3' } }),
    ]);
    render(<LessonsPage />);
    expect(within(summary('X')).getByText('3 课缺音频')).toBeInTheDocument();

    pickInGroup('X', ['3.mp3', '1.mp3', '2.mp3']);

    expect(await screen.findByText('补上了 1 课，时间戳都是同步来的，不用重对，还有 1 课的文件不在这次选的里面，1 课读不出来。')).toBeInTheDocument();
    expect(bindPickedAudio.mock.calls.map(([l, files]) => [l.id, files.map((f: File) => f.name)])).toEqual([
      ['a', ['1.mp3']],
      ['b', ['2.mp3', '3.mp3']],
    ]);
  });

  it('要重对的课在摘要里报数', async () => {
    bindPickedAudio.mockResolvedValue({ ok: true, realigned: true });
    seed([lesson('a', 'A', 'X', { source: { type: 'manual', audioFileName: '1.mp3' } })]);
    render(<LessonsPage />);
    pickInGroup('X', ['1.mp3']);
    await waitFor(() => expect(screen.getByText('补上了 1 课，其中 1 课要重新对齐。')).toBeInTheDocument());
  });
});

describe('groupLessons', () => {
  it('没分组的课保持原来的顺序，分组的课各进各组', () => {
    const { ungrouped, groups } = groupLessons([
      lesson('dw2', 'Alltagsdeutsch: B'),
      lesson('k10', 'Kapitel 10 · Modul 2 Aufgabe 2a', 'Aspekte neu C1'),
      lesson('dw1', 'Alltagsdeutsch: A'),
      lesson('k2', 'Kapitel 2 · Auftakt Aufgabe 2a', 'Aspekte neu C1'),
      lesson('m1', 'Lektion 1', 'Menschen B1'),
    ]);
    expect(ungrouped.map((l) => l.id)).toEqual(['dw2', 'dw1']);
    expect(groups.map(([name, members]) => [name, members.map((l) => l.id)])).toEqual([
      ['Aspekte neu C1', ['k2', 'k10']], // 自然排序：2 在 10 前面，不管先导的是哪一课
      ['Menschen B1', ['m1']],
    ]);
  });

  it('同一章里 Auftakt 排在 Modul 前面、Modul 按编号排', () => {
    const { groups } = groupLessons([
      lesson('b', 'Kapitel 1 · Modul 4 Aufgabe 2c', 'X'),
      lesson('a', 'Kapitel 1 · Modul 2 Aufgabe 2a', 'X'),
      lesson('c', 'Kapitel 1 · Auftakt Aufgabe 1', 'X'),
    ]);
    expect(groups[0][1].map((l) => l.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('groupBindSummary', () => {
  it('同步来的时间戳不用重对时明说', () => {
    expect(groupBindSummary(12, 0, 0, 0)).toBe('补上了 12 课，时间戳都是同步来的，不用重对。');
  });

  it('要重对的、认领不到的、读不出来的都报数', () => {
    expect(groupBindSummary(3, 1, 2, 1)).toBe('补上了 3 课，其中 1 课要重新对齐，还有 2 课的文件不在这次选的里面，1 课读不出来。');
  });

  it('一课都没补上时不说「不用重对」', () => {
    expect(groupBindSummary(0, 0, 5, 0)).toBe('补上了 0 课，还有 5 课的文件不在这次选的里面。');
  });
});
