// 单词页（变更 84 / §12.21）：今日卡片 → 查词 → 「词库」折叠块。
//
// 今日卡片单独测（纯展示组件，数直接给）：`今天 x / total`、进度条、主按钮文案、做完换成一句话、
// 没词库时的拦路提示。整页测「词库」里能做的事：斩掉的可以撤回、标记的中文可以改、范围 chips 落库。
// 查词面板有自己的依赖（词典、wiktionary、AI），这里 stub 掉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME, META_KEYS } from '@/db/schema';
import { putMeta } from '@/db/meta';
import { emptyDrillState, getDrillState, putDrillState, withMark } from '@/drill/state';
import { navigate } from '@/app/router';
import { scheduleDrillSync } from '@/sync/trigger';
import type { CachedWordbank } from '@/drill/types';

vi.mock('@/sync/trigger', () => ({ scheduleDrillSync: vi.fn(), syncDrillNow: vi.fn(async () => {}) }));
vi.mock('./vocab/DictLookup', () => ({ DictLookup: () => <div data-testid="dict-lookup" /> }));
vi.mock('@/app/router', async (orig) => ({ ...(await orig<typeof import('@/app/router')>()), navigate: vi.fn() }));

const { VocabPage, TodayCard } = await import('./VocabPage');

const BANK: CachedWordbank = {
  version: 't1',
  fetchedAt: 0,
  items: [
    { id: 'kaution', w: 'Kaution', p: 'noun', g: 'f', zh: '押金', t: 'wohnen' },
    { id: 'mieter', w: 'Mieter', p: 'noun', g: 'm', zh: '租户', t: 'wohnen' },
  ],
};

beforeEach(async () => {
  await putMeta(META_KEYS.drillWordbank, BANK);
});

afterEach(async () => {
  vi.clearAllMocks();
  const db = await getDB();
  db.close();
  _resetDBForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe('今日卡片', () => {
  const base = { total: 200, done: 0, remaining: 200, remainingReview: 40, remainingNew: 160, target: 200, hasPool: true };

  it('还没开始：0 / 200、到期与新词分开写、主按钮是「开始」', () => {
    render(<TodayCard {...base} />);
    expect(screen.getByText('0 / 200')).toBeTruthy();
    expect(screen.getByText('到期复习 40 · 新词 160')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始' })).toBeTruthy();
  });

  it('背了一部分：主按钮变「继续」，进度条跟着走；点了进会话', () => {
    render(<TodayCard {...base} done={87} remaining={113} />);
    expect(screen.getByText('87 / 200')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('87');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'drill' });
  });

  it('背完了：没有按钮，只有一句话', () => {
    render(<TodayCard {...base} done={200} remaining={0} />);
    expect(screen.getByText('今天的 200 个背完了。明天再来。')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('池子是空的：说清是词库没下载，不画一张 0 / 0 的卡', () => {
    render(<TodayCard {...base} total={0} remaining={0} hasPool={false} />);
    expect(screen.getByText(/词库还没下载/)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('整页', () => {
  it('今日卡片 + 查词 + 词库，三块都在', async () => {
    render(<VocabPage />);
    expect(await screen.findByRole('region', { name: '今天' })).toBeTruthy();
    expect(screen.getByTestId('dict-lookup')).toBeTruthy();
    expect(screen.getByText('词库')).toBeTruthy();
    expect(screen.getByText(/词库 2 个词 · 版本 t1/)).toBeTruthy();
  });

  it('斩掉的可以撤回：known 落回 false，并触发同步', async () => {
    await putDrillState(withMark(emptyDrillState(), 'kaution', { known: true }, 1));
    render(<VocabPage />);
    fireEvent.click(await screen.findByRole('button', { name: '撤回' }));
    await waitFor(async () => expect((await getDrillState()).marks.kaution?.known).toBe(false));
    expect(scheduleDrillSync).toHaveBeenCalled();
  });

  it('已标记的词可以改中文', async () => {
    await putDrillState(withMark(emptyDrillState(), 'mieter', { flagged: true }, 1));
    render(<VocabPage />);
    // 全量并行跑时机器忙，默认 1 秒偶尔等不到（变更 85 收尾时抖过一次）
    const input = await screen.findByLabelText('Mieter 的中文', undefined, { timeout: 5000 });
    fireEvent.change(input, { target: { value: '房客' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => expect((await getDrillState()).marks.mieter?.zh).toBe('房客'), { timeout: 5000 });
  });
});
