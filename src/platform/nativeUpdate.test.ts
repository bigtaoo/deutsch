import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkNativeUpdate,
  decideUpdate,
  notifyNativeAppReady,
  probePlugins,
  readLastCheckLog,
  resetBridgeWarmupForTests,
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
const notifyAppReady = vi.fn();
vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    current: () => current(),
    download: (opts: unknown) => download(opts),
    next: (opts: unknown) => next(opts),
    notifyAppReady: () => notifyAppReady(),
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

// **每个用例都要从「桥还没回过话」重新开始。**「桥回过一次话就把超时缩回 4 秒」
// 是模块级状态（nativeUpdate 的 `bridgeEverAnswered`），不清的话前一个用例里一次成功的
// 调用会让后一个用例的超时窗口悄悄从 25 秒变成 4 秒 —— 那正是「单独跑绿、一起跑红」
// 那一类泄漏，而且它会让「冷启动给足时间」这条用例在污染下**假装通过**。
beforeEach(() => {
  resetBridgeWarmupForTests();
});

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
  // 变更 56 在写自检用例时撞出来的一个真缺口：原来这里是 `current.bundle.version`，
  // 原生侧回一个没有 `bundle` 的对象就会抛 TypeError——而这个返回值直接喂给
  // `void runningBuild().then(setBuild)`，抛出去就是一个没人接的 rejection，
  // 设置页永远停在「正在问原生侧版本号…」。**桥回话了反而比不回话更糟**，不能这样。
  it('原生侧回的形状不认识时也不抛 —— 当成 builtin，别把那一块整个抹掉', async () => {
    vi.mocked(nativePlatform).mockResolvedValue('ios');
    current.mockResolvedValue({});
    getInfo.mockResolvedValue({ version: '0.6.4' });
    await expect(runningBuild()).resolves.toMatchObject({ native: '0.6.4', bundle: 'builtin' });
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
    await vi.advanceTimersByTimeAsync(26_000);

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
    await vi.advanceTimersByTimeAsync(26_000);
    await first;
    expect(download).toHaveBeenCalledTimes(1);

    const second = checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(26_000);
    await expect(second).resolves.toMatchObject({ action: 'skip' });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('桥哑着但服务器又发了新版 —— 记号对不上，照样下', async () => {
    vi.useFakeTimers();
    current.mockReturnValue(new Promise(() => {}));
    getInfo.mockReturnValue(new Promise(() => {}));

    const first = checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(26_000);
    await first;

    body.buildId = 'newer99';
    body.version = '0.6.1+newer99';
    const second = checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(26_000);
    await expect(second).resolves.toMatchObject({ action: 'download' });
    expect(download).toHaveBeenCalledTimes(2);
    body.buildId = 'e209c83';
    body.version = '0.6.0+e209c83';
  });

  // ── 冷启动窗口（变更 56）────────────────────────────────────────────
  // 起因：真机上 `probePlugins()` 已经确认 CapacitorUpdater 注册成功，`current()` 还是
  // 超时——而它的 Swift 实现是纯同步、拿到 BundleInfo 立刻 resolve，根本不可能慢。
  // 唯一能让它慢的是它前面那一步：Capacitor 懒加载插件，第一次调用才跑插件的 `load()`，
  // 而 Capgo 的 `load()` 在主线程上做一整套磁盘活 + 发一次统计 + 切 serverBasePath。
  // 4 秒很可能不是「桥哑了」，是**我们在插件正初始化的当口就放弃等待了**。
  it('桥还没回过话时，4 秒不算超时 —— 那可能只是插件正在 load()', async () => {
    vi.useFakeTimers();
    let resolveCurrent: ((v: unknown) => void) | undefined;
    current.mockReturnValue(
      new Promise((resolve) => {
        resolveCurrent = resolve;
      }),
    );
    const pending = checkNativeUpdate();
    // 旧窗口（4 秒）之后：如果这时就判超时，下面这次迟到的回答就白给了。
    await vi.advanceTimersByTimeAsync(9000);
    resolveCurrent!({ bundle: { version: '0.6.0+e209c83' } });
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toMatchObject({ action: 'skip', reason: '已经是最新' });
  });

  it('桥回过一次话之后，超时窗口缩回 4 秒 —— 那之后再慢就真的是有问题', async () => {
    vi.useFakeTimers();
    // 第一趟：正常回答，把「桥是活的」这件事记下来。
    await checkNativeUpdate();
    // 第二趟：这次 current 永远不回。窗口已经缩回 4 秒，所以 5 秒就该判超时，
    // 不用再等满 25 秒。
    current.mockReturnValue(new Promise(() => {}));
    const second = checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(5000);
    await second;
    expect(readLastCheckLog()?.steps).toContainEqual(
      expect.stringMatching(/^current:timeout\(/),
    );
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

  // ── 2026-09-23 真机踩到的坑：download()/next() 裸 await，没有超时 ──────────
  //
  // current()/getInfo() 早就套了 askBridgeVerbose，但下载和登记这两步一直是裸
  // `await`。真机上 current() 4 秒超时后落进 download 分支，然后就卡死在
  // download() 上——「现在就查一次更新」的按钮连着几分钟纹丝不动，和变更 50
  // 那次一模一样的坏法，只是换了个调用。这组测的就是补上的这道超时。

  it('**download() 永不回调也要 settle** —— 不能卡在这里不返回', async () => {
    vi.useFakeTimers();
    download.mockReturnValue(new Promise(() => {}));
    const pending = checkNativeUpdate();

    await vi.advanceTimersByTimeAsync(45_000);
    await expect(pending).resolves.toMatchObject({ action: 'skip' });
    expect(next).not.toHaveBeenCalled(); // 下都没下成，不该去登记
    // 不过桥的那个记号也不该被写下——这一趟根本没有真的下好过。
    expect(localStorage.getItem('ota.queuedBuildId')).toBeNull();
  });

  it('download() 真的报错（reject）—— 不用等超时，立刻反映', async () => {
    download.mockRejectedValue(new Error('network unreachable'));
    const d = await checkNativeUpdate();
    expect(d).toMatchObject({ action: 'skip' });
    expect(d && d.action === 'skip' && d.reason).toContain('rejected');
  });

  it('**next() 永不回调也要 settle**，且不能假装登记成功了', async () => {
    vi.useFakeTimers();
    next.mockReturnValue(new Promise(() => {}));
    const pending = checkNativeUpdate();

    await vi.advanceTimersByTimeAsync(10_000);
    const d = await pending;
    expect(d).toMatchObject({ action: 'skip' });
    // 包已经"下好"了（download 那步是 mock 的即时 resolve），但 next 没登记成——
    // 设置页不该显示"已下好，下次打开生效"，那样是在撒谎，记号也不该落地。
    expect(localStorage.getItem('ota.queuedBuildId')).toBeNull();
  });
});

// ── notifyNativeAppReady：热更的回滚安全网 ─────────────────────────────
//
// 不调它的后果是「下次启动退回上一个 bundle」，而那看起来就是「热更根本没生效」——
// 又一个不报错、不留日志的坏法。它由 App.tsx 在启动时序的 onAlive 那一档调用
// （src/app/boot.ts：**一张读不完的表不能把它挡住**，否则插件 20 秒后就回滚了）。

describe('notifyNativeAppReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nativePlatform).mockResolvedValue('ios');
    notifyAppReady.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('iOS 上真的告诉原生侧「这一版起来了」', async () => {
    await notifyNativeAppReady();
    expect(notifyAppReady).toHaveBeenCalledTimes(1);
  });

  it('浏览器里是空操作，一次桥都不过', async () => {
    vi.mocked(nativePlatform).mockResolvedValue('web');
    await notifyNativeAppReady();
    expect(notifyAppReady).not.toHaveBeenCalled();
  });

  it('插件没装时安静跳过 —— 旧壳照常跑它自己那份 dist', async () => {
    notifyAppReady.mockRejectedValue(new Error('plugin not implemented'));
    // 抛给调用方的话，App.tsx 那一档里排在它后面的「查更新」就不跑了。
    await expect(notifyNativeAppReady()).resolves.toBeUndefined();
  });

  // 这一条守的是变更 52 才补上的那个自锁点：原来这里没有超时，桥哑了这一步就永远
  // 挂着，20 秒后插件判定 bundle 起不来并回滚 —— 而调用方（App.tsx 的 onAlive）
  // 排在它后面的 checkNativeUpdate() 也永远轮不到。
  it('桥永远不回调也要 settle，不能把调用方挂住', async () => {
    vi.useFakeTimers();
    notifyAppReady.mockReturnValue(new Promise(() => {}));
    let settled = false;
    void notifyNativeAppReady().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(true);
  });
});

// ── probePlugins：不过桥，回答「插件到底注册没注册」（变更 52）───────────────
//
// 这组测的是文件头「诊断」那段的核心判据：桥调用挂住有两种完全不同的成因——
// 类没链进二进制（这份名单里压根没有它）、和调用本身超时（名单里有，就是没人回）。
// 两者的下一步不同，`probePlugins()` 存在的全部意义就是把它们分开。

describe('probePlugins', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'Capacitor');
  });

  it('浏览器里没有 window.Capacitor —— 如实说不存在', () => {
    expect(probePlugins()).toEqual({
      bridgePresent: false,
      registered: [],
      updaterRegistered: false,
      updaterMethods: null,
    });
  });

  it('桥在但一个插件都还没注册（PluginHeaders 是空数组）', () => {
    Object.defineProperty(window, 'Capacitor', {
      value: { PluginHeaders: [] },
      configurable: true,
    });
    expect(probePlugins()).toEqual({
      bridgePresent: true,
      registered: [],
      updaterRegistered: false,
      updaterMethods: null,
    });
  });

  it('**类没链进二进制的那种失败**：别的插件都注册了，唯独 CapacitorUpdater 不在名单里', () => {
    Object.defineProperty(window, 'Capacitor', {
      value: {
        PluginHeaders: [
          { name: 'App', methods: [{ name: 'getInfo' }] },
          { name: 'SplashScreen', methods: [{ name: 'hide' }] },
        ],
      },
      configurable: true,
    });
    const p = probePlugins();
    expect(p.bridgePresent).toBe(true);
    expect(p.registered).toEqual(['App', 'SplashScreen']);
    expect(p.updaterRegistered).toBe(false);
    expect(p.updaterMethods).toBeNull();
  });

  it('注册成功时报出它的方法名 —— 这一档才是「调用本身超时」，不是没注册', () => {
    Object.defineProperty(window, 'Capacitor', {
      value: {
        PluginHeaders: [
          { name: 'App', methods: [{ name: 'getInfo' }] },
          {
            name: 'CapacitorUpdater',
            methods: [{ name: 'current' }, { name: 'download' }, { name: 'notifyAppReady' }],
          },
        ],
      },
      configurable: true,
    });
    const p = probePlugins();
    expect(p.updaterRegistered).toBe(true);
    expect(p.updaterMethods).toEqual(['current', 'download', 'notifyAppReady']);
  });

  it('格式不认识（不是数组）时不炸，按「没有插件」处理', () => {
    Object.defineProperty(window, 'Capacitor', {
      value: { PluginHeaders: 'not-an-array' },
      configurable: true,
    });
    expect(probePlugins()).toEqual({
      bridgePresent: true,
      registered: [],
      updaterRegistered: false,
      updaterMethods: null,
    });
  });

  // 这一块读的是原生侧塞过来的数据，不是这个应用自己写的——格式走样不该让诊断本身
  // 炸掉（诊断炸了比诊断说不清楚还糟，那是「翻到底什么都没有」的另一种版本）。
  it('数组里混进不是对象的元素、缺 name 的元素——照单跳过，不影响其余的正常读出', () => {
    Object.defineProperty(window, 'Capacitor', {
      value: {
        PluginHeaders: [
          null,
          'not-a-header',
          42,
          { methods: [{ name: 'x' }] }, // 缺 name
          { name: 'App', methods: [{ name: 'getInfo' }] },
        ],
      },
      configurable: true,
    });
    const p = probePlugins();
    expect(p.registered).toEqual(['App']);
    expect(p.updaterRegistered).toBe(false);
  });

  it('CapacitorUpdater 注册了但 methods 字段形状不对（不是数组）——报出「注册了」但方法列表给空', () => {
    Object.defineProperty(window, 'Capacitor', {
      value: {
        PluginHeaders: [{ name: 'CapacitorUpdater', methods: 'not-an-array' }],
      },
      configurable: true,
    });
    const p = probePlugins();
    expect(p.updaterRegistered).toBe(true);
    expect(p.updaterMethods).toEqual([]);
  });

  it('methods 数组里混进不是对象/缺 name 的方法条目——照单跳过', () => {
    Object.defineProperty(window, 'Capacitor', {
      value: {
        PluginHeaders: [
          {
            name: 'CapacitorUpdater',
            methods: [null, 'x', { rtype: 'promise' }, { name: 'current' }],
          },
        ],
      },
      configurable: true,
    });
    expect(probePlugins().updaterMethods).toEqual(['current']);
  });
});

// ── checkNativeUpdate 的诊断日志：重启多少次都一样时，至少剩一份能看的记录 ─────
//
// 变更 50 那次的死锁里，手机重启五次「不报错、不留日志」。这组测的是补上的那份
// `CheckLogEntry`：不管走到哪一步、怎么失败，都要落地，且落地的内容要能回答
// 「卡在哪一步」而不只是「失败了」。

describe('checkNativeUpdate 的诊断日志', () => {
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
    Reflect.deleteProperty(window, 'Capacitor');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'Capacitor');
  });

  it('正常跑完：每一步都按顺序记下，outcome 说人话', async () => {
    await checkNativeUpdate();
    const log = readLastCheckLog();
    // 过桥那几步带上耗时（`current:ok(3ms)`）—— 没有这个数，「4 秒就放弃」和
    // 「等满 25 秒还没回」在日志里长得一模一样，而两者的下一步完全不同。
    expect(log?.steps.map((s) => s.replace(/\(\d+ms\)$/, ''))).toEqual([
      'platform:ios',
      'plugin-import:ok',
      'fetch:ok',
      'current:ok',
      'getInfo:ok',
      'decide:download',
      'download:ok',
      'next:ok',
    ]);
    expect(log?.steps).toContainEqual(expect.stringMatching(/^current:ok\(\d+ms\)$/));
    expect(log?.outcome).toContain(body.version);
  });

  it('桥哑掉时那一步的具体原因（timeout）进日志，而不是整条记录消失', async () => {
    vi.useFakeTimers();
    current.mockReturnValue(new Promise(() => {}));
    const pending = checkNativeUpdate();
    // 26 秒而不是 5 秒：桥在这个会话里还一次都没回过话，所以走的是冷启动窗口
    // （`COLD_BRIDGE_TIMEOUT_MS` = 25 秒）。推 5 秒就断言超时，只有在别的用例
    // 污染了 warmup 标记时才会「通过」。
    await vi.advanceTimersByTimeAsync(26_000);
    await pending;
    const log = readLastCheckLog();
    expect(log?.steps).toContainEqual(expect.stringMatching(/^current:timeout\(\d+ms\)$/));
    expect(log?.steps).toContainEqual(expect.stringMatching(/^getInfo:ok\(/));
    // 未知不拦更新（decideUpdate 的既有约定），所以照样走到下载。
    expect(log?.steps).toContain('decide:download');
  });

  it('manifest 拉不到（fetch 本身悬着）—— 也要超时，也要落一笔', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );
    const pending = checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(9000);
    await expect(pending).resolves.toBeNull();
    const log = readLastCheckLog();
    expect(log?.steps.some((s) => s.startsWith('fetch:threw:'))).toBe(true);
    expect(log?.outcome).toContain('异常');
  });

  it('记录里带着那一刻的插件注册情况 —— 查完不用再猜是哪一种哑', async () => {
    Object.defineProperty(window, 'Capacitor', {
      value: { PluginHeaders: [{ name: 'App', methods: [{ name: 'getInfo' }] }] },
      configurable: true,
    });
    await checkNativeUpdate();
    const log = readLastCheckLog();
    expect(log?.probe).toEqual({
      bridgePresent: true,
      registered: ['App'],
      updaterRegistered: false,
      updaterMethods: null,
    });
  });

  // ── 走不完也要留下记录（变更 57）────────────────────────────────────
  // 2026-09-23 真机上最关键的一条反馈：设置页里**连「上次查更新」那一块都不存在**。
  // 那说明这份记录一次都没写成过——原来它只在 `finally` 里写一次，而函数根本没返回。
  // 于是「最该被记下来的那种故障」恰恰是唯一不留记录的那种。现在每一步立刻落盘。
  it('卡在半路也留得下记录 —— 日志停在哪一步，就是卡在哪一步', async () => {
    vi.useFakeTimers();
    // 让 manifest 那一步永远吊着：AbortController 的 abort 也不理它。
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    void checkNativeUpdate();
    await vi.advanceTimersByTimeAsync(0);
    const log = readLastCheckLog();
    expect(log).not.toBeNull();
    // 停在 `plugin-import:ok` —— 下一步（拉 manifest）就是卡住的那一步。
    expect(log?.steps).toEqual(['platform:ios', 'plugin-import:ok']);
    // 这句话留在那里本身就是答案。
    expect(log?.outcome).toContain('没有走到结束');
    vi.useRealTimers();
  });

  it('连平台都还没问出来时，那一笔「开始了」也已经在盘上了', async () => {
    vi.mocked(nativePlatform).mockReturnValue(new Promise(() => {}));
    void checkNativeUpdate();
    const log = readLastCheckLog();
    expect(log?.steps).toEqual([]);
    expect(log?.outcome).toContain('没有走到结束');
  });

  it('从没查过时是 null，不是抛错', () => {
    expect(readLastCheckLog()).toBeNull();
  });

  it('localStorage 里那份记录是坏 JSON 时也回 null，不炸给调用方', () => {
    localStorage.setItem('ota.lastCheckLog', '{not valid json');
    expect(readLastCheckLog()).toBeNull();
  });

  // 桥哑有两种：一种是永远不 settle（上面「timeout」那条测的），另一种是原生侧
  // 真的回了话但回的是个错误（比如插件初始化失败）。这两种在 `askBridgeVerbose`
  // 里是不同的 `reason`，日志要能分清——否则「原生侧报错」和「问不出来」在诊断里
  // 长一个样，而它们的下一步不同（前者原生侧至少给了错误信息，后者什么都没有）。
  it('原生侧真的报错（reject）时记的是 rejected，不是 timeout', async () => {
    current.mockRejectedValue(new Error('CapacitorUpdater is not initialized'));
    await checkNativeUpdate();
    const log = readLastCheckLog();
    expect(log?.steps).toContainEqual(expect.stringMatching(/^current:rejected\(/));
  });

  // `askBridgeVerbose` 的第三种失败：`make()` 自己同步抛，不走 Promise 那条路——
  // 比如桥返回的对象里那个方法压根不是函数。
  it('过桥调用同步抛出时记的是 threw', async () => {
    current.mockImplementation(() => {
      throw new TypeError('current is not a function');
    });
    await checkNativeUpdate();
    const log = readLastCheckLog();
    expect(log?.steps).toContainEqual(expect.stringMatching(/^current:threw\(/));
  });
});
