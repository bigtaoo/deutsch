// AI 解释默认折叠（用户反馈：不折叠的话看词很不方便）。
//
// 只测 Row 关心的这一件事：note 存在时用 Disclosure 包住、默认收起、点开才看见全文；
// 没有 note 时整块不出现。三个查词/预置词库子面板各自有自己的测试，这里全部 stub 掉，
// 免得它们的网络/IndexedDB 依赖把这个文件拖下水。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VocabPage } from './VocabPage';
import { useVocabStore } from '@/state/useVocabStore';
import { useLessonStore } from '@/state/useLessonStore';
import { newCard } from '@/srs/fsrs';
import type { VocabEntry } from '@/types/models';

vi.mock('@/sync/trigger', () => ({ syncVocabNow: vi.fn() }));
vi.mock('@/ai/explain', () => ({ explainWithAi: vi.fn() }));
vi.mock('./vocab/DictLookup', () => ({ DictLookup: () => null }));
vi.mock('./vocab/PresetPanel', () => ({ PresetPanel: () => null }));
vi.mock('./vocab/ZhPanel', () => ({ ZhPanel: () => null }));

const NOW = new Date('2026-09-23T12:00:00Z');

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

beforeEach(() => {
  vi.clearAllMocks();
  useVocabStore.setState({ entries: [], loaded: true });
  useLessonStore.setState({ lessons: [] });
});

describe('VocabPage — AI 解释折叠', () => {
  it('有 note 时默认收起 —— <details> 没有 open', () => {
    useVocabStore.setState({ entries: [entry('Pilz', { note: '基本意思：蘑菇或菌类。' })] });
    render(<VocabPage />);

    expect(screen.getByText('AI 解释').closest('details')).not.toHaveAttribute('open');
  });

  it('点开摘要之后 <details> 变成 open', () => {
    useVocabStore.setState({ entries: [entry('Pilz', { note: '基本意思：蘑菇或菌类。' })] });
    render(<VocabPage />);

    screen.getByText('AI 解释').click();

    expect(screen.getByText(/基本意思：蘑菇或菌类/)).toBeVisible();
    expect(screen.getByText('AI 解释').closest('details')).toHaveAttribute('open');
  });

  it('没有 note 时不出现折叠块', () => {
    useVocabStore.setState({ entries: [entry('Vorhang')] });
    render(<VocabPage />);

    expect(screen.queryByText('AI 解释')).not.toBeInTheDocument();
  });
});
