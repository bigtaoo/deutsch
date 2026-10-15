// 变更 82：译文页的「让 AI 译」—— 能用 AI 且还有没译的句子才出现。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Lesson, Sentence } from '@/types/models';

const aiAvailable = vi.fn<() => Promise<boolean>>();
vi.mock('@/ai/explain', () => ({ aiAvailable: () => aiAvailable() }));
const translateLessonWithAi = vi.fn();
vi.mock('@/ai/translate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ai/translate')>()),
  translateLessonWithAi: (id: string) => translateLessonWithAi(id),
}));

const { TranslationTab } = await import('./TranslationTab');

const s = (index: number, text: string, extra: Partial<Sentence> = {}): Sentence => ({ index, text, ...extra }) as Sentence;
const lesson = (sentences: Sentence[]): Lesson =>
  ({ id: 'L', title: 'Folge 1', source: { type: 'manual' }, sentences, createdAt: 0, updatedAt: 0 }) as Lesson;

beforeEach(() => vi.clearAllMocks());

describe('让 AI 译', () => {
  it('能用 AI：按钮报没译的句数（已有译文、排除句不算），点了说补了几句', async () => {
    aiAvailable.mockResolvedValue(true);
    translateLessonWithAi.mockResolvedValue({ translated: 2 });
    render(
      <TranslationTab
        lesson={lesson([s(0, 'Hallo.'), s(1, 'Ja.', { translation: '是。' }), s(2, 'Nein.'), s(3, 'x', { excluded: true })])}
        cache={undefined}
      />,
    );
    fireEvent.click(await screen.findByText('让 AI 译（2 句）'));
    await screen.findByText('AI 补上了 2 句译文。');
    expect(translateLessonWithAi).toHaveBeenCalledWith('L');
  });

  it('失败把原因说出来', async () => {
    aiAvailable.mockResolvedValue(true);
    translateLessonWithAi.mockRejectedValue(new Error('AI 返回了 1 条，要的是 2 条'));
    render(<TranslationTab lesson={lesson([s(0, 'Hallo.')])} cache={undefined} />);
    fireEvent.click(await screen.findByText('让 AI 译（1 句）'));
    await screen.findByText('AI 没译成：AI 返回了 1 条，要的是 2 条');
  });

  it('没登录 / 全都有译文：不出现', async () => {
    aiAvailable.mockResolvedValue(false);
    const { unmount } = render(<TranslationTab lesson={lesson([s(0, 'Hallo.')])} cache={undefined} />);
    await waitFor(() => expect(aiAvailable).toHaveBeenCalled());
    expect(screen.queryByText(/让 AI 译/)).toBeNull();
    unmount();

    aiAvailable.mockResolvedValue(true);
    render(<TranslationTab lesson={lesson([s(0, 'Hallo.', { translation: '你好。' })])} cache={undefined} />);
    await waitFor(() => expect(aiAvailable).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/让 AI 译/)).toBeNull();
  });
});
