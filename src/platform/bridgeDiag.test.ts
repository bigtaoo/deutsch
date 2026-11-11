import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  autoSendReport,
  collectDeviceReport,
  reportToText,
  resetAutoReportForTests,
  runUpdaterSelfTest,
  sendDeviceReport,
} from './bridgeDiag';
import { resetBridgeWarmupForTests } from './nativeUpdate';
import { nativePlatform } from './native';
import { installConsoleTap, resetConsoleTapForTests } from './consoleTap';
import { getSessionToken } from '@/sync/session';
import { syncFetch } from '@/sync/client';

vi.mock('./native', () => ({ nativePlatform: vi.fn() }));
vi.mock('@/sync/session', () => ({ getSessionToken: vi.fn() }));
vi.mock('@/sync/client', () => ({ syncFetch: vi.fn() }));
vi.mock('@/sync/config', () => ({ isSyncConfigured: () => true }));

const updater: Record<string, ReturnType<typeof vi.fn>> = {
  getPluginVersion: vi.fn(),
  getBuiltinVersion: vi.fn(),
  getDeviceId: vi.fn(),
  isAutoUpdateEnabled: vi.fn(),
  current: vi.fn(),
  getNextBundle: vi.fn(),
  list: vi.fn(),
};
vi.mock('@capgo/capacitor-updater', () => ({ CapacitorUpdater: updaterProxy() }));

// 生产代码优先从 core 造代理（变更 59，见 acquireUpdater），所以自检这一路也走它。
const registerPlugin = vi.fn();
vi.mock('@capacitor/core', () => ({ registerPlugin: (name: string) => registerPlugin(name) }));

/** 一个只认识 READONLY_METHODS 那几个名字的假插件。 */
function updaterProxy() {
  return new Proxy(
    {},
    {
      get: (_t, name: string) =>
        name in updater ? () => (updater[name] as unknown as () => Promise<unknown>)() : undefined,
      has: (_t, name: string) => name in updater,
    },
  );
}
const getInfo = vi.fn();
vi.mock('@capacitor/app', () => ({ App: { getInfo: () => getInfo() } }));

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  resetBridgeWarmupForTests();
  resetConsoleTapForTests();
  registerPlugin.mockReturnValue(updaterProxy());
  vi.stubGlobal('localStorage', memoryStorage());
  vi.mocked(nativePlatform).mockResolvedValue('ios');
  for (const fn of Object.values(updater)) fn.mockResolvedValue({ ok: true });
  updater.current.mockResolvedValue({ bundle: { version: 'builtin' } });
  getInfo.mockResolvedValue({ version: '0.6.4' });
});

describe('runUpdaterSelfTest', () => {
  it('把每个只读方法逐个调一遍，各自记结果和耗时', async () => {
    const results = await runUpdaterSelfTest();
    // 取插件 + 七个只读方法 + 一个对照组（App.getInfo）。
    expect(results).toHaveLength(9);
    expect(results.every((r) => r.outcome === 'ok')).toBe(true);
    expect(results.map((r) => r.method)).toContain('App.getInfo');
    // **取插件排在最前面**：变更 59 之前这一步不在报告里，而 2026-09-23 那次真机
    // 卡住的恰恰就是它 —— 自检说方法全好、干活那条路却停在取插件上，两句话对不上。
    expect(results[0].method).toBe('acquireUpdater');
    expect(results[0].detail).toBe('core');
    expect(results[1].method).toBe('getPluginVersion');
    expect(typeof results[1].ms).toBe('number');
  });

  // 这是整份自检存在的理由：四种故障各有各的形状，而形状只有逐个调才看得出来。
  it('只有某一个方法哑住时，其余照常回答 —— 分得清「全哑」和「个别坏」', async () => {
    vi.useFakeTimers();
    updater.current.mockReturnValue(new Promise(() => {}));
    const pending = runUpdaterSelfTest();
    await vi.advanceTimersByTimeAsync(30_000);
    const results = await pending;
    vi.useRealTimers();
    const byName = Object.fromEntries(results.map((r) => [r.method, r.outcome]));
    expect(byName.current).toBe('timeout');
    expect(byName.getPluginVersion).toBe('ok');
    expect(byName['App.getInfo']).toBe('ok');
  });

  it('原生侧报错记 rejected，带上它说的那句话', async () => {
    updater.list.mockRejectedValue(new Error('not initialized'));
    const results = await runUpdaterSelfTest();
    const list = results.find((r) => r.method === 'list');
    expect(list?.outcome).toBe('rejected');
    expect(list?.detail).toContain('not initialized');
  });

  it('浏览器里什么都不做 —— 那边没有桥可自检', async () => {
    vi.mocked(nativePlatform).mockResolvedValue('web');
    expect(await runUpdaterSelfTest()).toEqual([]);
  });
});

describe('collectDeviceReport / reportToText', () => {
  it('把自检、插件注册、上次查更新和 console 收进同一份报告', async () => {
    installConsoleTap();
    console.info('🟢 Capacitor-updater : init for device abc');
    const report = await collectDeviceReport(await runUpdaterSelfTest(), 'manual');
    expect(report.schema).toBe(3);
    expect(report.platform).toBe('ios');
    expect(report.selfTest).toHaveLength(9);
    expect(report.console.some((l) => l.text.includes('init for device abc'))).toBe(true);
  });

  it('纯文本形式把自检排成一眼能扫的几行', async () => {
    const text = reportToText(await collectDeviceReport(await runUpdaterSelfTest(), 'manual'));
    expect(text).toContain('桥自检：');
    expect(text).toContain('getPluginVersion → ok');
    expect(text).toContain('App.getInfo → ok');
  });

  // 变更 80：音效在 iPhone 上修了三次都说不清卡在哪 —— 报告里要有它的那一段。
  it('报告带上音效链的状态', async () => {
    const report = await collectDeviceReport([], 'manual');
    expect(report.sfx).toBeDefined();
    expect(reportToText(report)).toMatch(/音效：AudioContext/);
  });
});

describe('sendDeviceReport', () => {
  it('带上会话令牌 POST 到 /v1/diag', async () => {
    vi.mocked(getSessionToken).mockResolvedValue('tok');
    vi.mocked(syncFetch).mockResolvedValue({ id: '1758600000000-abc123' });
    const report = await collectDeviceReport([], 'manual');
    expect(await sendDeviceReport(report)).toEqual({ id: '1758600000000-abc123' });
    expect(vi.mocked(syncFetch)).toHaveBeenCalledWith('/v1/diag', {
      method: 'POST',
      body: report,
      token: 'tok',
    });
  });

  // 诊断真正用得上的时候，坏的可能正是登录 —— 所以这里要给一句能让人走上
  // 「复制诊断」那条路的话，而不是一个看不懂的 401。
  it('没登录时说清楚该走另一条路，不发空请求', async () => {
    vi.mocked(getSessionToken).mockResolvedValue(undefined);
    await expect(sendDeviceReport(await collectDeviceReport([], 'manual'))).rejects.toThrow('复制诊断');
    expect(vi.mocked(syncFetch)).not.toHaveBeenCalled();
  });
});

// ── 自动上报（变更 88）──────────────────────────────────────────────
// 这一组守的是两条硬性质，两条都是「坏了也不会有人发现」的那种：
// ① 它挂在被诊断的功能后面，**永不抛错** —— 上报失败不能把音效、查更新一起带倒；
// ② 结果**一定可见** —— 静默的自动上报等于没上报，而那正是它要治的病。
describe('autoSendReport', () => {
  beforeEach(() => {
    resetAutoReportForTests();
    vi.mocked(getSessionToken).mockResolvedValue('tok');
    vi.mocked(syncFetch).mockResolvedValue({ id: '1790000000000-abc123-sfx' });
  });

  it('发出去了就把 id 说出来 —— 他照着这个 id 问我', async () => {
    expect(await autoSendReport('sfx')).toContain('1790000000000-abc123-sfx');
    expect(vi.mocked(syncFetch)).toHaveBeenCalledWith(
      '/v1/diag',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('把触发源和按钮上那一行结论一起带上', async () => {
    await autoSendReport('sfx', { note: 'right:还没取到，跳过' });
    const body = vi.mocked(syncFetch).mock.calls[0]?.[1]?.body as {
      trigger: string;
      note: string;
      schema: number;
    };
    expect(body.trigger).toBe('sfx');
    expect(body.note).toBe('right:还没取到，跳过');
    expect(body.schema).toBe(3);
  });

  // 没登录是最常见的失败，而它恰恰发生在诊断最用得上的时候。
  it('发不出去不抛错，返回的是为什么', async () => {
    vi.mocked(getSessionToken).mockResolvedValue(undefined);
    const line = await autoSendReport('check-update');
    expect(line).toContain('没上报');
    expect(line).toContain('复制诊断');
  });

  it('收集报告的过程自己炸了也不抛 —— 它不能把被诊断的那个功能带倒', async () => {
    vi.mocked(syncFetch).mockRejectedValue(new Error('offline'));
    await expect(autoSendReport('dict')).resolves.toContain('offline');
  });

  it('同一个按钮连点只发一份', async () => {
    await autoSendReport('sfx');
    expect(await autoSendReport('sfx')).toContain('跳过');
    expect(vi.mocked(syncFetch)).toHaveBeenCalledTimes(1);
  });

  it('不同按钮互不相干 —— 一轮排查里本来就要点好几个', async () => {
    await autoSendReport('sfx');
    await autoSendReport('selftest');
    expect(vi.mocked(syncFetch)).toHaveBeenCalledTimes(2);
  });

  // 失败之后那 3 秒恰恰是最该放行的 3 秒：他看到「还没登录」，去登录，回来再点一次。
  it('上一次失败了，紧接着再点不被节流挡掉', async () => {
    vi.mocked(getSessionToken).mockResolvedValue(undefined);
    expect(await autoSendReport('sfx')).toContain('没上报');
    vi.mocked(getSessionToken).mockResolvedValue('tok');
    expect(await autoSendReport('sfx')).toContain('1790000000000');
  });

  it('报告的纯文本头一行就说清楚是哪个按钮点出来的', async () => {
    const report = await collectDeviceReport([], 'check-update', '一条记录都没有');
    const text = reportToText(report);
    expect(text).toContain('check-update');
    expect(text).toContain('一条记录都没有');
  });
});
