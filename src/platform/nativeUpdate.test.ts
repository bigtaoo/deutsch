import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkNativeUpdate,
  decideUpdate,
  runningBuild,
  versionAtLeast,
  type OtaManifest,
} from './nativeUpdate';
import { nativePlatform } from './native';

// runningBuild 要过原生桥，所以那三个模块得是假的。
// `@/platform/native` 也要假：它内部动态 import `@capacitor/core`，
// 而在 jsdom 里那一趟会得到 'web'，于是 runningBuild 第一行就返回了。
vi.mock('./native', () => ({ nativePlatform: vi.fn() }));

const current = vi.fn();
const getInfo = vi.fn();
const download = vi.fn();
const next = vi.fn();
vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    current: () => current(),
    download: (opts: unknown) => download(opts),
    next: (opts: unknown) => next(opts),
  },
}));
vi.mock('@capacitor/app', () => ({ App: { getInfo: () => getInfo() } }));

// 热更的全部判断都在 decideUpdate 里（原生侧只管下载和切换），所以这一组用例就是
// 「什么时候更新、什么时候不更新」的契约。SPEC §7.11。

/**
 * 这个环境里没有 localStorage，而 nativeUpdate 用它记「这一版已经下过了」。
 * 给一个最小的内存实现 —— 这里要测的是那条判断，不是存储本身。
 * （生产代码的读写都在 try/catch 里：存不下只是少一层「别重下」的保护。）
 */
const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
};

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
  const known = { currentVersion: 'builtin', nativeVersion: '0.4.0' };

  it('内置 bundle 一律要更新 —— 出包那一刻之后的改动全在这个包里', () => {
    expect(decideUpdate(manifest(), known)).toEqual({
      action: 'download',
      version: '0.4.0+a1b2c3d',
      url: 'https://d.gamestao.com/ota/bundle-a1b2c3d.zip',
    });
  });

  it('版本一样就不动', () => {
    const d = decideUpdate(manifest(), { ...known, currentVersion: '0.4.0+a1b2c3d' });
    expect(d).toEqual({ action: 'skip', reason: '已经是最新' });
  });

  it('壳太旧就不下 —— 热更换不了原生代码', () => {
    const d = decideUpdate(manifest({ minNative: '0.5.0' }), known);
    expect(d.action).toBe('skip');
    expect(d.action === 'skip' && d.reason).toContain('0.5.0');
  });

  it('壳比门槛新当然可以', () => {
    expect(
      decideUpdate(manifest({ minNative: '0.4.0' }), { ...known, nativeVersion: '0.6.2' }).action,
    ).toBe('download');
  });

  it('回滚也要跟着走 —— 相等判断，不比大小', () => {
    // 线上出问题回退一个 commit：manifest 的 buildId 变回旧的那个。
    // 比大小的客户端会把这次回退当"旧版"拒掉，恰好在最需要更新的时候不更新。
    const rolledBack = manifest({ buildId: 'old1234', version: '0.4.0+old1234' });
    expect(decideUpdate(rolledBack, { ...known, currentVersion: '0.4.0+a1b2c3d' }).action).toBe(
      'download',
    );
  });

  it('manifest 残缺就当没看见', () => {
    expect(decideUpdate(manifest({ buildId: '' }), known).action).toBe('skip');
    expect(decideUpdate(manifest({ url: '' }), known).action).toBe('skip');
  });

  // ── 「问不出来」不等于「不满足」（2026-09-22）─────────────────────────
  //
  // 这三条守的是那个把手机彻底锁死的判断：桥问不出数时，原来的写法会把未知
  // 当成「不够格」而拒绝更新，于是设备永久脱离热更，非发新包不可。

  it('壳版本问不出来时**不卡** minNative —— 否则桥一哑就永远不更新了', () => {
    const d = decideUpdate(manifest({ minNative: '9.9.9' }), { currentVersion: 'builtin' });
    expect(d.action).toBe('download');
  });

  it('跑着哪一版问不出来时照样下 —— 宁可多下一次，也不要一次都不下', () => {
    expect(decideUpdate(manifest(), { nativeVersion: '0.6.0' }).action).toBe('download');
  });

  it('但同一版已经下过就别重下 —— 这条不过桥，靠自己留的记号', () => {
    const d = decideUpdate(manifest(), { nativeVersion: '0.6.0', queuedBuildId: 'a1b2c3d' });
    expect(d).toEqual({ action: 'skip', reason: '这一版已经下好，等下次冷启动生效' });
  });

  it('记号对不上（又发了新版）就继续下', () => {
    expect(decideUpdate(manifest(), { queuedBuildId: 'older11' }).action).toBe('download');
  });

  it('桥好的时候记号不参与判断 —— currentVersion 才是权威', () => {
    // 已经下过 a1b2c3d 但回滚失败、现在跑的还是旧的：该重下，不该被记号挡住。
    const d = decideUpdate(manifest(), {
      currentVersion: '0.4.0+old1234',
      nativeVersion: '0.4.0',
      queuedBuildId: 'a1b2c3d',
    });
    expect(d.action).toBe('download');
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
    vi.stubGlobal('localStorage', memoryStorage());
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

  it('一个数问不出来，另一个照样报 —— 两个数各问各的', async () => {
    current.mockRejectedValue(new Error('plugin not implemented'));
    await expect(runningBuild()).resolves.toEqual({ native: '0.6.0', bundle: undefined });
  });

  it('**桥永远不回调时也要 settle** —— 这正是那个藏了一年的坏法', async () => {
    vi.useFakeTimers();
    current.mockReturnValue(new Promise(() => {}));
    const pending = runningBuild();

    // 没有超时的话，下面这个 await 会一直挂着，而调用方（设置页）就永远停在
    // 「还没问出来」那一档 —— 表现为整块消失。
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ native: '0.6.0', bundle: undefined });
  });

  it('两个都哑了也要回一个对象 —— 「问不出来」本身就是要显示的答案', async () => {
    vi.useFakeTimers();
    current.mockReturnValue(new Promise(() => {}));
    getInfo.mockReturnValue(new Promise(() => {}));
    const pending = runningBuild();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ native: undefined, bundle: undefined });
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

// ── checkNativeUpdate：更新器自己不能被桥挂死 ───────────────────────────
//
// 这一组守的是 2026-09-22 那个**把整台设备锁死**的 bug。600fdb5 已经查实两个过桥调用
// 在 iPhone 上永远不 settle，并给 runningBuild() 加了超时 —— 但漏了这里，而这里才是
// 真正干活的那条路。症状：manifest 拉到了，然后卡死，走不到 download()；不报错、不留
// 日志、重启多少次都一样。而修复本身是 JS、只能靠热更下发，所以这个死锁**只能靠再发一次
// TestFlight 解开**。一条会把自己锁死的更新路径，是这个项目里代价最高的一类 bug。

describe('checkNativeUpdate', () => {
  const body = {
    buildId: 'e209c83',
    version: '0.6.0+e209c83',
    url: 'https://d.gamestao.com/ota/bundle-e209c83.zip',
    minNative: '0.4.0',
    bytes: 10_792_911,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', memoryStorage());
    vi.mocked(nativePlatform).mockResolvedValue('ios');
    current.mockResolvedValue({ bundle: { version: 'builtin' } });
    getInfo.mockResolvedValue({ version: '0.6.0' });
    download.mockResolvedValue({ id: 'bundle-1' });
    next.mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => body }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('正常情况下下载并登记为「下次启动用」', async () => {
    const d = await checkNativeUpdate();
    expect(d).toEqual({ action: 'download', version: body.version, url: body.url });
    expect(download).toHaveBeenCalledWith({ url: body.url, version: body.version });
    expect(next).toHaveBeenCalledWith({ id: 'bundle-1' });
  });

  it('**桥永远不回调时照样把包下下来** —— 这正是那个把手机锁死的坏法', async () => {
    vi.useFakeTimers();
    current.mockReturnValue(new Promise(() => {}));
    getInfo.mockReturnValue(new Promise(() => {}));

    const pending = checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(5000);

    // 修之前：这里永远等不到，download 一次都不会被调用，设备永久脱离热更。
    await expect(pending).resolves.toMatchObject({ action: 'download' });
    expect(download).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('桥哑着时下过一次就不再重下 —— 免得每次冷启动都白下 10MB', async () => {
    vi.useFakeTimers();
    current.mockReturnValue(new Promise(() => {}));
    getInfo.mockReturnValue(new Promise(() => {}));

    const first = checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    expect(download).toHaveBeenCalledTimes(1);

    const second = checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(second).resolves.toMatchObject({ action: 'skip' });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('桥哑着但服务器又发了新版 —— 记号对不上，照样下', async () => {
    vi.useFakeTimers();
    current.mockReturnValue(new Promise(() => {}));
    getInfo.mockReturnValue(new Promise(() => {}));

    const first = checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(5000);
    await first;

    body.buildId = 'newer99';
    body.version = '0.6.1+newer99';
    const second = checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(second).resolves.toMatchObject({ action: 'download' });
    expect(download).toHaveBeenCalledTimes(2);
    body.buildId = 'e209c83';
    body.version = '0.6.0+e209c83';
  });

  it('manifest 拉不到就安静跳过，不抛给调用方', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(checkNativeUpdate()).resolves.toEqual({ action: 'skip', reason: 'manifest 404' });
    expect(download).not.toHaveBeenCalled();
  });

  it('浏览器里一次桥都不过', async () => {
    vi.mocked(nativePlatform).mockResolvedValue('web');
    await expect(checkNativeUpdate()).resolves.toBeNull();
    expect(download).not.toHaveBeenCalled();
  });
});
