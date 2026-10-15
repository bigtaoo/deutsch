// 变更 81：剧集（课程页列表）按季折叠；「接着往下导」导进来的课自动排对齐。

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
  backfillRecent: (opts: unknown) => backfillRecent(opts),
}));

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
    backfillRecent.mockResolvedValue({ imported: ['a', 'b'], withoutAudio: ['b'], failed: [], skipped: 0, stopped: false });
    await openJojo();
    fireEvent.click(await screen.findByText('往下导 3 集'));
    await screen.findByText(/导入 2 集/);
    expect(backfillRecent.mock.calls[0][0]).toMatchObject({ series: 'DW Jojo sucht das Glück', limit: 3 });
    expect(enqueue.mock.calls).toEqual([['a']]);
    expect(screen.getByText(/其中 1 集没拿到音频/)).toBeTruthy();
  });
});
