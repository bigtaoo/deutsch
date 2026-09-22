// FR-9.11 / FR-9.12 / §12.16：问 AI 补解释那一块。
//
// 解析与写回都是纯函数（srs/aiNotes.test.ts 已经 25 条），这里只测**装起来才看得见**的：
// 整块出不出现的那条形状约束、待办从两个口子进来时说明行说的是不是同一句话、
// 预览真的按编号对上了、以及保存真的落进 store。
//
// 与 ZhPanel.test.tsx 是双胞胎 —— 那两块在界面上并排，行为分了家就是 bug。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { AiNotesPanel } from './AiNotesPanel';
import { useVocabStore } from '@/state/useVocabStore';
import { newCard } from '@/srs/fsrs';
import type { VocabEntry } from '@/types/models';

vi.mock('@/sync/trigger', () => ({ syncVocabNow: vi.fn() }));

const NOW = new Date('2026-09-22T12:00:00Z');

function entry(id: string, extra: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id,
    surface: id,
    hasTimestamp: false,
    suspended: false,
    fsrs: newCard(NOW),
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
    ...extra,
  };
}

function paste(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/第一个词的解释/), { target: { value: text } });
}

/**
 * 替掉 store 的 `updateEntries`，并把结果同步回内存里的 entries。
 *
 * 和 ZhPanel.test.tsx 同一套做法：真的那一个要过 IndexedDB（一个宏任务），
 * 而 `act()` 只 flush 到微任务就返回 —— 断言会跑在写入之前，症状是
 * 「点了保存什么也没发生」，看着像点击没被收到。落库本身由 store 的测试守。
 */
function stubUpdateEntries() {
  const updateEntries = vi.fn(async (list: VocabEntry[]) => {
    useVocabStore.setState({
      entries: useVocabStore.getState().entries.map((e) => list.find((n) => n.id === e.id) ?? e),
    });
  });
  useVocabStore.setState({ updateEntries });
  return updateEntries;
}

function open() {
  // <details> 默认折叠；jsdom 不跟 summary 的点击联动，直接开。
  const details = document.querySelector('details');
  if (details) details.open = true;
}

beforeEach(() => {
  vi.clearAllMocks();
  useVocabStore.setState({ entries: [], loaded: true });
});

describe('AiNotesPanel', () => {
  it('一个词都不等着时，整块不出现', () => {
    useVocabStore.setState({ entries: [entry('gut', { meaning: 'wohlgefällig' })] });
    const { container } = render(<AiNotesPanel />);
    // §12.16：永远显示「0 个词等着」只是每次打开生词本时提醒你它没用。
    expect(container).toBeEmptyDOMElement();
  });

  it('标题上带数量 —— 这个数决定了要不要现在做', () => {
    useVocabStore.setState({ entries: [entry('a'), entry('b', { askAi: true, meaning: 'x' })] });
    render(<AiNotesPanel />);
    expect(screen.getByText(/问 AI 补解释（2 个词等着）/)).toBeInTheDocument();
  });

  it('两个口子的词都在，说明行分开说清楚各有几个', () => {
    useVocabStore.setState({
      entries: [entry('leer'), entry('Zuversicht', { meaning: 'Vertrauen', askAi: true })],
    });
    render(<AiNotesPanel />);
    open();
    // 「只有这条路能补」的那一半要单独点出来：它和「我自己标的」下一步一样，但来路不同。
    expect(screen.getByText(/其中 1 个词两个词典都查不到/)).toBeInTheDocument();
  });

  it('全是自己标记的词时，不说「查不到」那句', () => {
    useVocabStore.setState({ entries: [entry('a', { meaning: 'Sinn', askAi: true })] });
    render(<AiNotesPanel />);
    open();
    expect(screen.queryByText(/两个词典都查不到/)).not.toBeInTheDocument();
    expect(screen.getByText(/这些是你自己点「问 AI」标记的词/)).toBeInTheDocument();
  });

  it('「自己选中复制」里的内容就是要发出去的那一份（含提示词与编号）', () => {
    useVocabStore.setState({ entries: [entry('Zuversicht', { meaning: 'Vertrauen', askAi: true })] });
    render(<AiNotesPanel />);
    open();
    fireEvent.click(screen.getByRole('button', { name: '自己选中复制' }));
    const box = screen.getByDisplayValue(/请逐个讲解/) as HTMLTextAreaElement;
    expect(box.value).toContain('1. Zuversicht');
    expect(box.value).toContain('（词典：Vertrauen）');
  });

  it('预览按编号把词和解释对起来 —— 这是错位一格唯一被挡住的地方', () => {
    useVocabStore.setState({
      entries: [
        entry('Vorhang', { createdAt: NOW.getTime() }),
        entry('Vorgang', { createdAt: NOW.getTime() + 1000 }),
      ],
    });
    render(<AiNotesPanel />);
    open();
    paste('1. 窗帘\n2. 过程');

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Vorhang');
    expect(rows[0].textContent).toContain('窗帘');
    expect(rows[1].textContent).toContain('Vorgang');
    expect(rows[1].textContent).toContain('过程');
  });

  it('预览只摆第一行加字数 —— 四十个词的全文预览要翻十屏', () => {
    useVocabStore.setState({ entries: [entry('Zuversicht')] });
    render(<AiNotesPanel />);
    open();
    paste('1. 第一行\n第二行\n第三行');

    const row = screen.getAllByRole('listitem')[0];
    expect(row.textContent).toContain('第一行');
    expect(row.textContent).not.toContain('第三行');
    expect(row.textContent).toContain('字'); // 「N 字」
  });

  it('认到几个 / 共几个都如实报出来', () => {
    useVocabStore.setState({ entries: [entry('a'), entry('b')] });
    render(<AiNotesPanel />);
    open();
    paste('1. 只贴了一条');
    expect(screen.getByText(/认到 1 个编号 \/ 共 2 个词/)).toBeInTheDocument();
  });

  it('保存把 note 写上、把 askAi 清掉，再交给 store', async () => {
    useVocabStore.setState({ entries: [entry('Zuversicht', { meaning: 'Vertrauen', askAi: true })] });
    stubUpdateEntries();
    render(<AiNotesPanel />);
    open();
    paste('1. 信心、笃定。偏向对未来的乐观预期。');

    await act(async () => screen.getByRole('button', { name: /保存这 1 条/ }).click());

    const saved = useVocabStore.getState().entries[0];
    expect(saved.note).toContain('信心、笃定');
    // 标记的意思是「还没问」。答案回来了它就该消失，否则这个词永远待在待办里。
    expect('askAi' in saved).toBe(false);
  });

  it('只贴了一半时，另一半原样留在待办里', async () => {
    useVocabStore.setState({
      entries: [
        entry('a', { createdAt: NOW.getTime() }),
        entry('b', { createdAt: NOW.getTime() + 1000 }),
      ],
    });
    stubUpdateEntries();
    render(<AiNotesPanel />);
    open();
    paste('1. 只讲了第一个');

    await act(async () => screen.getByRole('button', { name: /保存这 1 条/ }).click());

    expect(useVocabStore.getState().entries[1].note).toBeUndefined();
    expect(screen.getByText(/问 AI 补解释（1 个词等着）/)).toBeInTheDocument();
  });

  it('落不到词上的编号在保存之后报出来，不静默丢掉', async () => {
    // 要两个词：只剩一个的话保存完待办就空了，整块跟着消失，那句提示也跟着走。
    useVocabStore.setState({
      entries: [entry('a', { createdAt: NOW.getTime() }), entry('b', { createdAt: NOW.getTime() + 1 })],
    });
    stubUpdateEntries();
    render(<AiNotesPanel />);
    open();
    paste('1. 有主的\n7. 从哪来的');

    await act(async () => screen.getByRole('button', { name: /保存这 1 条/ }).click());

    expect(screen.getByText(/1 个编号没有对应的词/)).toBeInTheDocument();
  });

  it('写完之后这个词不再等着 —— 整块跟着消失', async () => {
    useVocabStore.setState({ entries: [entry('leer')] });
    stubUpdateEntries();
    const { container } = render(<AiNotesPanel />);
    open();
    paste('1. 解释');
    await act(async () => screen.getByRole('button', { name: /保存这 1 条/ }).click());
    // 「写入 N 条」那句提示也跟着走了。这不是漏了提示：结果就在生词本列表那一行里，
    // 而「没有待办就不出现」这条更重要（§12.16）。
    expect(container).toBeEmptyDOMElement();
  });

  it('一个编号都对不上时**不给保存按钮** —— 没东西可存就别让人按', () => {
    useVocabStore.setState({ entries: [entry('a')] });
    render(<AiNotesPanel />);
    open();
    paste('9. 落空的编号');
    // 预览为空 = 这一贴什么也落不到词上。按钮跟着预览走，所以这时它根本不出现，
    // 而不是「按下去告诉你写入 0 条」。
    expect(screen.queryByRole('button', { name: /保存这/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});
