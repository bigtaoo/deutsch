// 变更 81：剧集（课程页列表）按季折叠；「接着往下导」导进来的课自动排对齐。
// 变更 82：一季一键导完、季里按 11 集分页、要中译的来源导完一集排一集中译。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAlignStore } from '@/state/useAlignStore';
import { useLessonStore } from '@/state/useLessonStore';
import type { FeedItem } from '@/sources/dw/rss';
import type { Lesson } from '@/types/models';

vi.mock('@/components/AppNav', () => ({ useDueCount: () => 0 }));
vi.mock('@/sync/trigger', () => ({ syncNow: vi.fn(), scheduleLessonSync: vi.fn(), syncLessonDeletion: vi.fn() }));

const episode = (id: string, title: string, group?: string): FeedItem => ({
  lessonId: id,
  title,
  link: `https://example.invalid/l-${id}`,
  pubDate: 0,
  ...(group ? { group, subtitle: `Lernziel ${id}` } : {}),
});
const EPISODES = [
  episode('11', '1 Die Ankunft', 'Staffel 1'),
  episode('12', '2 Jojo aus Brasilien', 'Staffel 1'),
  episode('21', '1 Überraschung', 'Staffel 2'),
  episode('22', '2 Die Geburtstagsfeier', 'Staffel 2'),
];
let cachedItems: FeedItem[] = EPISODES;
vi.mock('@/db/meta', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/meta')>()),
  getMeta: async (key: string) => (key === 'feedCache:dw-jojo' ? { items: cachedItems, fetchedAt: 0 } : undefined),
  putMeta: async () => {},
}));

const backfillRecent = vi.fn();
vi.mock('@/sources/backfill', () => ({
  BACKFILL_LIMITS: [3],
  SEASON_IMPORT_MAX: 40,
  backfillRecent: (opts: unknown) => backfillRecent(opts),
}));

/** 真的 backfillRecent 每集调一次 importOne；这里按 `ids` 依次调，音频有无由 `noAudio` 定。 */
const importFromDw = vi.fn();
vi.mock('@/sources/importLesson', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sources/importLesson')>()),
  importFromDw: (...args: unknown[]) => importFromDw(...args),
}));
function backfillImports(ids: string[], noAudio: string[] = []) {
  importFromDw.mockImplementation(async (id: string) => ({ lessonId: `local-${id}`, hasAudio: !noAudio.includes(id) }));
  backfillRecent.mockImplementation(async (opts: { importOne: (...a: unknown[]) => Promise<unknown> }) => {
    for (const id of ids) await opts.importOne(id, () => {}, undefined, 'x');
    return { imported: ids, withoutAudio: noAudio, failed: [], skipped: 0, stopped: false };
  });
}

const queueLessonTranslation = vi.fn();
vi.mock('@/ai/translate', () => ({ queueLessonTranslation: (ids: string[]) => queueLessonTranslation(ids) }));

const { SourcesPage } = await import('./SourcesPage');

const dwLesson = (id: string): Lesson => ({
  id: `local-${id}`,
  title: id,
  source: { type: 'dw', dwLessonId: id, sourceUrl: '' },
  sentences: [],
  createdAt: 0,
  updatedAt: 0,
});

const enqueue = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  cachedItems = EPISODES;
  useAlignStore.setState({ enqueue } as never);
});

async function openJojo() {
  render(<SourcesPage />);
  fireEvent.click(screen.getByText('DW Jojo sucht das Glück'));
}

const season = (prefix: string) => screen.getByText((t) => t.startsWith(prefix)).closest('details')!;

describe('剧集列表按季折叠', () => {
  it('摘要报已导数；默认只展开还有没导的第一季', async () => {
    useLessonStore.setState({ lessons: [dwLesson('11'), dwLesson('12')], caches: {}, loaded: true });
    await openJojo();
    await waitFor(() => expect(screen.getByText('Staffel 1 · 已导 2/2')).toBeTruthy());
    expect(screen.getByText('Staffel 2 · 已导 0/2')).toBeTruthy();
    expect(season('Staffel 1').open).toBe(false);
    expect(season('Staffel 2').open).toBe(true);
    // 副标题是这一集的学习目标
    expect(screen.getByText(/Lernziel 21/)).toBeTruthy();
  });

  it('RSS 列表没有季：照旧平铺，没有折叠', async () => {
    cachedItems = [episode('1', 'Folge A'), episode('2', 'Folge B')];
    useLessonStore.setState({ lessons: [], caches: {}, loaded: true });
    await openJojo();
    await screen.findByText('Folge A');
    expect(screen.getByText('Folge A').closest('details')).toBeNull();
  });
});

describe('接着往下导', () => {
  it('文案按「集」说；导进来、拿到音频的课排上对齐，没音频的不排', async () => {
    useLessonStore.setState({ lessons: [], caches: {}, loaded: true });
    backfillImports(['a', 'b'], ['b']);
    await openJojo();
    fireEvent.click(await screen.findByText('往下导 3 集'));
    await screen.findByText(/导入 2 集/);
    expect(backfillRecent.mock.calls[0][0]).toMatchObject({ series: 'DW Jojo sucht das Glück', limit: 3 });
    expect(enqueue.mock.calls).toEqual([['local-a']]);
    // Jojo 标了 autoTranslate：没音频的也排中译（中译只要文稿）
    expect(queueLessonTranslation.mock.calls).toEqual([[['local-a']], [['local-b']]]);
    expect(screen.getByText(/其中 1 集没拿到音频/)).toBeTruthy();
  });
});

describe('导入这一季（变更 82）', () => {
  it('一季全没导：按钮报整季集数，点了 limit 就是这一季、items 只给这一季', async () => {
    useLessonStore.setState({ lessons: [], caches: {}, loaded: true });
    backfillImports(['11', '12']);
    await openJojo();
    const [btn] = await screen.findAllByText('导入这一季 2 集'); // 两季都没导：各有一个
    expect(btn.closest('details')).toBe(season('Staffel 1'));
    fireEvent.click(btn);
    await screen.findByText(/导入 2 集/);
    const opts = backfillRecent.mock.calls[0][0] as { items: FeedItem[]; limit: number };
    expect(opts.items.map((i) => i.lessonId)).toEqual(['11', '12']);
    expect(opts.limit).toBe(2);
    expect(enqueue.mock.calls).toEqual([['local-11'], ['local-12']]);
  });

  it('导了一部分：说「剩下的」；全导完的季没有这个按钮', async () => {
    useLessonStore.setState({ lessons: [dwLesson('11'), dwLesson('12'), dwLesson('21')], caches: {}, loaded: true });
    await openJojo();
    await screen.findByText('导入这一季剩下的 1 集');
    expect(screen.queryByText(/导入这一季 2 集/)).toBeNull();
  });

  it('超过上限的一「季」（比如没分季的长列表）不给整季按钮', async () => {
    cachedItems = Array.from({ length: 41 }, (_, i) => episode(`${i}`, `${i + 1} Folge`, 'Staffel 9'));
    useLessonStore.setState({ lessons: [], caches: {}, loaded: true });
    await openJojo();
    await screen.findByText('Staffel 9 · 已导 0/41');
    expect(screen.queryByText(/导入这一季/)).toBeNull();
  });
});

describe('季里按 11 集分页（变更 82 / §12.22）', () => {
  const big = Array.from({ length: 33 }, (_, i) => episode(`${100 + i}`, `${i + 1} Folge ${i + 1}`, 'Staffel 1'));

  it('33 集切三页；默认翻到第一集没导的那一页；点别的页换内容', async () => {
    cachedItems = big;
    useLessonStore.setState({ lessons: big.slice(0, 13).map((e) => dwLesson(e.lessonId)), caches: {}, loaded: true });
    await openJojo();
    const page2 = await screen.findByRole('button', { name: '12–22' });
    expect(page2.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('14 Folge 14')).toBeTruthy();
    expect(screen.queryByText('1 Folge 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '1–11' }));
    expect(screen.getByText('1 Folge 1')).toBeTruthy();
    expect(screen.queryByText('14 Folge 14')).toBeNull();
    expect(screen.getByRole('button', { name: '23–33' })).toBeTruthy();
  });

  it('11 集以内不出分页按钮', async () => {
    useLessonStore.setState({ lessons: [], caches: {}, loaded: true });
    await openJojo();
    await screen.findByText('Staffel 2 · 已导 0/2');
    expect(screen.queryByRole('group', { name: '分页' })).toBeNull();
  });
});
