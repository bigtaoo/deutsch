// 版本小节的渲染（§12.12 / 变更 41 / 变更 46）。
//
// 写它的理由：这一块**在浏览器里只看得到一半**。原生壳那条分支（两个版本号 + 「下好了
// 等着生效」）要真机才出得来，而它恰恰是接了热更之后唯一能回答「我手机上到底是哪一版」
// 的地方 —— 那半截靠这组用例守着。
//
// 2026-09-22 补了三条**守「整块消失」**的：原来第一行是
// `if (build === undefined) return null;`，而 `build` 来自一个过原生桥的调用 ——
// 桥不回调时那个 Promise 永远不 settle，于是整个「版本」块在 iPhone 上一次都没出现过。
// 这类 bug 不报错、不留日志，只表现为「设置页翻到底什么都没有」。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { VersionSection } from './VersionSection';
import { pendingUpdateVersion, runningBuild } from '@/platform/nativeUpdate';
import { nativePlatform } from '@/platform/native';

vi.mock('@/platform/nativeUpdate', () => ({
  runningBuild: vi.fn(),
  pendingUpdateVersion: vi.fn(),
}));

vi.mock('@/platform/native', () => ({
  nativePlatform: vi.fn(),
}));

const mockRunning = vi.mocked(runningBuild);
const mockPending = vi.mocked(pendingUpdateVersion);
const mockPlatform = vi.mocked(nativePlatform);

beforeEach(() => {
  vi.clearAllMocks();
  mockPending.mockReturnValue(null);
  mockPlatform.mockResolvedValue('ios');
});

describe('VersionSection', () => {
  it('浏览器里只说一句「会自己更新」，不摆版本号', async () => {
    mockPlatform.mockResolvedValue('web');
    mockRunning.mockResolvedValue(null);
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/网页版/)).toBeInTheDocument());
    // web 上没有「壳」这个概念，摆出来只会让人以为要去哪里升级。
    expect(screen.queryByText(/应用壳/)).not.toBeInTheDocument();
  });

  it('原生壳里把两个版本分开说 —— 一个要过 App Store，一个会自己更新', async () => {
    mockRunning.mockResolvedValue({ native: '0.4.0', bundle: '0.4.0+a1b2c3d' });
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/应用壳 0\.4\.0/)).toBeInTheDocument());
    expect(screen.getByText(/0\.4\.0\+a1b2c3d/)).toBeInTheDocument();
  });

  it('还没热更过时，前端那行说的是「随包那份」而不是 builtin', async () => {
    // 'builtin' 是插件的内部值，摆到界面上等于让人去搜一个搜不到的词。
    mockRunning.mockResolvedValue({ native: '0.4.0', bundle: 'builtin' });
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/随包那份/)).toBeInTheDocument());
    expect(screen.queryByText(/builtin/)).not.toBeInTheDocument();
  });

  it('下好了才提示，且说清是「下次打开」生效', async () => {
    mockRunning.mockResolvedValue({ native: '0.4.0', bundle: 'builtin' });
    mockPending.mockReturnValue('0.4.0+ffff999');
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/0\.4\.0\+ffff999/)).toBeInTheDocument());
    expect(screen.getByText(/下次打开/)).toBeInTheDocument();
  });

  it('没下到新版就什么也不说（§12.3 的静默档）', async () => {
    mockRunning.mockResolvedValue({ native: '0.4.0', bundle: 'builtin' });
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('版本')).toBeInTheDocument());
    expect(screen.queryByText(/已下好/)).not.toBeInTheDocument();
  });

  // ── 守「整块消失」的三条（变更 46）─────────────────────────────
  //
  // 这三条各自对应一种真实的失败方式，而它们共同的症状是**设置页翻到底什么都没有** ——
  // 没有报错、没有日志，看起来就像这个功能根本没做。

  it('原生桥不回应（Promise 永不 settle）时，这一块照样在', async () => {
    mockRunning.mockReturnValue(new Promise(() => {}));
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('版本')).toBeInTheDocument());
    expect(screen.getByText(/正在问原生侧版本号/)).toBeInTheDocument();
  });

  it('版本号问不出来时如实说一句，而不是整块消失', async () => {
    mockRunning.mockResolvedValue(null); // 原生壳上拿到 null = 问不出来
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/版本号问不出来/)).toBeInTheDocument());
  });

  it('诊断块无论哪条分支都在 —— 会在出问题时消失的诊断等于没有', async () => {
    mockRunning.mockReturnValue(new Promise(() => {}));
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('这台设备的边距与常亮')).toBeInTheDocument());
    expect(screen.getByText(/屏幕常亮/)).toBeInTheDocument();
  });
});
