import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideUpdate, runningBuild, versionAtLeast, type OtaManifest } from './nativeUpdate';
import { nativePlatform } from './native';

// runningBuild 要过原生桥，所以那三个模块得是假的。
// `@/platform/native` 也要假：它内部动态 import `@capacitor/core`，
// 而在 jsdom 里那一趟会得到 'web'，于是 runningBuild 第一行就返回了。
vi.mock('./native', () => ({ nativePlatform: vi.fn() }));

const current = vi.fn();
const getInfo = vi.fn();
vi.mock('@capgo/capacitor-updater', () => ({ CapacitorUpdater: { current: () => current() } }));
vi.mock('@capacitor/app', () => ({ App: { getInfo: () => getInfo() } }));

// 热更的全部判断都在 decideUpdate 里（原生侧只管下载和切换），所以这一组用例就是
// 「什么时候更新、什么时候不更新」的契约。SPEC §7.11。

const manifest = (over: Partial<OtaManifest> = {}): OtaManifest => ({
  buildId: 'a1b2c3d',
  version: '0.4.0+a1b2c3d',
  url: 'https://d.gamestao.com/ota/bundle-a1b2c3d.zip',
  minNative: '0.4.0',
  bytes: 37_000_000,
  ...over,
});

describe('versionAtLeast', () => {
  it('按位比较，不按字典序', () => {
    // 字典序会说 '0.10.0' < '0.9.0'，那会让第 10 个壳版本之后的所有人停在原地。
    expect(versionAtLeast('0.10.0', '0.9.0')).toBe(true);
    expect(versionAtLeast('0.9.0', '0.10.0')).toBe(false);
  });

  it('相等算够', () => {
    expect(versionAtLeast('0.4.0', '0.4.0')).toBe(true);
  });

  it('缺补丁号当 0', () => {
    expect(versionAtLeast('1.2', '1.2.0')).toBe(true);
    expect(versionAtLeast('1.2', '1.2.1')).toBe(false);
  });

  it('解析不出来的当 0.0.0 —— 输给一切，宁可不更新', () => {
    expect(versionAtLeast('', '0.4.0')).toBe(false);
    expect(versionAtLeast('unknown', '0.0.0')).toBe(true);
  });
});

describe('decideUpdate', () => {
  it('内置 bundle 一律要更新 —— 出包那一刻之后的改动全在这个包里', () => {
    expect(decideUpdate(manifest(), 'builtin', '0.4.0')).toEqual({
      action: 'download',
      version: '0.4.0+a1b2c3d',
      url: 'https://d.gamestao.com/ota/bundle-a1b2c3d.zip',
    });
  });

  it('版本一样就不动', () => {
    const d = decideUpdate(manifest(), '0.4.0+a1b2c3d', '0.4.0');
    expect(d).toEqual({ action: 'skip', reason: '已经是最新' });
  });

  it('壳太旧就不下 —— 热更换不了原生代码', () => {
    const d = decideUpdate(manifest({ minNative: '0.5.0' }), 'builtin', '0.4.0');
    expect(d.action).toBe('skip');
    expect(d.action === 'skip' && d.reason).toContain('0.5.0');
  });

  it('壳比门槛新当然可以', () => {
    expect(decideUpdate(manifest({ minNative: '0.4.0' }), 'builtin', '0.6.2').action).toBe(
      'download',
    );
  });

  it('回滚也要跟着走 —— 相等判断，不比大小', () => {
    // 线上出问题回退一个 commit：manifest 的 buildId 变回旧的那个。
    // 比大小的客户端会把这次回退当"旧版"拒掉，恰好在最需要更新的时候不更新。
    const rolledBack = manifest({ buildId: 'old1234', version: '0.4.0+old1234' });
    expect(decideUpdate(rolledBack, '0.4.0+a1b2c3d', '0.4.0').action).toBe('download');
  });

  it('manifest 残缺就当没看见', () => {
    expect(decideUpdate(manifest({ buildId: '' }), 'builtin', '0.4.0').action).toBe('skip');
    expect(decideUpdate(manifest({ url: '' }), 'builtin', '0.4.0').action).toBe('skip');
  });
});

// ── runningBuild：过桥的调用必须有超时 ─────────────────────────────
//
// 这一组守的是一个**藏了一年**的 bug（0.4.0 起，2026-09-22 才发现）：
// 设置页的「版本」块把自己整块抹掉了，在 iPhone 上一次都没出现过。
// 成因是桥调用失败的方式不只是 reject —— 插件没注册、原生侧不回调，
// 那个 Promise 就**永远不 settle**，于是调用方永远等不到答案。
// 不报错、不留日志，症状只是「设置页翻到底什么都没有」。

describe('runningBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nativePlatform).mockResolvedValue('ios');
    current.mockResolvedValue({ bundle: { version: '0.6.0+a1b2c3d' } });
    getInfo.mockResolvedValue({ version: '0.6.0' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('浏览器里直接回 null，一次桥都不过', async () => {
    vi.mocked(nativePlatform).mockResolvedValue('web');
    await expect(runningBuild()).resolves.toBeNull();
    expect(current).not.toHaveBeenCalled();
  });

  it('两个版本号分别来自插件和 App 信息', async () => {
    await expect(runningBuild()).resolves.toEqual({ native: '0.6.0', bundle: '0.6.0+a1b2c3d' });
  });

  it('还没热更过时 bundle 是 builtin —— 界面上再翻译成「随包那份」', async () => {
    current.mockResolvedValue({ bundle: {} });
    await expect(runningBuild()).resolves.toEqual({ native: '0.6.0', bundle: 'builtin' });
  });

  it('桥 reject 时回 null，不抛出去', async () => {
    current.mockRejectedValue(new Error('plugin not implemented'));
    await expect(runningBuild()).resolves.toBeNull();
  });

  it('**桥永远不回调时也要 settle** —— 这正是那个藏了一年的坏法', async () => {
    vi.useFakeTimers();
    current.mockReturnValue(new Promise(() => {}));
    const pending = runningBuild();

    // 没有超时的话，下面这个 await 会一直挂着，而调用方（设置页）就永远停在
    // 「还没问出来」那一档 —— 表现为整块消失。
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeNull();
  });

  it('超时是 4 秒级的 —— 不能久到让人以为这一页坏了', async () => {
    vi.useFakeTimers();
    current.mockReturnValue(new Promise(() => {}));
    let settled = false;
    void runningBuild().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(true);
  });
});
