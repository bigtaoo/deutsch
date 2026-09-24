// SPEC §12.1 的导航契约：**三个活动 + 一个抽屉**。
//
// 这是形状类规定，不是功能规定 —— 所以从 FR 编号里推不出来，靠人眼也看不出「少了一项」
// （少的那一项只是不在了）。判据一句话：这是不是一件我今天要做的事。
// 「来源 / 素材 / 记录 / 设置」都不是，所以它们在抽屉里；到期张数只贴在复习上。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { useVocabStore } from '@/state/useVocabStore';
import { useSettingsStore } from '@/state/useSettingsStore';
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

/** 已毕业、已到期的复习卡（state 2）—— 用来测 `reviewPerDay` 那条上限，新卡走 `newPerDay`。 */
function reviewDue(id: string): VocabEntry {
  return due(id, {
    fsrs: { ...newCard(), state: 2, reps: 1, due: Date.now() - 1000 },
  });
}

beforeEach(() => {
  useVocabStore.setState({ entries: [] });
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, newPerDay: 10, reviewPerDay: 60 },
  }));
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
    // 用一张已经毕业、明天才到期的卡（state 2）—— 新卡（state 0）在队列里
    // 不看 due，只看有没有占满 newPerDay，所以不能拿它来测「还没到期」。
    useVocabStore.setState({
      entries: [
        due('a', {
          fsrs: { ...newCard(), state: 2, reps: 1, due: Date.now() + 86_400_000 },
        }),
      ],
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
    // 角标数字受 newPerDay 上限约束（见下面「与复习页口径一致」），
    // 这里把上限调大到能实际撑到 99+，而不是测一个平时到不了的数字。
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, newPerDay: 200 } }));
    useVocabStore.setState({ entries: Array.from({ length: 120 }, (_, i) => due(`w${i}`)) });
    render(<BottomTabs route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /复习/ })).toHaveTextContent('99+');
  });

  it('角标口径与复习页一致 —— 受 newPerDay 上限约束（用户发现两个数字对不上）', () => {
    useVocabStore.setState({ entries: Array.from({ length: 19 }, (_, i) => due(`w${i}`)) });
    render(<BottomTabs route={{ name: 'lessons' }} />);
    // newPerDay 默认 10，19 张到期新卡里只有 10 张真正能进今天的队列。
    expect(screen.getByRole('link', { name: /复习/ })).toHaveTextContent('10');
  });

  it('reviewPerDay 同样封顶 —— 不是只有新卡那条上限生效', () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, reviewPerDay: 5 } }));
    useVocabStore.setState({ entries: Array.from({ length: 8 }, (_, i) => reviewDue(`r${i}`)) });
    render(<BottomTabs route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /复习/ })).toHaveTextContent('5');
  });

  it('新卡与复习各占各的上限，角标是两边加起来的和', () => {
    // 5 张到期复习（上限 3 → 只算 3 张）+ 4 张到期新卡（上限 2 → 只算 2 张），角标该是 5。
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, newPerDay: 2, reviewPerDay: 3 },
    }));
    useVocabStore.setState({
      entries: [
        ...Array.from({ length: 5 }, (_, i) => reviewDue(`r${i}`)),
        ...Array.from({ length: 4 }, (_, i) => due(`n${i}`)),
      ],
    });
    render(<BottomTabs route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /复习/ })).toHaveTextContent('5');
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
    useVocabStore.setState({ entries: Array.from({ length: 19 }, (_, i) => due(`w${i}`)) });
    render(<TopBar route={{ name: 'lessons' }} />);
    expect(screen.getByRole('link', { name: /复习/ })).toHaveTextContent('10');
  });
});
