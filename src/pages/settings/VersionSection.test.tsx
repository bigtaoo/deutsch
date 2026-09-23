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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { VersionSection } from './VersionSection';
import {
  checkNativeUpdate,
  pendingUpdateVersion,
  probePlugins,
  readLastCheckLog,
  runningBuild,
} from '@/platform/nativeUpdate';
import { nativePlatform } from '@/platform/native';
import {
  collectDeviceReport,
  runUpdaterSelfTest,
  sendDeviceReport,
} from '@/platform/bridgeDiag';

vi.mock('@/platform/nativeUpdate', () => ({
  runningBuild: vi.fn(),
  pendingUpdateVersion: vi.fn(),
  checkNativeUpdate: vi.fn(),
  probePlugins: vi.fn(),
  readLastCheckLog: vi.fn(),
}));

vi.mock('@/platform/native', () => ({
  nativePlatform: vi.fn(),
}));

// 桥自检整块假掉：它自己那一套（逐方法调用、串行、冷启动窗口）在
// `bridgeDiag.test.ts` 里测，这里只关心**按下按钮之后界面说了什么**。
vi.mock('@/platform/bridgeDiag', () => ({
  runUpdaterSelfTest: vi.fn(),
  collectDeviceReport: vi.fn(),
  sendDeviceReport: vi.fn(),
  reportToText: vi.fn(() => '一份诊断全文'),
}));

// `safeArea.ts` 的 `lastProbe` 是模块级缓存（同一份跑到底不重量，见该文件注释），
// 在真实运行里是对的，但会让这份测试文件里先跑的用例把平台"web"焊死在缓存里，
// 后面的用例读到的还是那份旧值——和这份文件本身要测的东西无关，纯粹是
// 模块级状态在测试之间露了底。直接假掉，让每条用例的 `nativePlatform()` mock
// 说了算。
vi.mock('@/platform/safeArea', () => ({
  initSafeArea: vi.fn((platform: string) => ({
    platform,
    top: 0,
    bottom: 0,
    fallbackApplied: false,
    fallbackTop: 0,
  })),
  safeAreaProbe: vi.fn(() => null),
}));

const mockRunning = vi.mocked(runningBuild);
const mockPending = vi.mocked(pendingUpdateVersion);
const mockPlatform = vi.mocked(nativePlatform);
const mockCheck = vi.mocked(checkNativeUpdate);
const mockProbe = vi.mocked(probePlugins);
const mockLog = vi.mocked(readLastCheckLog);
const mockSelfTest = vi.mocked(runUpdaterSelfTest);
const mockCollect = vi.mocked(collectDeviceReport);
const mockSend = vi.mocked(sendDeviceReport);

beforeEach(() => {
  vi.clearAllMocks();
  mockPending.mockReturnValue(null);
  mockPlatform.mockResolvedValue('ios');
  // 大多数用例不关心插件探针/查更新日志这两块 —— 给一个「什么都还没有」的默认值，
  // 免得每条用例都要重复摆这两行。真要测的那几条自己覆盖。
  mockProbe.mockReturnValue({
    bridgePresent: true,
    registered: [],
    updaterRegistered: false,
    updaterMethods: null,
  });
  mockLog.mockReturnValue(null);
  mockSelfTest.mockResolvedValue([]);
  mockCollect.mockResolvedValue({} as never);
  mockSend.mockResolvedValue({ id: '1758600000000-abc123' });
});

afterEach(() => {
  vi.useRealTimers();
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
    // 原生壳上永远回一个对象；字段为 undefined = 那个数没问出来（2026-09-22 起的契约）。
    mockRunning.mockResolvedValue({ native: undefined, bundle: undefined });
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/原生桥没回话/)).toBeInTheDocument());
    expect(screen.getAllByText(/问不出来/).length).toBeGreaterThan(0);
  });

  it('一个问得出来一个问不出来时，把问得出来的那个照常报', async () => {
    // 两个数各问各的（以前绑在一个 Promise.all 上，一个挂住就两个都没有）。
    mockRunning.mockResolvedValue({ native: '0.6.0', bundle: undefined });
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/应用壳 0\.6\.0/)).toBeInTheDocument());
    expect(screen.getByText(/原生桥没回话/)).toBeInTheDocument();
  });

  it('桥哑着也要报「上次下好的那一版」—— 那个记号不过桥', async () => {
    // 桥问不出任何东西的时候，这一行是唯一能证明「更新器还活着」的东西。
    mockRunning.mockResolvedValue({ native: undefined, bundle: undefined, queued: 'e209c83' });
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/e209c83/)).toBeInTheDocument());
    expect(screen.getByText(/下次打开/)).toBeInTheDocument();
  });

  it('诊断块无论哪条分支都在 —— 会在出问题时消失的诊断等于没有', async () => {
    mockRunning.mockReturnValue(new Promise(() => {}));
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('这台设备的边距与常亮')).toBeInTheDocument());
    expect(screen.getByText(/屏幕常亮/)).toBeInTheDocument();
  });

  // ── 「现在就查一次更新」按钮 + 插件探针 + 查更新日志（变更 52）───────────────

  it('iOS 上才有「现在就查一次更新」的按钮，web 上没有', async () => {
    mockRunning.mockResolvedValue({ native: '0.6.1', bundle: 'builtin' });
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/应用壳/)).toBeInTheDocument());
    expect(screen.getByText('现在就查一次更新')).toBeInTheDocument();
  });

  it('web 上不摆这个按钮 —— checkNativeUpdate 在浏览器里本来就是空操作', async () => {
    mockPlatform.mockResolvedValue('web');
    mockRunning.mockResolvedValue(null);
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/网页版/)).toBeInTheDocument());
    expect(screen.queryByText('现在就查一次更新')).not.toBeInTheDocument();
  });

  it('点一下会查一次、查完刷新版本号与日志，按钮短暂显示「查询中」', async () => {
    mockRunning.mockResolvedValue({ native: '0.6.1', bundle: 'builtin' });
    let resolveCheck!: () => void;
    mockCheck.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = () => resolve(null);
      }),
    );
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('现在就查一次更新')).toBeInTheDocument());

    fireEvent.click(screen.getByText('现在就查一次更新'));
    await waitFor(() => expect(screen.getByText('查询中…')).toBeInTheDocument());
    expect(mockCheck).toHaveBeenCalledTimes(1);

    // 查完之后重新读一遍 build/pending/log —— 这一版可能刚下好。
    mockRunning.mockResolvedValue({ native: '0.6.1', bundle: '0.6.1+abcd123' });
    mockLog.mockReturnValue({
      at: Date.now(),
      steps: ['plugin-import:ok', 'fetch:ok', 'decide:download', 'download:ok', 'next:ok'],
      outcome: '下载并登记 0.6.1+abcd123',
      probe: { bridgePresent: true, registered: [], updaterRegistered: true, updaterMethods: ['current'] },
    });
    resolveCheck();
    await waitFor(() => expect(screen.getByText('现在就查一次更新')).toBeInTheDocument());
    // 出现两处（版本 Hint + 查更新日志的 outcome）是对的——用 AllBy 而不是当成一处。
    expect(screen.getAllByText(/0\.6\.1\+abcd123/).length).toBeGreaterThanOrEqual(1);
  });

  // 防御性用例：生产实现的 checkNativeUpdate() 已经把所有失败都收进 try/catch/finally
  // 里、绝不会 reject（见 nativeUpdate.ts）。但这里的 mock 能设成 reject，而按钮的
  // finally 逻辑不该依赖「它一定不会 reject」这个假设——万一哪天生产实现被改坏，
  // 按钮不该卡死在「查询中」出不来。
  it('即使 checkNativeUpdate 意外 reject，按钮也会从「查询中」恢复，不会卡死', async () => {
    mockRunning.mockResolvedValue({ native: '0.6.1', bundle: 'builtin' });
    mockCheck.mockRejectedValue(new Error('意外崩溃'));
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('现在就查一次更新')).toBeInTheDocument());

    fireEvent.click(screen.getByText('现在就查一次更新'));
    await waitFor(() => expect(screen.getByText('现在就查一次更新')).toBeInTheDocument());
    expect(screen.queryByText('查询中…')).not.toBeInTheDocument();
  });

  // 变更 57：每一步都有超时 ≠ 整个函数一定会返回。真机上按钮就是一直转着不停，
  // 而那说明有个 await 不在任何一道超时的覆盖范围里。这一层不管是哪一个。
  it('查更新整个卡住时按钮也一定会放开，并且明说它没有回来', async () => {
    mockRunning.mockResolvedValue({ native: '0.6.4', bundle: 'builtin' });
    mockCheck.mockReturnValue(new Promise(() => {}));
    render(<VersionSection />);
    // 真实计时器等挂载，之后再切成假的 —— 反过来的话 waitFor 自己也被冻住。
    await waitFor(() => expect(screen.getByText('现在就查一次更新')).toBeInTheDocument());
    vi.useFakeTimers();
    fireEvent.click(screen.getByText('现在就查一次更新'));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('查询中…')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(151_000);
    // 放开按钮之后 finally 还要重读 build/pending/log，那几个 then 各占一轮微任务。
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('现在就查一次更新')).toBeInTheDocument();
    expect(screen.getByText(/还没有回来/)).toBeInTheDocument();
  });

  it('CapacitorUpdater 没注册上时明说「不是超时，是没链进这次构建」', async () => {
    mockRunning.mockResolvedValue({ native: '0.6.1', bundle: 'builtin' });
    mockProbe.mockReturnValue({
      bridgePresent: true,
      registered: ['App', 'SplashScreen'],
      updaterRegistered: false,
      updaterMethods: null,
    });
    render(<VersionSection />);
    await waitFor(() =>
      expect(screen.getByText(/不在这份名单里/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/只能发新包/)).toBeInTheDocument();
  });

  it('CapacitorUpdater 注册成功时报出它的方法名', async () => {
    mockRunning.mockResolvedValue({ native: '0.6.1', bundle: 'builtin' });
    mockProbe.mockReturnValue({
      bridgePresent: true,
      registered: ['App', 'CapacitorUpdater'],
      updaterRegistered: true,
      updaterMethods: ['current', 'download', 'notifyAppReady'],
    });
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/注册成功/)).toBeInTheDocument());
    expect(screen.getByText(/current、download、notifyAppReady/)).toBeInTheDocument();
  });

  it('上次查更新的记录摆出来 —— 走到哪一步、结论是什么都要看得见', async () => {
    mockRunning.mockResolvedValue({ native: '0.6.1', bundle: 'builtin' });
    mockLog.mockReturnValue({
      at: Date.now() - 5000,
      steps: ['plugin-import:ok', 'fetch:ok', 'current:timeout', 'getInfo:ok', 'decide:download'],
      outcome: '下载并登记 0.6.1+e209c83',
      probe: { bridgePresent: true, registered: [], updaterRegistered: true, updaterMethods: [] },
    });
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/上次查更新/)).toBeInTheDocument());
    expect(screen.getByText(/current:timeout/)).toBeInTheDocument();
  });

  // 立场在变更 57 反转了：变更 52 当初定的是「从没查过就不画空壳」，而 2026-09-23
  // 的真机反馈恰恰是「没有『上次查更新』这个信息」——那时候这一块不画，于是这条
  // **最强的线索**长得和「一切正常、只是还没查过」一模一样。记录现在是逐步落盘的，
  // 「一笔都没有」因此有了确切含义：它连第一行都没跑到。
  it('一笔记录都没有时**要说出来** —— 那本身就是最强的线索，不是「还没查过」', async () => {
    mockRunning.mockResolvedValue({ native: '0.6.1', bundle: 'builtin' });
    mockLog.mockReturnValue(null);
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/应用壳/)).toBeInTheDocument());
    expect(screen.getByText(/从来没有记下过一次查更新/)).toBeInTheDocument();
  });
});

// ── 桥自检与诊断上报（变更 56）───────────────────────────────────────────
// 存在的理由：「原生桥没回话」底下压着至少四种故障，它们的下一步互不相同，
// 而分辨它们靠的是「逐个方法调一遍、各自计时」这份结果。这一组守的是那份结果
// 真的会显示出来，以及**两个出口都在** —— 发到服务器要求登录是好的，
// 而诊断真正用得上的时候坏的可能正是登录，所以复制那条路必须平行存在。
describe('VersionSection 的桥自检', () => {
  const ios = () => {
    mockRunning.mockResolvedValue({ native: '0.6.4', bundle: 'builtin' });
  };

  it('iOS 上三个出口都在：自检、发到服务器、复制', async () => {
    ios();
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('跑一次桥自检')).toBeInTheDocument());
    expect(screen.getByText('发到服务器')).toBeInTheDocument();
    expect(screen.getByText('复制诊断')).toBeInTheDocument();
  });

  it('自检结果按「方法 → 结果（耗时）」一行行摆出来 —— 耗时本身就是答案', async () => {
    ios();
    mockSelfTest.mockResolvedValue([
      { method: 'getPluginVersion', outcome: 'ok', ms: 8123 },
      { method: 'current', outcome: 'ok', ms: 4 },
      { method: 'App.getInfo', outcome: 'ok', ms: 3 },
    ]);
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('跑一次桥自检')).toBeInTheDocument());
    fireEvent.click(screen.getByText('跑一次桥自检'));
    // 头一个特别慢、后面都快 —— 这个形状就是「插件 load() 慢」而不是「桥哑了」。
    await waitFor(() => expect(screen.getByText(/getPluginVersion → ok（8123ms）/)).toBeInTheDocument());
    expect(screen.getByText(/current → ok（4ms）/)).toBeInTheDocument();
  });

  it('发到服务器成功后把 id 说出来 —— 我在 VPS 上按它取那一份', async () => {
    ios();
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('发到服务器')).toBeInTheDocument());
    fireEvent.click(screen.getByText('发到服务器'));
    await waitFor(() => expect(screen.getByText(/已发送：1758600000000-abc123/)).toBeInTheDocument());
    // 没自检过就直接发的话，那份报告基本说明不了问题 —— 所以先自己跑一遍。
    expect(mockSelfTest).toHaveBeenCalled();
  });

  it('发送失败时说清楚为什么，而不是静静地什么都不发生', async () => {
    ios();
    mockSend.mockRejectedValue(new Error('还没登录 —— 先去上面登录，或者用「复制诊断」'));
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('发到服务器')).toBeInTheDocument());
    fireEvent.click(screen.getByText('发到服务器'));
    await waitFor(() => expect(screen.getByText(/发送失败.*还没登录/)).toBeInTheDocument());
  });

  it('剪贴板被 WKWebView 拒掉时把全文摊开，不假装复制成功', async () => {
    ios();
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText('复制诊断')).toBeInTheDocument());
    fireEvent.click(screen.getByText('复制诊断'));
    await waitFor(() => expect(screen.getByText(/剪贴板用不了/)).toBeInTheDocument());
    expect(screen.getByDisplayValue('一份诊断全文')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('web 上不摆这一组 —— 那边没有桥可自检', async () => {
    mockPlatform.mockResolvedValue('web');
    mockRunning.mockResolvedValue(null);
    render(<VersionSection />);
    await waitFor(() => expect(screen.getByText(/网页版/)).toBeInTheDocument());
    expect(screen.queryByText('跑一次桥自检')).not.toBeInTheDocument();
  });
});
