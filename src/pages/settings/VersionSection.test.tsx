// 版本小节的渲染（§12.12 / 变更 41）。
//
// 写它的理由：这一块**在浏览器里只看得到一半**。原生壳那条分支（两个版本号 + 「下好了
// 等着生效」）要真机才出得来，而它恰恰是接了热更之后唯一能回答「我手机上到底是哪一版」
// 的地方 —— 那半截靠这组用例守着。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { VersionSection } from './VersionSection';
import { pendingUpdateVersion, runningBuild } from '@/platform/nativeUpdate';

vi.mock('@/platform/nativeUpdate', () => ({
  runningBuild: vi.fn(),
  pendingUpdateVersion: vi.fn(),
}));

const mockRunning = vi.mocked(runningBuild);
const mockPending = vi.mocked(pendingUpdateVersion);

beforeEach(() => {
  vi.clearAllMocks();
  mockPending.mockReturnValue(null);
});

describe('VersionSection', () => {
  it('浏览器里只说一句「会自己更新」，不摆版本号', async () => {
    mockRunning.mockResolvedValue(null);
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('版本')).toBeInTheDocument());
    expect(screen.getByText(/网页版/)).toBeInTheDocument();
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
});
