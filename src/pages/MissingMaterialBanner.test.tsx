// 变更 69：课程页上「素材未下载」那块横幅。音频在同步服务器上的手动课要和 DW 的课一样
// **打开就自动补齐**，而且补齐之后同步来的时间戳不重对。没传上去的手动课照旧只能自己选文件。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useLessonStore } from '@/state/useLessonStore';
import type { Lesson } from '@/types/models';

vi.mock('@/sync/trigger', () => ({ syncNow: vi.fn(), scheduleLessonSync: vi.fn(), syncLessonDeletion: vi.fn() }));
const restoreServerAudio = vi.fn();
vi.mock('@/lesson/bindAudio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lesson/bindAudio')>()),
  restoreServerAudio: (lesson: Lesson) => restoreServerAudio(lesson),
}));
const rehydrateLesson = vi.fn();
vi.mock('@/sources/importLesson', () => ({ rehydrateLesson: (l: Lesson) => rehydrateLesson(l) }));

const { MissingMaterialBanner } = await import('./LessonPage');

let seq = 0;
function seed(extra: Partial<Lesson> = {}): string {
  const id = `l${++seq}`; // 每条用例一个新 id：自动补齐按 lessonId 记在模块级集合里，一次会话只补一次
  const lesson: Lesson = {
    id,
    title: 'Kapitel 7 · Modul 4 Aufgabe 3',
    source: { type: 'manual', audioFileName: '605038_LB_CD2 (20).mp3' },
    sentences: [],
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
  useLessonStore.setState({ lessons: [lesson], caches: {}, loaded: true });
  return id;
}
const ref = { sha256: 'a'.repeat(64), bytes: 5_600_000 };

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('MissingMaterialBanner · 音频在同步服务器上', () => {
  it('打开就自动下载；时间戳是同步来的就明说不用重对', async () => {
    restoreServerAudio.mockResolvedValue({ realigned: false });
    render(<MissingMaterialBanner lessonId={seed({ audioRef: ref })} />);
    expect(await screen.findByText('音频下载好了。时间戳是同步来的，不用重对。')).toBeInTheDocument();
    expect(restoreServerAudio).toHaveBeenCalledTimes(1);
    expect(rehydrateLesson).not.toHaveBeenCalled(); // 不走 DW 那条
  });

  it('下载中说从服务器下、报大小；按钮叫「重新下载」', async () => {
    let resolve!: (v: unknown) => void;
    restoreServerAudio.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<MissingMaterialBanner lessonId={seed({ audioRef: ref })} />);
    expect(await screen.findByText(/从同步服务器下载音频（5\.3 MB）/)).toBeInTheDocument();
    resolve({ realigned: true });
    expect(await screen.findByRole('button', { name: '重新下载' })).toBeInTheDocument();
    expect(screen.getByText(/音频下载好了，正在自动对齐/)).toBeInTheDocument();
  });

  it('下载失败：把原因说出来', async () => {
    restoreServerAudio.mockRejectedValue(new Error('下载下来的音频和服务器记着的对不上'));
    render(<MissingMaterialBanner lessonId={seed({ audioRef: ref })} />);
    expect(await screen.findByText(/补齐失败：下载下来的音频和服务器记着的对不上/)).toBeInTheDocument();
  });

  it('离线时不自动试（失败了这次会话就不再自动补，白占一次机会）', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    render(<MissingMaterialBanner lessonId={seed({ audioRef: ref })} />);
    await waitFor(() => expect(screen.getByText(/这一课的音频在同步服务器上/)).toBeInTheDocument());
    expect(restoreServerAudio).not.toHaveBeenCalled();
  });

  it('没传上去的手动课：不自动、没有「重新下载」，说明要自己选文件', () => {
    render(<MissingMaterialBanner lessonId={seed()} />);
    expect(restoreServerAudio).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '重新下载' })).toBeNull();
    expect(screen.getByText(/音频还没传到同步服务器上/)).toBeInTheDocument();
  });
});
