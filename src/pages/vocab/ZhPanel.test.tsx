// FR-21.9 / §12.14：补中译那一块。
//
// 解析与写回都是纯函数（srs/glossZh.test.ts 已经测了 13 条），这里只测装起来
// 才看得见的三件：**一个词都不缺时整块不出现**（那是 §12.14 的形状约束，
// 也是最容易在重构里丢掉的一条）、贴回来之后**预览真的按编号对上了**、
// 以及保存真的落进 store。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { ZhPanel } from './ZhPanel';
import { useVocabStore } from '@/state/useVocabStore';
import { newCard } from '@/srs/fsrs';
import type { VocabEntry } from '@/types/models';

vi.mock('@/sync/trigger', () => ({ syncVocabNow: vi.fn() }));

const NOW = new Date('2026-09-21T12:00:00Z');

function entry(id: string, extra: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id,
    surface: id,
    meaning: `Sinn von ${id}`,
    hasTimestamp: false,
    suspended: false,
    fsrs: newCard(NOW),
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
    ...extra,
  };
}

function paste(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/第一个词的中文/), { target: { value: text } });
}

beforeEach(() => {
  vi.clearAllMocks();
  useVocabStore.setState({ entries: [], loaded: true });
});

describe('ZhPanel', () => {
  it('一个词都不缺中译时，整块不出现', () => {
    useVocabStore.setState({ entries: [entry('Vorhang', { meaningZh: '窗帘' })] });
    const { container } = render(<ZhPanel />);
    // 永远显示「0 个词待补」只是在每次打开生词本时提醒你它没用（§12.14）
    expect(container).toBeEmptyDOMElement();
  });

  it('标题上带数量 —— 这个数决定了要不要现在做', () => {
    useVocabStore.setState({ entries: [entry('a'), entry('b'), entry('c', { meaningZh: '丙' })] });
    render(<ZhPanel />);
    expect(screen.getByText(/补中译（2 个词还没有中文）/)).toBeInTheDocument();
  });

  it('贴回来之后按编号给出「德语词 → 中文」对照 —— 错位一格只有人眼挡得住', () => {
    useVocabStore.setState({
      entries: [
        entry('Vorhang', { createdAt: NOW.getTime() - 2000 }),
        entry('Zuversicht', { createdAt: NOW.getTime() - 1000 }),
      ],
    });
    render(<ZhPanel />);

    paste('1. 窗帘\n2. 信心');

    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows[0]).toContain('Vorhang');
    expect(rows[0]).toContain('窗帘');
    expect(rows[1]).toContain('Zuversicht');
    expect(rows[1]).toContain('信心');
  });

  it('保存真的落进 store，并把已经贴过的词从待补清单里摘掉', async () => {
    useVocabStore.setState({ entries: [entry('Vorhang'), entry('Zuversicht')] });
    const updateEntries = vi.fn(async (list: VocabEntry[]) => {
      useVocabStore.setState({
        entries: useVocabStore.getState().entries.map((e) => list.find((n) => n.id === e.id) ?? e),
      });
    });
    useVocabStore.setState({ updateEntries });
    render(<ZhPanel />);

    paste('1. 窗帘');
    await act(async () => {
      screen.getByRole('button', { name: /保存这 1 条/ }).click();
    });

    expect(useVocabStore.getState().entries.find((e) => e.id === 'Vorhang')?.meaningZh).toBe('窗帘');
    // 只剩一个词待补了
    expect(screen.getByText(/补中译（1 个词还没有中文）/)).toBeInTheDocument();
  });

  it('落不到词上的编号在保存之后报出来，不静默丢掉', async () => {
    useVocabStore.setState({ entries: [entry('Vorhang')] });
    useVocabStore.setState({ updateEntries: vi.fn(async () => {}) });
    render(<ZhPanel />);

    paste('1. 窗帘\n7. 从哪来的');
    await act(async () => {
      screen.getByRole('button', { name: /保存这 1 条/ }).click();
    });

    expect(screen.getByText(/1 个编号没有对应的词/)).toBeInTheDocument();
  });

  it('一个编号都认不出来时不给保存按钮 —— 没有预览就没有那道防线', () => {
    useVocabStore.setState({ entries: [entry('Vorhang')] });
    render(<ZhPanel />);

    paste('窗帘\n信心'); // 忘了保留编号
    expect(screen.queryByRole('button', { name: /保存这/ })).not.toBeInTheDocument();
  });
});
