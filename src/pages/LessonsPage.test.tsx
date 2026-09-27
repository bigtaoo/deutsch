// FR-1.9 / FR-3.6a：课程列表的分组、组内顺序、展开状态、整组补音频。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLessonStore } from '@/state/useLessonStore';
import type { Lesson, LessonCache } from '@/types/models';

vi.mock('@/components/AppNav', () => ({ useDueCount: () => 0 }));
vi.mock('@/sync/trigger', () => ({ syncNow: vi.fn(), scheduleLessonSync: vi.fn(), syncLessonDeletion: vi.fn() }));
const bindPickedAudio = vi.fn();
const restoreServerAudio = vi.fn();
let syncConfigured = true;
vi.mock('@/sync/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/config')>()),
  isSyncConfigured: () => syncConfigured,
}));
vi.mock('@/lesson/bindAudio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lesson/bindAudio')>()),
  bindPickedAudio: (lesson: Lesson, files: File[]) => bindPickedAudio(lesson, files),
  restoreServerAudio: (lesson: Lesson) => restoreServerAudio(lesson),
}));

const { LessonsPage, groupBindSummary, groupDownloadSummary, groupLessons, splitChapters, DW_FALLBACK_GROUP } = await import(
  './LessonsPage'
);

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
  syncConfigured = true;
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

describe('分组块 · 音频在同步服务器上（变更 69）', () => {
  const ref = (bytes: number) => ({ sha256: 'a'.repeat(64), bytes });
  const onServer = (id: string, title: string, bytes = 2_000_000) =>
    lesson(id, title, 'Aspekte neu C1', { source: { type: 'manual', audioFileName: `${id}.mp3` }, audioRef: ref(bytes) });
  const local = (id: string, title: string) =>
    lesson(id, title, 'Aspekte neu C1', { source: { type: 'manual', audioFileName: `${id}.mp3` } });

  it('服务器上有的一键下载（报总大小），没有的才让选文件；两条各报各的课数', () => {
    seed([onServer('a', 'Kapitel 7 · Modul 2 Aufgabe 3a'), onServer('b', 'Kapitel 7 · Modul 2 Aufgabe 3b'), local('c', 'Kapitel 7 · Modul 4 Aufgabe 3')]);
    render(<LessonsPage />);
    fireEvent.click(summary('Aspekte neu C1'));
    const group = details('Aspekte neu C1');
    expect(within(group).getByRole('button', { name: '下载这 2 课' })).toBeInTheDocument();
    expect(within(group).getByText(/2 课的音频在同步服务器上（共 3\.8 MB）/)).toBeInTheDocument();
    expect(within(group).getByText(/1 课在这台设备上还没有音频/)).toBeInTheDocument();
    expect(within(summary('Aspekte neu C1')).getByText('3 课缺音频')).toBeInTheDocument();
  });

  it('一次下完：逐课下载，摘要报数；失败的那课报出来', async () => {
    restoreServerAudio.mockResolvedValueOnce({ realigned: false }).mockRejectedValueOnce(new Error('断网'));
    seed([onServer('a', 'Kapitel 7 · Modul 2 Aufgabe 3a'), onServer('b', 'Kapitel 7 · Modul 2 Aufgabe 3b')]);
    render(<LessonsPage />);
    fireEvent.click(summary('Aspekte neu C1'));
    fireEvent.click(screen.getByRole('button', { name: '下载这 2 课' }));
    expect(await screen.findByText('下载了 1 课，时间戳都是同步来的，不用重对，1 课没下下来，再点一次会接着下。')).toBeInTheDocument();
    expect(restoreServerAudio.mock.calls.map(([l]) => (l as Lesson).id)).toEqual(['a', 'b']);
  });

  it('全都在服务器上：不出现「一次选齐音频」', () => {
    seed([onServer('a', 'Kapitel 7 · Modul 2 Aufgabe 3a')]);
    render(<LessonsPage />);
    fireEvent.click(summary('Aspekte neu C1'));
    expect(screen.queryByText('一次选齐音频…')).toBeNull();
  });

  it('本机有音频、还没传上去的课：报一条「还没传到同步服务器」；传过的不算', () => {
    seed(
      [local('a', 'Kapitel 7 · Modul 2 Aufgabe 3a'), onServer('b', 'Kapitel 7 · Modul 2 Aufgabe 3b', 1)],
      { a: cached('a'), b: cached('b') },
    );
    render(<LessonsPage />);
    fireEvent.click(summary('Aspekte neu C1'));
    expect(screen.getByText(/^1 课的音频还没传到同步服务器/)).toBeInTheDocument();
  });

  it('没配同步服务器的构建：不提「还没传」—— 那里压根不会传', () => {
    syncConfigured = false;
    seed([local('a', 'Kapitel 7 · Modul 2 Aufgabe 3a')], { a: cached('a') });
    render(<LessonsPage />);
    fireEvent.click(summary('Aspekte neu C1'));
    expect(screen.queryByText(/还没传到同步服务器/)).toBeNull();
    syncConfigured = true;
  });

  it('groupDownloadSummary：要重对的、失败的都报；一课都没下到时不说「不用重对」', () => {
    expect(groupDownloadSummary(3, 1, 0)).toBe('下载了 3 课，其中 1 课要重新对齐。');
    expect(groupDownloadSummary(0, 0, 2)).toBe('下载了 0 课，2 课没下下来，再点一次会接着下。');
  });
});

// 2026-09-27：DW 的课也进折叠组；教材组里再按章折叠一层。
const dw = (id: string, title: string, createdAt: number, collection?: string): Lesson =>
  lesson(id, title, collection, { source: { type: 'dw', dwLessonId: id, sourceUrl: '' }, createdAt });

describe('DW 的课分组', () => {
  it('没记来源的 DW 课归「DW Alltagsdeutsch」；记了来源的各进各组；手动导入、没分组的照旧平铺', () => {
    const { ungrouped, groups } = groupLessons([
      dw('w1', 'Der deutsche Wald', 1),
      dw('t1', 'Klimawandel', 2, 'DW Top-Thema'),
      lesson('m', '自己粘的一课'),
    ]);
    expect(ungrouped.map((l) => l.id)).toEqual(['m']);
    expect(groups.map(([name, list]) => [name, list.map((l) => l.id)])).toEqual([
      [DW_FALLBACK_GROUP, ['w1']],
      ['DW Top-Thema', ['t1']],
    ]);
  });

  it('全是 DW 的组按导入时间新的在上 —— DW 的标题是文章名，按字母排没意义', () => {
    const { groups } = groupLessons([dw('a', 'Apfel', 1), dw('z', 'Zug', 3), dw('m', 'Mond', 2)]);
    expect(groups[0][1].map((l) => l.id)).toEqual(['z', 'm', 'a']);
  });

  it('页面上 DW 的课是一个折叠组，默认收起', () => {
    seed([dw('w1', 'Der deutsche Wald', 1), dw('w2', 'Brot', 2)], { w1: cached('w1'), w2: cached('w2') });
    render(<LessonsPage />);
    expect(details(DW_FALLBACK_GROUP)).not.toHaveAttribute('open');
    expect(within(summary(DW_FALLBACK_GROUP)).getByText('2 课 · 已对齐 0')).toBeInTheDocument();
    expect(within(details(DW_FALLBACK_GROUP)).getByText('Brot')).toBeInTheDocument();
  });
});

describe('教材组里按章折叠', () => {
  const book = [
    lesson('a', 'Kapitel 1 · Auftakt Aufgabe 2a', 'B'),
    lesson('b', 'Kapitel 1 · Modul 2 Aufgabe 2', 'B'),
    lesson('c', 'Kapitel 10 · Modul 4 Aufgabe 1', 'B'),
    lesson('d', 'Kapitel 2 · Modul 1 Aufgabe 1', 'B'),
  ];

  it('splitChapters：按「Kapitel N · 」分章，顺序跟着自然排序走；没有章前缀的放在前面', () => {
    const sorted = groupLessons([...book, lesson('x', 'Wortschatz', 'B')]).groups[0][1];
    const { loose, chapters } = splitChapters(sorted);
    expect(loose.map((l) => l.id)).toEqual(['x']);
    expect(chapters.map(([c, list]) => [c, list.map((l) => l.id)])).toEqual([
      ['Kapitel 1', ['a', 'b']],
      ['Kapitel 2', ['d']],
      ['Kapitel 10', ['c']],
    ]);
  });

  it('只有一章时不再套一层（多点一下没意义）', () => {
    const { loose, chapters } = splitChapters(book.slice(0, 2));
    expect(chapters).toEqual([]);
    expect(loose.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('页面上：章也是折叠块、默认收起、报课数；章里的行不再重复「Kapitel N · 」', () => {
    const withFile = (l: Lesson): Lesson => ({ ...l, source: { type: 'manual', audioFileName: `${l.id}.mp3` } });
    seed(book.map(withFile), { a: cached('a'), b: cached('b'), c: cached('c') });
    render(<LessonsPage />);
    const ch1 = details('Kapitel 1');
    expect(ch1).not.toHaveAttribute('open');
    expect(ch1.parentElement!.closest('details')).toBe(details('B'));
    expect(within(summary('Kapitel 1')).getByText('2 课 · 已对齐 0')).toBeInTheDocument();
    expect(within(ch1).getByText('Auftakt Aufgabe 2a')).toBeInTheDocument();
    expect(screen.queryByText('Kapitel 1 · Auftakt Aufgabe 2a')).toBeNull();
    expect(within(summary('Kapitel 2')).getByText('1 课缺音频')).toBeInTheDocument();
  });

  it('章的展开状态单独记，键是「组名 › 章」，不和同名的组混', () => {
    seed(book, {});
    const first = render(<LessonsPage />);
    const ch = details('Kapitel 2');
    ch.open = true;
    fireEvent(ch, new Event('toggle'));
    expect(JSON.parse(store.get('lessons.openGroups')!)).toEqual(['B › Kapitel 2']);
    first.unmount();
    render(<LessonsPage />);
    expect(details('Kapitel 2')).toHaveAttribute('open');
    expect(details('Kapitel 1')).not.toHaveAttribute('open');
    expect(details('B')).not.toHaveAttribute('open');
  });
});

describe('「还没传到同步服务器」与上传扫描同一个判据', () => {
  it('audioRef 被别的设备改过、本机这份不是新选的：不算还没传（不会回传，也就不该一直挂着这条）', () => {
    seed(
      [
        lesson('a', 'A', 'X', { audioRef: { sha256: 'a'.repeat(64), bytes: 999 } }),
        lesson('b', 'B', 'X', { audioRef: { sha256: 'b'.repeat(64), bytes: 999 } }),
      ],
      { a: cached('a'), b: { ...cached('b'), audioPendingUpload: true } },
    );
    render(<LessonsPage />);
    expect(within(details('X')).getByText(/^1 课的音频还没传到同步服务器/)).toBeInTheDocument();
  });
});
