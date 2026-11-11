// 「试听」与「一键恢复」的自动上报（变更 88 / FR-10.12 / FR-11.13）。
//
// 这两个按钮**上报的时机各不相同**，而两种时机的错法都不会报错、只会悄悄少一份或多一份：
// 试听要等那 1.7 秒过去（`play()` 的结果是异步落的，早发一步发出去的是一份没有结论的报告），
// 一键恢复则只在没走通时才发（它不是诊断按钮，是真会改数据的操作，而每份几百 KB
// 会把收件箱里真正要看的那几份挤掉）。两条都靠这组用例守着。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { RestoreSection, StudySettingsSection } from './RestoreSection';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useSyncStore } from '@/state/useSyncStore';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useStudyStore } from '@/state/useStudyStore';
import { DEFAULT_SETTINGS } from '@/db/meta';
import { autoSendReport } from '@/platform/bridgeDiag';
import { playSfx, preloadSfx, sfxEvents, wakeSfx } from '@/audio/sfx';
import { restoreFromServer } from '@/sync/restore';

vi.mock('@/platform/bridgeDiag', () => ({ autoSendReport: vi.fn() }));
vi.mock('@/sync/restore', () => ({ restoreFromServer: vi.fn() }));
vi.mock('@/db/meta', async (orig) => ({
  ...(await orig<typeof import('@/db/meta')>()),
  getMeta: vi.fn(async () => undefined),
  putMeta: vi.fn(async () => {}),
}));
vi.mock('@/audio/sfx', () => ({
  playSfx: vi.fn(),
  preloadSfx: vi.fn(),
  sfxEvents: vi.fn(() => []),
  wakeSfx: vi.fn(),
}));

const mockAuto = vi.mocked(autoSendReport);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuto.mockResolvedValue('已自动上报：1790000000000-abc123-sfx');
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, soundEffects: true }, loaded: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('试听的自动上报', () => {
  it('等那 1.7 秒过去才发 —— 早一步发出去的是一份还没有结论的报告', async () => {
    vi.useFakeTimers();
    // 这里给的延时是**用例本身的判据**：三个文件的取用结果要过 1 秒才落进 sfxEvents()。
    // 零延时的 mock 会让「发早了」这个 bug 自己收敛，于是这条用例测不出任何东西。
    let events: string[] = ['+0.0s right:开始取'];
    vi.mocked(preloadSfx).mockImplementation(async () => {
      setTimeout(() => {
        events = ['+0.0s right:开始取', '+1.0s right:取到了，播了'];
      }, 1000);
    });
    vi.mocked(sfxEvents).mockImplementation(() => events);

    render(<StudySettingsSection />);
    fireEvent.click(screen.getByText('试听'));
    await vi.advanceTimersByTimeAsync(1700);

    expect(wakeSfx).toHaveBeenCalled();
    expect(playSfx).toHaveBeenCalledWith('right');
    expect(mockAuto).toHaveBeenCalledWith('sfx', { note: '+1.0s right:取到了，播了' });
  });

  it('一笔记录都没有时也发 —— 那本身就是结论', async () => {
    vi.useFakeTimers();
    vi.mocked(preloadSfx).mockResolvedValue(undefined);
    vi.mocked(sfxEvents).mockReturnValue([]);
    render(<StudySettingsSection />);
    fireEvent.click(screen.getByText('试听'));
    await vi.advanceTimersByTimeAsync(1700);
    expect(mockAuto).toHaveBeenCalledWith('sfx', { note: '没有任何记录' });
  });

  it('上报结果显示在界面上 —— 静默的自动上报等于没上报', async () => {
    vi.mocked(preloadSfx).mockResolvedValue(undefined);
    vi.mocked(sfxEvents).mockReturnValue(['+0.1s right:播了']);
    render(<StudySettingsSection />);
    fireEvent.click(screen.getByText('试听'));
    await waitFor(() => expect(screen.getByText(/已自动上报/)).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('音效关掉时连试听按钮都没有', () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, soundEffects: false },
      loaded: true,
    });
    render(<StudySettingsSection />);
    expect(screen.queryByText('试听')).not.toBeInTheDocument();
  });
});

describe('一键恢复的自动上报', () => {
  beforeEach(() => {
    useSyncStore.setState({
      status: 'signed-in',
      account: { email: 'me@example.com', name: 'Tao', picture: null },
    } as never);
    // 恢复写的是 IndexedDB，四个 store 要重读一遍 —— 这里只关心有没有上报，
    // 把重读换成空操作，免得把半个持久层拖进这份用例。
    const noop = async () => {};
    useLessonStore.setState({ load: noop });
    useVocabStore.setState({ load: noop });
    useSettingsStore.setState({ load: noop });
    useStudyStore.setState({ load: noop });
  });

  const result = (failures: string[]) => ({
    lessonsFetched: 2,
    vocabFetched: 3,
    failures,
    settingsRestored: true,
    summary: {
      addedLessons: [],
      updatedLessons: [],
      skippedLessons: [],
      addedVocab: [],
      updatedVocab: [],
      overwrittenLessonTitles: [],
    },
  });

  it('跑通了就不上报 —— 它不是诊断按钮，正常那一份没人会去读', async () => {
    vi.mocked(restoreFromServer).mockResolvedValue(result([]) as never);
    render(<RestoreSection />);
    fireEvent.click(screen.getByText('一键恢复'));
    await waitFor(() => expect(screen.getByText('恢复完成')).toBeInTheDocument());
    expect(mockAuto).not.toHaveBeenCalled();
  });

  it('有几份没读出来时上报，并把是哪几份带上', async () => {
    vi.mocked(restoreFromServer).mockResolvedValue(result(['lesson/a：坏了', 'vocab/b：坏了']) as never);
    render(<RestoreSection />);
    fireEvent.click(screen.getByText('一键恢复'));
    await waitFor(() => expect(mockAuto).toHaveBeenCalled());
    expect(mockAuto).toHaveBeenCalledWith('restore-failed', {
      note: '有 2 份没读出来：lesson/a：坏了；vocab/b：坏了',
    });
  });

  it('整条路炸了也上报，带上那句报错', async () => {
    vi.mocked(restoreFromServer).mockRejectedValue(new Error('拉不到清单'));
    render(<RestoreSection />);
    fireEvent.click(screen.getByText('一键恢复'));
    await waitFor(() => expect(screen.getByText('拉不到清单')).toBeInTheDocument());
    expect(mockAuto).toHaveBeenCalledWith('restore-failed', { note: '恢复失败：拉不到清单' });
  });

  it('没登录时这一块不画按钮，自然也不会上报', () => {
    useSyncStore.setState({ status: 'signed-out', account: null } as never);
    render(<RestoreSection />);
    expect(screen.queryByText('一键恢复')).not.toBeInTheDocument();
  });
});
