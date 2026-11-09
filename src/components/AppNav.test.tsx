// SPEC §12.1 的导航契约：**两个活动 + 一个抽屉**（变更 84：复习撤掉，生词本收成「单词」）。
//
// 这是形状类规定，不是功能规定 —— 所以从 FR 编号里推不出来，靠人眼也看不出「少了一项」
// （少的那一项只是不在了）。判据一句话：这是不是一件我今天要做的事。
// 「来源 / 素材 / 记录 / 设置」都不是，所以它们在抽屉里；今天还剩几个词只贴在「单词」上。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Route } from '@/app/router';

// SyncChip 要读同步状态、发网络请求；导航的形状与它无关。
vi.mock('./SyncChip', () => ({ SyncChip: () => <span data-testid="sync-chip" /> }));

// 角标的数从 useDrillToday 来（它读 IndexedDB）；这里只测「贴在哪、怎么显示」，数直接给。
let remaining = 0;
vi.mock('@/drill/useDrillToday', () => ({
  useDrillToday: () => ({ remaining }),
}));

const { BottomTabs, TopBar, shouldShowBottomTabs } = await import('./AppNav');

beforeEach(() => {
  remaining = 0;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shouldShowBottomTabs（§12.2：底部一次只有一层）', () => {
  it('活动页与抽屉页都画标签栏', () => {
    const routes: Route[] = [
      { name: 'lessons' },
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
  it('正好两个活动：课程、单词', () => {
    render(<BottomTabs route={{ name: 'lessons' }} />);
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['课程', '单词']);
  });

  it('管道页不在标签栏里，复习也不在了', () => {
    render(<BottomTabs route={{ name: 'lessons' }} />);
    for (const label of ['来源', '素材', '记录', '设置', '复习', '生词本']) {
      expect(screen.queryByRole('link', { name: label })).toBeNull();
    }
  });

  it('当前活动带 aria-current，别的没有', () => {
    render(<BottomTabs route={{ name: 'vocab' }} />);
    expect(screen.getByRole('link', { current: 'page' })).toHaveTextContent('单词');
  });

  it('背单词会话（#/drill）里导航仍亮「单词」—— 它是从单词页推进去的', () => {
    render(<BottomTabs route={{ name: 'drill' }} />);
    expect(screen.getByRole('link', { current: 'page' })).toHaveTextContent('单词');
  });

  it('今天还剩几个只贴在「单词」上', () => {
    remaining = 37;
    render(<BottomTabs route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /单词/ })).toHaveTextContent('37');
    expect(screen.getByRole('link', { name: /课程/ })).not.toHaveTextContent('37');
  });

  it('背完了就不显示角标 —— 空徽章比没有徽章更吵', () => {
    render(<BottomTabs route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /单词/ }).textContent).toBe('单词');
  });

  it('超过 99 显示 99+（每天 200 个，这是常态）', () => {
    remaining = 200;
    render(<BottomTabs route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /单词/ })).toHaveTextContent('99+');
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

  it('抽屉页上标题显示的是那一页的名字，不是应用名', () => {
    render(<TopBar route={{ name: 'cache' }} />);
    // 「素材」同时出现在抽屉的链接里，所以只认标题那个 <span>。
    const title = screen.getAllByText('素材').find((el) => el.tagName === 'SPAN');
    expect(title).toBeInTheDocument();
    expect(screen.queryByText('努力学德语')).toBeNull();
  });

  it('桌面顶部导航的角标数字跟底部标签栏同一个口径', () => {
    // 顶部栏（桌面 `sm:flex` 那一份）走的是同一个 `useDueCount`，但渲染路径
    // 完全独立（另一段 JSX、另一套 className 分支）——两边各画各的角标，
    // 漏改一边不会被类型或单测之外的任何东西挡住。
    remaining = 19;
    render(<TopBar route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /单词/ })).toHaveTextContent('19');
  });
});
