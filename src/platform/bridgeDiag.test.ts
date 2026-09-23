import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectDeviceReport, reportToText, runUpdaterSelfTest, sendDeviceReport } from './bridgeDiag';
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
vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: new Proxy(
    {},
    {
      get: (_t, name: string) =>
        name in updater
          ? () => (updater[name] as unknown as () => Promise<unknown>)()
          : undefined,
      has: (_t, name: string) => name in updater,
    },
  ),
}));
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
  vi.stubGlobal('localStorage', memoryStorage());
  vi.mocked(nativePlatform).mockResolvedValue('ios');
  for (const fn of Object.values(updater)) fn.mockResolvedValue({ ok: true });
  updater.current.mockResolvedValue({ bundle: { version: 'builtin' } });
  getInfo.mockResolvedValue({ version: '0.6.4' });
});

describe('runUpdaterSelfTest', () => {
  it('把每个只读方法逐个调一遍，各自记结果和耗时', async () => {
    const results = await runUpdaterSelfTest();
    // 七个只读方法 + 一个对照组（App.getInfo）。
    expect(results).toHaveLength(8);
    expect(results.every((r) => r.outcome === 'ok')).toBe(true);
    expect(results.map((r) => r.method)).toContain('App.getInfo');
    expect(results[0].method).toBe('getPluginVersion');
    expect(typeof results[0].ms).toBe('number');
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
    const report = await collectDeviceReport(await runUpdaterSelfTest());
    expect(report.schema).toBe(1);
    expect(report.platform).toBe('ios');
    expect(report.selfTest).toHaveLength(8);
    expect(report.console.some((l) => l.text.includes('init for device abc'))).toBe(true);
  });

  it('纯文本形式把自检排成一眼能扫的几行', async () => {
    const text = reportToText(await collectDeviceReport(await runUpdaterSelfTest()));
    expect(text).toContain('桥自检：');
    expect(text).toContain('getPluginVersion → ok');
    expect(text).toContain('App.getInfo → ok');
  });
});

describe('sendDeviceReport', () => {
  it('带上会话令牌 POST 到 /v1/diag', async () => {
    vi.mocked(getSessionToken).mockResolvedValue('tok');
    vi.mocked(syncFetch).mockResolvedValue({ id: '1758600000000-abc123' });
    const report = await collectDeviceReport([]);
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
    await expect(sendDeviceReport(await collectDeviceReport([]))).rejects.toThrow('复制诊断');
    expect(vi.mocked(syncFetch)).not.toHaveBeenCalled();
  });
});
