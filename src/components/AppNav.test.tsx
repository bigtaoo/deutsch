// SPEC §12.1 的导航契约：**三个活动 + 一个抽屉**。
//
// 这是形状类规定，不是功能规定 —— 所以从 FR 编号里推不出来，靠人眼也看不出「少了一项」
// （少的那一项只是不在了）。判据一句话：这是不是一件我今天要做的事。
// 「来源 / 素材 / 记录 / 设置」都不是，所以它们在抽屉里；到期张数只贴在复习上。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { useVocabStore } from '@/state/useVocabStore';
import { newCard } from '@/srs/fsrs';
import type { Route } from '@/app/router';
import type { VocabEntry } from '@/types/models';

// SyncChip 要读同步状态、发网络请求；导航的形状与它无关。
vi.mock('./SyncChip', () => ({ SyncChip: () => <span data-testid="sync-chip" /> }));

const { BottomTabs, TopBar, shouldShowBottomTabs } = await import('./AppNav');

function due(id: string, overrides: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id,
    surface: id,
    hasTimestamp: false,
    suspended: false,
    fsrs: { ...newCard(new Date(Date.now() - 86_400_000)) },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useVocabStore.setState({ entries: [] });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shouldShowBottomTabs（§12.2：底部一次只有一层）', () => {
  it('活动页与抽屉页都画标签栏', () => {
    const routes: Route[] = [
      { name: 'lessons' },
      { name: 'review' },
      { name: 'vocab' },
      { name: 'sources' },
      { name: 'cache' },
      { name: 'record' },
      { name: 'settings' },
    ];
    for (const route of routes) expect(shouldShowBottomTabs(route)).toBe(true);
  });

  it('课程页与导入页不画 —— 底部让给音频条', () => {
    expect(shouldShowBottomTabs({ name: 'lesson', lessonId: 'l1', tab: 'listen' })).toBe(false);
    expect(shouldShowBottomTabs({ name: 'import' })).toBe(false);
  });
});

describe('底部标签栏', () => {
  it('正好三个活动：课程、复习、生词本', () => {
    render(<BottomTabs route={{ name: 'lessons' }} />);
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['课程', '复习', '生词本']);
  });

  it('管道页不在标签栏里', () => {
    render(<BottomTabs route={{ name: 'lessons' }} />);
    for (const label of ['来源', '素材', '记录', '设置']) {
      expect(screen.queryByRole('link', { name: label })).toBeNull();
    }
  });

  it('当前活动带 aria-current，别的没有', () => {
    render(<BottomTabs route={{ name: 'review' }} />);
    expect(screen.getByRole('link', { current: 'page' })).toHaveTextContent('复习');
  });

  it('到期张数只贴在复习上', () => {
    useVocabStore.setState({ entries: [due('a'), due('b')] });
    render(<BottomTabs route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /复习/ })).toHaveTextContent('2');
    expect(screen.getByRole('link', { name: /课程/ })).not.toHaveTextContent('2');
  });

  it('没有到期的就不显示角标 —— 空徽章比没有徽章更吵', () => {
    useVocabStore.setState({
      entries: [due('a', { fsrs: newCard(new Date(Date.now() + 86_400_000)) })],
    });
    render(<BottomTabs route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /复习/ }).textContent).toBe('复习');
  });

  it('挂起的生词不算到期（它被人为按下了）', () => {
    useVocabStore.setState({ entries: [due('a', { suspended: true })] });
    render(<BottomTabs route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /复习/ }).textContent).toBe('复习');
  });

  it('超过 99 显示 99+', () => {
    useVocabStore.setState({ entries: Array.from({ length: 120 }, (_, i) => due(`w${i}`)) });
    render(<BottomTabs route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /复习/ })).toHaveTextContent('99+');
  });
});

describe('顶部栏', () => {
  it('抽屉里正好那四个管道页，每个都带一行说明', () => {
    render(<TopBar route={{ name: 'lessons' }} />);
    const drawer = screen.getByLabelText('更多').parentElement!;
    const labels = within(drawer)
      .getAllByRole('link')
      .map((a) => a.firstChild?.textContent);
    expect(labels).toEqual(['来源', '素材', '记录', '设置']);
    expect(within(drawer).getByText('本机音频用量与清理')).toBeInTheDocument();
  });

  it('详情页在手机上给一个回课程列表的入口（带「‹」的那个）', () => {
    render(<TopBar route={{ name: 'lesson', lessonId: 'l1', tab: 'listen' }} />);
    const back = screen
      .getAllByRole('link', { name: /课程/ })
      .find((a) => a.textContent?.includes('‹'));
    expect(back).toHaveAttribute('href', '#/lessons');
  });

  it('非详情页没有那个返回入口', () => {
    render(<TopBar route={{ name: 'lessons' }} />);
    expect(screen.queryByText('‹')).toBeNull();
  });

  it('抽屉页上标题显示的是那一页的名字，不是「精听」', () => {
    render(<TopBar route={{ name: 'cache' }} />);
    // 「素材」同时出现在抽屉的链接里，所以只认标题那个 <span>。
    const title = screen.getAllByText('素材').find((el) => el.tagName === 'SPAN');
    expect(title).toBeInTheDocument();
    expect(screen.queryByText('精听')).toBeNull();
  });
});
