// 变更 82 / §12.22：长列表 11 个一页。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChunkTabs, chunk, chunkLabel } from './ChunkTabs';

const nums = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const list = (page: number[]) => <ul>{page.map((n) => <li key={n}>第 {n} 课</li>)}</ul>;

// jsdom 在这套配置下不给 localStorage（opaque origin，见 align/journal.test.ts），自己给一个。
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});
beforeEach(() => store.clear());

describe('chunk / chunkLabel', () => {
  it('33 → 三块 11；34 → 第四块只有一个', () => {
    expect(chunk(nums(33)).map((c) => c.length)).toEqual([11, 11, 11]);
    expect(chunk(nums(34)).map((c) => c.length)).toEqual([11, 11, 11, 1]);
    expect(chunk([])).toEqual([]);
  });

  it('标签按位置从 1 数；只有一个时不写成区间', () => {
    expect(chunkLabel(0, 11)).toBe('1–11');
    expect(chunkLabel(2, 11)).toBe('23–33');
    expect(chunkLabel(3, 1)).toBe('34');
    expect(chunkLabel(1, 4)).toBe('12–15');
  });
});

describe('ChunkTabs', () => {
  it('11 个以内：没有分页按钮，全部直接出来', () => {
    render(<ChunkTabs items={nums(11)}>{list}</ChunkTabs>);
    expect(screen.queryByRole('group', { name: '分页' })).toBeNull();
    expect(screen.getByText('第 11 课')).toBeTruthy();
  });

  it('选中的那页记在本机：重新挂载仍是那一页，压过 defaultIndex', () => {
    const { unmount } = render(
      <ChunkTabs items={nums(33)} storageKey="书 › Kap. 1">
        {list}
      </ChunkTabs>,
    );
    expect(screen.getByRole('button', { name: '1–11' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '23–33' }));
    expect(screen.getByText('第 23 课')).toBeTruthy();
    expect(screen.queryByText('第 1 课')).toBeNull();
    unmount();

    render(
      <ChunkTabs items={nums(33)} storageKey="书 › Kap. 1" defaultIndex={1}>
        {list}
      </ChunkTabs>,
    );
    expect(screen.getByRole('button', { name: '23–33' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('记住的页数超出了（列表变短）：落到最后一页，不出空白', () => {
    localStorage.setItem('chunkTabs', JSON.stringify({ k: 5 }));
    render(
      <ChunkTabs items={nums(15)} storageKey="k">
        {list}
      </ChunkTabs>,
    );
    expect(screen.getByRole('button', { name: '12–15' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('第 15 课')).toBeTruthy();
  });
});
