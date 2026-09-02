import { describe, it, expect, vi } from 'vitest';
import { backfillRecent, BACKFILL_LIMITS } from './backfill';
import type { FeedItem } from './dw/rss';

const item = (id: string): FeedItem => ({
  lessonId: id,
  title: `Alltagsdeutsch ${id}`,
  link: `https://example.invalid/${id}`,
  pubDate: 0,
});

const ITEMS = ['a', 'b', 'c', 'd', 'e'].map(item);

/** 假导入：记下调用顺序，可以指定哪几期失败 / 哪几期没音频。 */
function fakeImport(opts: { fail?: string[]; noAudio?: string[] } = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (lessonId: string) => {
    calls.push(lessonId);
    if (opts.fail?.includes(lessonId)) throw new Error(`${lessonId} 改过稿`);
    return {
      lessonId,
      audioError: opts.noAudio?.includes(lessonId) ? '音频 404' : undefined,
      hasAudio: !opts.noAudio?.includes(lessonId),
    };
  });
  return { fn: fn as never, calls };
}

describe('backfillRecent', () => {
  it('按列表顺序串行导入，不并发', async () => {
    const { fn, calls } = fakeImport();
    const out = await backfillRecent({ items: ITEMS, importedIds: new Set(), limit: 3, importOne: fn });
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(out.imported).toEqual(['a', 'b', 'c']);
  });

  it('**先滤掉已导入的再截断** —— 否则「回填 3 期」在导过 2 期时只会新增 1 期', async () => {
    const { calls } = fakeImport();
    const { fn } = fakeImport();
    const out = await backfillRecent({
      items: ITEMS,
      importedIds: new Set(['a', 'b']),
      limit: 3,
      importOne: fn,
    });
    expect(out.imported).toEqual(['c', 'd', 'e']);
    expect(out.skipped).toBe(2);
    expect(calls).toEqual([]); // 用的是第二个 fake
  });

  it('一期失败不影响后面几期', async () => {
    // 一次十期里有一期改过稿就整批放弃，是最没用的失败方式。
    const { fn } = fakeImport({ fail: ['b'] });
    const out = await backfillRecent({ items: ITEMS, importedIds: new Set(), limit: 3, importOne: fn });
    expect(out.imported).toEqual(['a', 'c']);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toMatchObject({ lessonId: 'b' });
    expect(out.failed[0].error).toContain('改过稿');
  });

  it('音频没拿到的单独报出来（FR-13.9：课程照样建出来）', async () => {
    const { fn } = fakeImport({ noAudio: ['b'] });
    const out = await backfillRecent({ items: ITEMS, importedIds: new Set(), limit: 3, importOne: fn });
    expect(out.imported).toEqual(['a', 'b', 'c']);
    expect(out.withoutAudio).toEqual(['b']);
  });

  it('停在**期与期之间**，不会留下半篇课程', async () => {
    const { fn, calls } = fakeImport();
    let stop = false;
    const out = await backfillRecent({
      items: ITEMS,
      importedIds: new Set(),
      limit: 5,
      importOne: fn,
      shouldStop: () => stop,
      onProgress: ({ index }) => {
        if (index === 2) stop = true; // 第 2 期开始后要求停
      },
    });
    // 第 2 期已经开始了就让它做完，停在它之后 —— 半篇课程比不导入更糟。
    expect(calls).toEqual(['a', 'b']);
    expect(out.stopped).toBe(true);
  });

  it('limit 比可导入的多时导完就停，不报错', async () => {
    const { fn } = fakeImport();
    const out = await backfillRecent({ items: ITEMS, importedIds: new Set(), limit: 99, importOne: fn });
    expect(out.imported).toHaveLength(5);
  });

  it('全部都导入过时一个请求都不发', async () => {
    const { fn, calls } = fakeImport();
    const out = await backfillRecent({
      items: ITEMS,
      importedIds: new Set(['a', 'b', 'c', 'd', 'e']),
      limit: 10,
      importOne: fn,
    });
    expect(calls).toEqual([]);
    expect(out.imported).toEqual([]);
    expect(out.skipped).toBe(5);
  });

  it('limit <= 0 什么都不做', async () => {
    const { fn, calls } = fakeImport();
    await backfillRecent({ items: ITEMS, importedIds: new Set(), limit: 0, importOne: fn });
    expect(calls).toEqual([]);
  });
});

describe('§3.1.1 R-3 的形状约束', () => {
  it('可选期数有硬上限，且**没有「全部」**', () => {
    // R-3 点名禁止的是「一键导入全部 100 期」。上限就是这条禁令的实现，
    // 所以它是需求的一部分，不是随手写的常量 —— 放宽它等于改 SPEC。
    expect(Math.max(...BACKFILL_LIMITS)).toBeLessThanOrEqual(10);
    expect(BACKFILL_LIMITS).not.toContain(Infinity);
  });

  it('只从传进来的 RSS 列表里取 —— 不翻页、不猜 id、不爬归档', async () => {
    const { fn, calls } = fakeImport();
    await backfillRecent({ items: [item('only')], importedIds: new Set(), limit: 10, importOne: fn });
    expect(calls).toEqual(['only']);
  });
});
