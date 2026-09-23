// 原生壳的热更新（SPEC §7.12，变更 41）。**只在 iOS 上生效。**
//
// ── 为什么需要它 ──
// web 版靠 Service Worker 自动更新（§7.6 / 变更 30），原生壳没有这条路：`webDir: 'dist'`
// 把整份前端打进 IPA，冻结在出包那一刻，而 SW 在原生构建里是**故意关掉的**
// （vite.config.ts 的 `disable: native`）。结果是 push main 只更新 d.gamestao.com，
// 手机上一动不动 —— 2026-09-03 出了 ios-v0.3.0 之后，变更 36~40（界面重做、学习记录、
// 译文笔记、人耳确认、查词）在 iPhone 上一个都没有，这就是加热更的直接起因。
//
// ── 为什么是手动模式，不是插件自带的 autoUpdate ──
// autoUpdate 会让原生侧每次启动 **POST** 到 updateUrl 拿 JSON。而 wrangler.jsonc 是
// 纯静态资源部署、没有 Worker 脚本（那句注释「没有后端可写，就没有红线可越」是 §3.1.1 R-1
// 的字面落地）。为一个更新检查引入 Worker 不划算，所以改成：自己 GET 一份静态
// manifest.json，判断逻辑留在 TS 里 —— 顺带让它可以被单测覆盖（decideUpdate）。
//
// ── 更新时机：后台下载，下次冷启动生效 ──
// 用 `next()` 而不是 `set()`。`set()` 会立刻重载 WebView，那等于在练听写的当口把
// 只活在 React state 里的答案（DictationTab 的 `answers`，没落 IndexedDB）清空 ——
// §7.6 里 web 版「不在打字的当口刷」那条教训在这里更严重，因为原生侧换 bundle 是整个
// WebView 重载，比浏览器的 reload 更重。`next()` 只登记「下次加载用这个」，零打断。
//
// ── 那个 404 陷阱：/models/ 与 /dict/ ──
// 热更的机制是把 web 根整个切到 `Library/NoCloud/ionic_built_snapshots/<id>/`。
// 而 `/models/`（418MB 权重，src/align/config.ts 的 LOCAL_MODEL_PATH）和 `/dict/`
// （40MB 词库，src/dict/lookup.ts 的 DICT_BASE）都是**相对站点根的绝对路径**，
// 根一换就全 404。三条路里选了第三条：
//   ① 把它们塞进热更包 —— 每次热更 458MB，不可能；
//   ② 改成 `Capacitor.convertFileSrc()` 指回 app bundle —— `_capacitor_file_` 那个
//      handler 支不支持 **Range** 没有保证，而随包权重正是靠 Range 分块读的
//      （src/align/rangedFetch.ts：187MB 的 onnx 不能整份进内存，退化即被系统杀掉）；
//   ③ **在新 bundle 目录里给 models/dict 建符号链接指回 app bundle** —— web 代码一行
//      不动，路径还是 `/models/`，取数走的还是同一个 WebViewAssetHandler，Range 行为
//      与现在逐字节一致。链接由 AppDelegate 在启动时补齐（ios/App/App/AppDelegate.swift）。
// 所以热更包里**没有** models 与 dict，只有 36MB 的 assets + index.html。
//
// ── 安全网 ──
// `notifyAppReady()` 必须在应用真正起来之后调，否则插件下次启动自动回滚到上一个 bundle。
// 挂在「四张 IndexedDB 表读完」那一刻（App.tsx），而不是模块加载完 —— 后者证明不了
// 什么，一个连库都读不出来的构建照样能执行到 import。
//
// ── 诊断：插件到底注册没注册（变更 52，2026-09-23）──
// 变更 50 修的是「桥调用挂住」，但没回答**为什么**挂住。真机上后来确认 `App.getInfo()`
// 是好的、只有 `CapacitorUpdater.current()` 哑 —— 而两者走的是同一条桥队列
// （`CapacitorBridge.dispatchQueue`，单条串行），队列要是真堵了，`getInfo()` 不可能先回来。
// 所以更像的成因不是「慢」，是 `CapacitorBridge.handleJSCall` 那句
// `guard let plugin = plugins[call.pluginId] ?? load() else { ...; return }`——
// 插件类没注册上，桥直接丢掉这次调用，Promise 永远不会有人 resolve/reject 它。
// `probePlugins()` 不过桥、不等待，同步读 `window.Capacitor.PluginHeaders`
// （原生侧在 document start 就注入了每个**成功注册**的插件的方法表，见
// `JSExport.exportJS`）—— 插件真注册了它就在，真没注册它就不在，据此能把
// 「类没链进二进制/没被发现」和「调用本身超时」这两种成因分开，而这两种成因的下一步
// 完全不同：前者要动 Swift（见 CapApp-SPM.swift），后者纯粹是等或重试。

import { nativePlatform } from './native';

/** 热更包的托管位置。原生壳里 fetch 相对路径会指向 `capacitor://localhost`，必须给绝对 URL。 */
const OTA_BASE = (import.meta.env.VITE_OTA_BASE ?? 'https://d.gamestao.com').replace(/\/$/, '');

/** 内置 bundle（IPA 里那份）在插件里的 version 值。 */
const BUILTIN = 'builtin';

/** manifest.json 的形状。由 scripts/build-ota.mjs 生成，两边必须同步改。 */
export interface OtaManifest {
  /** bundle 标识，取 commit 短 sha。**不做 semver 比较**，理由见 decideUpdate。 */
  buildId: string;
  /** 传给插件的版本号，形如 `0.3.0+a1b2c3d`。插件只拿它当标识，不解释。 */
  version: string;
  /** zip 的绝对地址。 */
  url: string;
  /** 能吃这个包的最低原生壳版本（MARKETING_VERSION）。见 decideUpdate 里那段。 */
  minNative: string;
  /** zip 字节数，只用来在日志里说人话。 */
  bytes: number;
}

export type UpdateDecision =
  | { action: 'skip'; reason: string }
  | { action: 'download'; version: string; url: string };

/**
 * 判断更新时手上**问得出来**的那些数。三个都可能缺 —— 前两个来自原生桥，而桥问不出话
 * 正是 2026-09-22 那次「手机永远停在变更 46」的成因（见 checkNativeUpdate）。
 */
export interface UpdateContext {
  /** 当前跑着的 bundle version（内置是 `'builtin'`）；`undefined` = 过桥问不出来。 */
  currentVersion?: string;
  /** 原生壳版本（App.getInfo().version）；`undefined` = 过桥问不出来。 */
  nativeVersion?: string;
  /** 上次下好并登记为「下次启动用」的 buildId。**不过桥**（localStorage），所以桥死了它还在。 */
  queuedBuildId?: string;
}

/** `0.3.0` → [0,3,0]。非法输入回 [0,0,0]，让它在比较里输给一切。 */
function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** a >= b ? */
export function versionAtLeast(a: string, b: string): boolean {
  const [a1, a2, a3] = parseVersion(a);
  const [b1, b2, b3] = parseVersion(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 >= b3;
}

/**
 * 要不要下这个包。**纯函数，热更的全部判断都在这里** —— 原生侧只负责下载和切换。
 *
 * @param manifest   刚拉到的 manifest
 * @param currentVersion 当前跑着的 bundle version（内置是 `'builtin'`）
 * @param nativeVersion  原生壳版本（App.getInfo().version）
 *
 * ── 为什么用 buildId 相等判断，不用 semver 比大小 ──
 * 只有 main 一条线，每次部署就是「换成这一份」，没有「新旧」需要排序的场景。
 * 而 semver 比较会引入一个真实的坏情况：**回滚**。线上发现问题回退一个 commit 时，
 * 版本号往回走，比大小的客户端会拒绝那次回退 —— 恰好在最需要它生效的时候不生效。
 * 相等判断没有这个问题：manifest 换了就跟着换，方向无所谓。
 *
 * ── minNative 那道门槛为什么不能省 ──
 * 热更只换 JS，换不了原生代码（AppDelegate 的音频会话、Capacitor 插件本身）。一旦哪次
 * 前端改动开始调用新加的原生方法，推给旧壳就是「点了没反应」或直接崩 —— 而崩了至少还有
 * notifyAppReady 的回滚兜着，没反应连兜底都没有。所以每个包自报它要求的最低壳版本。
 *
 * ── 问不出来的数**不许否决更新**（2026-09-22 修）──
 * 这三个数里有两个来自原生桥，而桥问不出话是真实发生过的（见 checkNativeUpdate 的注释）。
 * 原来的写法把「问不出来」和「不满足」混成一谈，于是桥一哑，更新器就永远拒绝更新 ——
 * 而这个故障**只能靠发一个新 IPA 才能解开**，因为修复本身也是 JS。两种坏法的代价不对等：
 *   · 门槛判错（放过一个其实不该下的包）= 「点了没反应」，而且下一版就能修回来；
 *   · 门槛卡死（永远不下）= 这台设备彻底脱离热更，非过 App Store 不可。
 * 所以未知一律按「不阻拦」处理，只有**确实问出来了且确实不够**才拦。
 */
export function decideUpdate(manifest: OtaManifest, ctx: UpdateContext): UpdateDecision {
  if (!manifest.buildId || !manifest.url) {
    return { action: 'skip', reason: 'manifest 缺 buildId 或 url' };
  }
  if (ctx.nativeVersion !== undefined && !versionAtLeast(ctx.nativeVersion, manifest.minNative)) {
    return {
      action: 'skip',
      reason: `这个包要求原生壳 ≥ ${manifest.minNative}，当前 ${ctx.nativeVersion} —— 要去 TestFlight 装新壳`,
    };
  }
  // 内置 bundle 的 version 是 'builtin'，永远不等于 manifest.version，所以第一次
  // 启动就会下。这是对的：IPA 出包那一刻之后 main 上的改动全都在这个包里。
  if (ctx.currentVersion !== undefined) {
    if (ctx.currentVersion === manifest.version) {
      return { action: 'skip', reason: '已经是最新' };
    }
  } else if (ctx.queuedBuildId === manifest.buildId) {
    // 跑着的是哪一版问不出来，但这一版我们自己下过、也登记过了。再下一遍只是把同一个
    // 10MB 重下一次（而且多半是流量），等下次冷启动生效就好。**这条路只在桥哑掉时走** ——
    // 桥好的时候 currentVersion 会直接告诉我们答案。
    return { action: 'skip', reason: '这一版已经下好，等下次冷启动生效' };
  }
  return { action: 'download', version: manifest.version, url: manifest.url };
}

/** 插件是懒加载的 —— 和 native.ts 里其它插件一样，别把它拽进首屏包。 */
async function updater() {
  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
  return CapacitorUpdater;
}

/**
 * 这台设备上原生侧**真的注册成功**的插件有哪些。同步、不过桥 —— 读的是
 * `window.Capacitor.PluginHeaders`，那是 `JSExport.exportJS` 在插件注册成功时
 * （`CapacitorBridge.loadPlugin` 里 `type.init()` 真的造出了实例）一次性注入的静态
 * 数据，跟调用挂不挂没有关系。见文件头「诊断」那段。
 */
export interface PluginProbe {
  /** `window.Capacitor` 存不存在。false 只可能出在浏览器里（原生壳上这个全局必然有）。 */
  bridgePresent: boolean;
  /** 所有注册成功的插件名（`jsName`），比如 `['App', 'SplashScreen', 'CapacitorUpdater', ...]`。 */
  registered: string[];
  /** `CapacitorUpdater` 在不在这份名单里 —— 不在就是「类没链进二进制 / 没被发现」，
   *  不是调用超时，JS 这边什么都做不了。 */
  updaterRegistered: boolean;
  /** `CapacitorUpdater` 注册成功时它对外的方法名（比如有没有 `current`）；没注册就是 `null`。 */
  updaterMethods: string[] | null;
}

/** 没有 `window.Capacitor`（浏览器）或格式不认识时的兜底。 */
const EMPTY_PROBE: PluginProbe = {
  bridgePresent: false,
  registered: [],
  updaterRegistered: false,
  updaterMethods: null,
};

export function probePlugins(): PluginProbe {
  try {
    const cap = (window as unknown as { Capacitor?: { PluginHeaders?: unknown } }).Capacitor;
    if (!cap) return EMPTY_PROBE;
    const headers = cap.PluginHeaders;
    if (!Array.isArray(headers)) return { ...EMPTY_PROBE, bridgePresent: true };
    const names: string[] = [];
    let updaterMethods: string[] | null = null;
    for (const h of headers) {
      if (!h || typeof h !== 'object') continue;
      const name = (h as { name?: unknown }).name;
      if (typeof name !== 'string') continue;
      names.push(name);
      if (name === 'CapacitorUpdater') {
        const methods = (h as { methods?: unknown }).methods;
        updaterMethods = Array.isArray(methods)
          ? methods
              .map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : undefined))
              .filter((n): n is string => typeof n === 'string')
          : [];
      }
    }
    return {
      bridgePresent: true,
      registered: names,
      updaterRegistered: names.includes('CapacitorUpdater'),
      updaterMethods,
    };
  } catch {
    return EMPTY_PROBE;
  }
}

/** 过桥问一个数最多等多久。要么给出答案，要么给出「问不出来」，不能两者都不给。 */
const BRIDGE_TIMEOUT_MS = 4000;

/**
 * `download()` 允许多久。2026-09-23 真机上抓到的坑：`current()`/`getInfo()` 都套了
 * `askBridgeVerbose`，唯独下面 `download()`/`next()` 这两下还是裸 `await`——查了一次
 * 更新，`current()` 4 秒超时（决策因此落进 `download` 分支），然后卡死在 `download()`，
 * 「现在就查一次更新」的按钮**连着好几分钟纹丝不动**，和变更 50 那次一模一样的坏法，
 * 只是这次换了个调用。插件自己的 Swift 实现里 `downloadTimeout` 是 600 秒（真下载大文件
 * 要留的余量），但这里防的不是「文件大下得慢」——manifest 报的包统共几 MB 到十几 MB
 * （§7.12「构建与发布」：33 个文件 10.2 MiB），45 秒对任何正常网络都绰绰有余；
 * 真等到 45 秒还没回，十有八九是同一种桥没回话，而不是网速问题。
 */
const DOWNLOAD_TIMEOUT_MS = 45_000;

/** `next()` 只是登记「下次启动用这个 id」，不碰网络，正常是毫秒级——10 秒纯粹是安全边际。 */
const NEXT_TIMEOUT_MS = 10_000;

/** 一个字符串化的错误消息，不管抛出来的是不是 `Error`。 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return '（无法转成字符串的错误）';
  }
}

/** `askBridgeVerbose` 的结果 —— 比 `T | undefined` 多说一句「问不出来是因为什么」。 */
export type BridgeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'timeout' | 'rejected' | 'threw'; message?: string };

/**
 * 过桥问一个数，**问不出来也要说清楚是哪一种问不出来**，绝不把调用方挂住。
 *
 * 三种失败：`timeout`（插件没注册、原生侧不回调 —— Promise 永远不 settle，见文件头
 * 「诊断」那段）、`rejected`（原生侧真的报了错）、`threw`（`make()` 自己同步抛，比如
 * 插件的 JS chunk 都没 import 成功）。**每个数各问各的**，不要拿 `Promise.all` 把它们
 * 绑在一起 —— 那样一个挂住的调用会把另一个本来问得出来的也一起拖死。
 */
async function askBridgeVerbose<T>(
  make: () => Promise<T>,
  timeoutMs: number = BRIDGE_TIMEOUT_MS,
): Promise<BridgeOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // catch 挂在这里而不是外面：超时之后它才 reject 的话，外面的 try 早就走完了，
      // 那个 rejection 会变成没人接的 unhandledrejection。
      make()
        .then((value) => ({ ok: true, value }) as const)
        .catch((err: unknown) => ({ ok: false, reason: 'rejected', message: errMessage(err) }) as const),
      new Promise<BridgeOutcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
      }),
    ]);
  } catch (err) {
    return { ok: false, reason: 'threw', message: errMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 只要答案、不要诊断时的简化版 —— `runningBuild()` 用这个。 */
async function askBridge<T>(make: () => Promise<T>): Promise<T | undefined> {
  const r = await askBridgeVerbose(make);
  return r.ok ? r.value : undefined;
}

/**
 * 上次下好、已经 `next()` 登记为「下次启动用」的 buildId。
 *
 * 存 localStorage 而不是问插件：**它不过桥**，而这条路存在的全部意义就是在桥哑掉的时候
 * 还能回答「这一版是不是已经下过了」。存不下（隐私模式、被清）只是少一层「别重下」的
 * 保护，不影响更新本身，所以读写都吞掉异常。
 */
const QUEUED_BUILD_KEY = 'ota.queuedBuildId';

function readQueuedBuildId(): string | undefined {
  try {
    return localStorage.getItem(QUEUED_BUILD_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberQueuedBuildId(buildId: string): void {
  try {
    localStorage.setItem(QUEUED_BUILD_KEY, buildId);
  } catch {
    // 见上。
  }
}

/** `fetch` 最多等多久。要么拿到 manifest，要么明确失败，不能悬在那里。 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * 一次「查更新」跑下来的完整记录，**不过桥**（localStorage），供设置页读。
 *
 * 这是回应「手机上到底发生了什么」的最后一道诊断：没有 Mac、看不到 Xcode 控制台，
 * `checkNativeUpdate()` 原来失败就是 `catch { return null }`，重启一次什么都不剩。
 * 现在每一步都记，**无论最终成功、跳过还是异常都要落地**（见下面的 finally）。
 */
export interface CheckLogEntry {
  /** `Date.now()`。 */
  at: number;
  /** 跑到了哪一步，按顺序 append，比如 `['fetch:ok', 'current:timeout', 'getInfo:ok', 'decide:download']`。 */
  steps: string[];
  /** 最终结果的人话摘要。 */
  outcome: string;
  /** 那一刻的插件注册情况 —— 见 `probePlugins()`。 */
  probe: PluginProbe;
}

const CHECK_LOG_KEY = 'ota.lastCheckLog';

function writeCheckLog(entry: CheckLogEntry): void {
  try {
    localStorage.setItem(CHECK_LOG_KEY, JSON.stringify(entry));
  } catch {
    // 存不下就少一份诊断，不影响更新本身。
  }
}

/** 上一次 `checkNativeUpdate()` 跑下来的记录；从没跑过（或存不下）时是 `null`。给设置页用。 */
export function readLastCheckLog(): CheckLogEntry | null {
  try {
    const raw = localStorage.getItem(CHECK_LOG_KEY);
    return raw ? (JSON.parse(raw) as CheckLogEntry) : null;
  } catch {
    return null;
  }
}

/**
 * 告诉原生侧「这一版真的起来了」，取消回滚倒计时。
 *
 * 幂等，浏览器里是空操作。**必须调** —— 不调的话下次启动会退回上一个 bundle，
 * 而那看起来就是「热更根本没生效」。
 *
 * **这一步本身也过桥，也可能挂住**（变更 52）—— 原来这里只吞了 reject，没有超时。
 * 不调用等于插件 20 秒后判定这个 bundle 起不来并回滚，是和 `checkNativeUpdate()`
 * 同一个坑的第三处：同一天已经在这里踩过两次（`runningBuild` 与它自己），不该再漏。
 */
export async function notifyNativeAppReady(): Promise<void> {
  if ((await nativePlatform()) !== 'ios') return;
  const CapacitorUpdater = await updater().catch(() => null);
  if (!CapacitorUpdater) return; // 插件没装（比如还没出带热更的壳）—— 旧壳照常跑它自己那份 dist。
  await askBridgeVerbose(() => CapacitorUpdater.notifyAppReady());
}

/**
 * 查一次更新，有就下载并登记为「下次启动用」。
 *
 * 失败一律吞掉：热更拿不到新版是**退化不是故障**，手上这份照样能用，而弹一个
 * 「更新失败」除了打断练习什么也做不了。真要查就去设置页看当前 bundle（§12.12），
 * 那里现在会显示 `readLastCheckLog()` 的完整过程，不再是「查了但不知道发生了什么」。
 *
 * ── 这里踩过的那个坑：更新器自己挂在原生桥上（2026-09-22，变更 50）──
 * 原来这两行是
 *     `const [current, info] = await Promise.all([CapacitorUpdater.current(), App.getInfo()]);`
 * —— **没有超时**。而同一天早些时候（600fdb5）已经在真机上查实：这两个调用在 iPhone 上
 * 永远不 settle，设置页的「版本」块因此从 0.4.0 起一次都没出现过。那次只给
 * `runningBuild()`（显示用的那条路）加了超时，**漏了这里** —— 而这里才是真正干活的。
 *
 * 后果比整块消失严重得多：manifest 拉到了，然后卡死在这一行，走不到 `download()`。
 * 不报错、不留日志、重启多少次都一样，手机就此**永久脱离热更**。用户 2026-09-22 装上
 * ios-v0.6.0（内置 bundle = 变更 46）之后就是这样：连着五次冷启动纹丝不动，而修复本身
 * 又是 JS、只能靠热更下发 —— 死锁只能靠再发一次 TestFlight 解开。
 *
 * 所以现在：每个数各问各的、各自超时，问不出来就当「未知」继续往下走（decideUpdate 里
 * 那段「未知不许否决更新」）。**更新器宁可多下一次包，也不能有一条会把自己锁死的路。**
 *
 * ── 这次多了什么（变更 52）──
 * 补了两个还没盖到的自锁点：`fetch` 本身没有超时（连接吊住就永远吊住），`updater()`
 * 的 import 失败没有和「超时」分开记。以及最重要的一条：**不管走到哪一步、怎么失败，
 * 都要往 `CheckLogEntry` 里写一笔**——「更新器自己挂住」这类 bug 的本质就是「重启多少次
 * 都一样，且什么都不剩」，而诊断的价值恰恰是把「什么都不剩」变成「剩一份能看的记录」。
 */
export async function checkNativeUpdate(): Promise<UpdateDecision | null> {
  const steps: string[] = [];
  const probe = probePlugins();
  if ((await nativePlatform()) !== 'ios') return null; // 浏览器：不记日志，那边这个函数本来就不该被调用。

  let outcome: UpdateDecision | null = null;
  let outcomeText = '（异常中断）';
  try {
    const CapacitorUpdater = await updater().catch((err: unknown) => {
      steps.push(`plugin-import:threw:${errMessage(err)}`);
      throw err;
    });
    steps.push('plugin-import:ok');

    // cache: 'no-store' —— WKWebView 会缓存这个 JSON，缓存住了就等于热更停摆，
    // 而症状是「部署了但手机不更新」，和没接热更一模一样。
    // 手写 setTimeout + AbortController 而不是 `AbortSignal.timeout()`：后者
    // Safari 16.4 才有，而 `Package.swift` 的部署目标是 iOS 15 ——老设备上它会直接
    // 同步抛 TypeError，等于给一个「治超时」的东西自己引入一种新的失败方式。
    const fetchController = new AbortController();
    const fetchTimer = setTimeout(() => fetchController.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${OTA_BASE}/ota/manifest.json`, {
      cache: 'no-store',
      signal: fetchController.signal,
    })
      .catch((err: unknown) => {
        steps.push(`fetch:threw:${errMessage(err)}`);
        throw err;
      })
      .finally(() => clearTimeout(fetchTimer));
    if (!res.ok) {
      steps.push(`fetch:http-${res.status}`);
      outcome = { action: 'skip', reason: `manifest ${res.status}` };
      outcomeText = outcome.reason;
      return outcome;
    }
    steps.push('fetch:ok');
    const manifest = (await res.json()) as OtaManifest;

    const [current, info] = await Promise.all([
      askBridgeVerbose(() => CapacitorUpdater.current()),
      askBridgeVerbose(async () => (await import('@capacitor/app')).App.getInfo()),
    ]);
    steps.push(`current:${current.ok ? 'ok' : current.reason}`);
    steps.push(`getInfo:${info.ok ? 'ok' : info.reason}`);

    const decision = decideUpdate(manifest, {
      currentVersion: current.ok ? (current.value.bundle.version ?? BUILTIN) : undefined,
      nativeVersion: info.ok ? info.value.version : undefined,
      queuedBuildId: readQueuedBuildId(),
    });
    steps.push(`decide:${decision.action}`);
    if (decision.action === 'skip') {
      outcome = decision;
      outcomeText = decision.reason;
      return outcome;
    }

    const downloaded = await askBridgeVerbose(
      () => CapacitorUpdater.download({ url: decision.url, version: decision.version }),
      DOWNLOAD_TIMEOUT_MS,
    );
    steps.push(`download:${downloaded.ok ? 'ok' : downloaded.reason}`);
    if (!downloaded.ok) {
      // 45 秒还没回应，十有八九是桥没回话，不是文件大——不值得再等，留到下次
      // 冷启动或下次手动点「现在就查一次更新」再试。**绝不能卡在这里不返回**：
      // 这正是这次真机踩到的坑，见 DOWNLOAD_TIMEOUT_MS 的注释。
      outcome = { action: 'skip', reason: `下载没有回应（${downloaded.reason}）——这次没跟上，下次再试` };
      outcomeText = outcome.reason;
      return outcome;
    }

    // next 而不是 set：只登记，不重载。见文件顶部「更新时机」。
    const registered = await askBridgeVerbose(
      () => CapacitorUpdater.next({ id: downloaded.value.id }),
      NEXT_TIMEOUT_MS,
    );
    steps.push(`next:${registered.ok ? 'ok' : registered.reason}`);
    if (!registered.ok) {
      // 包已经下好了，但没能登记成「下次启动用它」——不能假装这一趟成功了
      // （那样设置页会显示「已下好，下次打开生效」，而原生侧其实什么都没登记）。
      outcome = { action: 'skip', reason: `下好了但没能登记为下次启动用（${registered.reason}）——这次白下了，下次再试` };
      outcomeText = outcome.reason;
      return outcome;
    }

    // 先落地再记内存：下次启动桥要是又哑了，就靠这一条判断「这一版不用重下」。
    rememberQueuedBuildId(manifest.buildId);
    pending = decision.version;
    outcome = decision;
    outcomeText = `下载并登记 ${decision.version}`;
    return outcome;
  } catch (err) {
    outcomeText = `异常：${errMessage(err)}`;
    return null;
  } finally {
    writeCheckLog({ at: Date.now(), steps, outcome: outcomeText, probe });
  }
}

/** 这次会话里下好、等着下次启动生效的版本。给设置页用（§12.12）。 */
let pending: string | null = null;

/** @see pending */
export function pendingUpdateVersion(): string | null {
  return pending;
}

export interface RunningBuild {
  /** 原生壳版本（IPA 的 MARKETING_VERSION）。换它必须过 App Store。`undefined` = 问不出来。 */
  native?: string;
  /** 现在真正跑着的那份前端，内置是 `'builtin'`。`undefined` = 问不出来。 */
  bundle?: string;
  /** 上次下好、等着下次冷启动生效的 buildId。**不过桥**，所以上面两个问不出来时它还在。 */
  queued?: string;
}

/**
 * 现在跑的是哪一版。浏览器里回 null —— 那边「哪一版」没有意义，
 * Service Worker 保证你看到的就是最新的（§7.6）。
 *
 * **在原生壳上永远回一个对象，哪怕三个字段全是 undefined。** 「问不出来」本身就是这一块
 * 最该说出口的答案（2026-09-22：原来两个数绑在一个 `Promise.all` 上，一个挂住就整块没有，
 * 于是「版本」块在 iPhone 上一次都没出现过）。现在两个数各问各的，一个哑了另一个照样报。
 */
export async function runningBuild(): Promise<RunningBuild | null> {
  if ((await nativePlatform()) !== 'ios') return null;
  const [current, info] = await Promise.all([
    askBridge(async () => (await updater()).current()),
    askBridge(async () => (await import('@capacitor/app')).App.getInfo()),
  ]);
  return {
    native: info?.version,
    bundle: current ? (current.bundle.version ?? BUILTIN) : undefined,
    queued: readQueuedBuildId(),
  };
}
