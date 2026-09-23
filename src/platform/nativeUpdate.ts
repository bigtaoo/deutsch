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

/**
 * 给任何一个 promise 一个死线。超时回 `null`，**不抛** —— 调用方要的是
 * 「这条路这次走不通」，不是一个新的失败方式。
 *
 * 和 `askBridgeVerbose` 的分工：那个管**过桥**的调用（要分辨 timeout/rejected/threw、
 * 要记耗时、要认冷启动），这个管**拿东西**的那一步（动态 import、造代理）。
 * 2026-09-23 那次真机故障恰恰卡在后者上 —— 前者每一处都有死线，而它前面那一步没有。
 *
 * 导出只为了能单独测它：**「这条路上的每一个 await 都有死线」这句话本身要有用例守着**，
 * 而它在 `acquireUpdater()` 里那两处的参数是动态 import，在 jsdom 里没法让它们真的吊住。
 */
export async function withDeadline<T>(make: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // catch 挂在里面：超时之后它才 reject 的话，外面早就走完了，那会变成
      // 没人接的 unhandledrejection（和 askBridgeVerbose 同一个理由）。
      (async () => make())().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 拿插件这一步最多等多久。两条路各自算，加起来最坏 16 秒 —— 没有人在等这个结果。 */
const PLUGIN_TIMEOUT_MS = 8000;

/** 只用到这几个方法。**手写而不是 import 插件包的类型**，理由见 `acquireUpdater()`。 */
export interface UpdaterPlugin {
  current(): Promise<{ bundle?: { version?: string } }>;
  download(opts: { url: string; version: string }): Promise<{ id: string }>;
  next(opts: { id: string }): Promise<unknown>;
  notifyAppReady(): Promise<unknown>;
}

/** 这个会话里已经拿到的插件代理。拿到过一次就不再重新取。 */
let updaterPlugin: UpdaterPlugin | null = null;

/**
 * 拿到更新器插件，**并说清楚是从哪条路拿到的**。
 *
 * ── 2026-09-23 那份真机诊断指认的就是这里（变更 59）──
 * `probePlugins()` 说 `CapacitorUpdater` 注册成功、七个只读方法逐个调都是 0~5 毫秒，
 * 桥、插件、原生侧全是好的。而同一份报告里「上次查更新」的步骤停在 `['platform:ios']`
 * —— `checkNativeUpdate()` 走到这个函数就再也没有回来。同一次启动里
 * `notifyNativeAppReady()` 也没有到达原生侧（原生日志里没有那句「notifyAppReady was
 * called」，只有回滚检查自己的定时器打出来的「Built-in bundle is active」），
 * 而它在平台判断之后的下一步同样是这个函数。**两条路停在同一行**：
 * `await import('@capgo/capacitor-updater')`。
 *
 * 旁证在原生日志里：那次启动打过一条 `Semaphore wait timed out after 20000ms` ——
 * 插件 `load()` armed 的那个信号量等满 20 秒才放开，而这段时间它正在主线程上做磁盘活
 * 并 `setServerBasePath()` 切 WebView 的 web 根。**chunk 是同一个 WebView 取的**：
 * 根在切、handler 在忙，这一次 4KB 的 chunk 请求就悬在那儿，既不成功也不失败，
 * 而 `import()` 对「请求永远不回」的表现就是 promise 永远不 settle。
 *
 * ── 为什么改成不走那个 import ──
 * 插件包的 JS 层是一层壳：`registerPlugin('CapacitorUpdater')` 造一个代理，代理的每个
 * 方法就是 `Capacitor.nativePromise('CapacitorUpdater', 方法名, 参数)`（见
 * node_modules/@capacitor/core/dist/index.js 的 `createPluginMethod`）。而
 * `registerPlugin` 在 `@capacitor/core` 里，core 这个 chunk **在走到这里之前必然已经
 * 加载完了** —— `nativePlatform()` 用的就是它，日志里那句 `platform:ios` 就是证据。
 * 所以：直接用 core 造代理，热更这条路上从此**一个新 chunk 都不用取**，
 * 「取 chunk 取到一半 web 根被换掉」那个窗口就不存在了。
 *
 * 跳过的是插件包 JS 层的副作用（它给 history 打的那个补丁，服务于
 * `keep_url_path_after_reload`）——本项目是 hash 路由、也没开那个选项，用不到。
 * 类型也因此手写（上面的 `UpdaterPlugin`）：`import type` 不留运行时代码，但会把
 * 「这个包必须存在」写进构建，而这里的目的正是让热更不再依赖它。
 *
 * ── 为什么两条路都还有死线 ──
 * 「换一条不会挂的路」和「这条路万一也挂了怎么办」是两件事。core 已经在内存里、
 * `registerPlugin` 是同步的，但「理论上不会挂」在这条路上已经被现实打脸三次
 * （变更 50/52/53）。所以照旧：每一步给死线，拿不到就明说拿不到，**绝不挂住调用方**。
 */
export async function acquireUpdater(): Promise<{ plugin: UpdaterPlugin | null; via: string }> {
  if (updaterPlugin) return { plugin: updaterPlugin, via: 'cached' };

  // 第一条路：core 造代理，不取任何新 chunk。
  const core = await withDeadline(() => import('@capacitor/core'), PLUGIN_TIMEOUT_MS);
  if (core) {
    try {
      // 造两次只会 warn 一句并回同一个代理（core 的 registeredPlugins），不是错误。
      updaterPlugin = core.registerPlugin<UpdaterPlugin>('CapacitorUpdater');
      return { plugin: updaterPlugin, via: 'core' };
    } catch {
      // core 的形状变了之类 —— 落到下面那条老路。
    }
  }

  // 第二条路：老办法。core 拿不到时它多半也拿不到，但「多半」不是「一定」。
  const mod = await withDeadline(() => import('@capgo/capacitor-updater'), PLUGIN_TIMEOUT_MS);
  const fromPackage = mod?.CapacitorUpdater as UpdaterPlugin | undefined;
  if (fromPackage) {
    updaterPlugin = fromPackage;
    return { plugin: updaterPlugin, via: 'import' };
  }
  return { plugin: null, via: core ? 'core-failed,import-failed' : 'core-timeout,import-failed' };
}

/** 拿不到插件就抛 —— 给 `askBridge` 那条路用，它会把抛出去的变成「问不出来」。 */
async function updater(): Promise<UpdaterPlugin> {
  const { plugin, via } = await acquireUpdater();
  if (!plugin) throw new Error(`拿不到更新器插件（${via}）`);
  return plugin;
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

/**
 * **桥还一次都没回过话时**，每个调用至少等这么久（变更 56）。
 *
 * 起因是 2026-09-23 那次真机：`probePlugins()` 已经确认 `CapacitorUpdater` 注册成功，
 * 可 `current()` 还是 4 秒超时 —— 而 `current()` 的 Swift 实现是纯同步、拿到 BundleInfo
 * 立刻 `call.resolve()`（CapacitorUpdaterPlugin.swift 的 `@objc func current`），
 * 它**不可能慢**。唯一能让它慢的是它前面那一步：Capacitor 的插件是懒加载的，
 * 第一次桥调用才 `loadPlugin()` → 跑插件的 `load()`，而 Capgo 的 `load()` 在主线程上
 * 做了一整套磁盘活（`cleanupObsoleteVersions`、默认频道状态文件、`autoReset`）、
 * 发一次统计到 capgo 的服务器、最后还要 `initialLoad()` 去切 WebView 的 serverBasePath。
 * 4 秒很可能根本不是「桥哑了」，而是**我们在插件正初始化的当口就放弃等待了**。
 *
 * 所以：**在这个会话里桥还一次都没回过话之前，一律按冷启动算，给足时间。**
 * 只要有过一次回话（resolve 或 reject 都算 —— 原生侧真的动了），就切回 4 秒，
 * 因为那之后再慢就真的是有问题了。代价只有「最坏情况下多等二十几秒」，
 * 而这几个调用没有一个是挡在用户前面的。
 */
const COLD_BRIDGE_TIMEOUT_MS = 25_000;

/** 这个会话里原生桥有没有回过话（resolve/reject 都算）。见 `COLD_BRIDGE_TIMEOUT_MS`。 */
let bridgeEverAnswered = false;

/**
 * 测试用：把这个模块所有的模块级状态清回出厂 —— 「桥回过话」的记号、缓存的插件代理、
 * 内存里的那份查更新记录与存储失败原因。
 *
 * **每个用例都要调一次。** 这里每一项都是「上一个用例留下来会让下一个用例悄悄换个
 * 行为」的那种状态：`bridgeEverAnswered` 会把冷启动的 25 秒窗口缩成 4 秒，
 * `updaterPlugin` 会让「拿插件」那两条路根本不跑，`liveCheckLog` 会让
 * `readLastCheckLog()` 读不到这个用例自己摆进 localStorage 的东西。
 */
export function resetBridgeWarmupForTests(): void {
  bridgeEverAnswered = false;
  updaterPlugin = null;
  liveCheckLog = null;
  lastWriteError = null;
  appReadyLog = null;
}

/**
 * `askBridgeVerbose` 的结果 —— 比 `T | undefined` 多说两句：「问不出来是因为什么」
 * 和「等了多久」。**耗时是这一块最贵的诊断数据**：同一个 `timeout`，等了 4 秒和等了
 * 25 秒是两种完全不同的故障；而一个 9 秒才回来的 `ok`，直接就指认出「慢」而不是「哑」。
 */
export type BridgeOutcome<T> =
  | { ok: true; value: T; ms: number }
  | { ok: false; reason: 'timeout' | 'rejected' | 'threw'; message?: string; ms: number };

/**
 * 过桥问一个数，**问不出来也要说清楚是哪一种问不出来**，绝不把调用方挂住。
 *
 * 三种失败：`timeout`（插件没注册、原生侧不回调 —— Promise 永远不 settle，见文件头
 * 「诊断」那段）、`rejected`（原生侧真的报了错）、`threw`（`make()` 自己同步抛，比如
 * 插件的 JS chunk 都没 import 成功）。**每个数各问各的**，不要拿 `Promise.all` 把它们
 * 绑在一起 —— 那样一个挂住的调用会把另一个本来问得出来的也一起拖死。
 *
 * 传进来的 `timeoutMs` 是**下限**：桥还没回过话时按 `COLD_BRIDGE_TIMEOUT_MS` 放宽。
 *
 * `allowCold=false` 关掉那条放宽 —— **给显示用的那条路**（`runningBuild()`）。
 * 设置页那两行版本号是人盯着等的，「4 秒级，不能久到让人以为这一页坏了」是它从一开始
 * 就有的约定；而放宽超时要换的东西是「后台那几个调用别半途放弃」，两者不冲突，
 * 也不该互相迁就：干活的那条路等久一点没人看见，显示的那条路等久一点就是坏掉的观感。
 */
export async function askBridgeVerbose<T>(
  make: () => Promise<T>,
  timeoutMs: number = BRIDGE_TIMEOUT_MS,
  allowCold = true,
): Promise<BridgeOutcome<T>> {
  const started = Date.now();
  const effectiveTimeout =
    bridgeEverAnswered || !allowCold ? timeoutMs : Math.max(timeoutMs, COLD_BRIDGE_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      // catch 挂在这里而不是外面：超时之后它才 reject 的话，外面的 try 早就走完了，
      // 那个 rejection 会变成没人接的 unhandledrejection。
      make()
        .then((value) => ({ ok: true, value }) as const)
        .catch((err: unknown) => ({ ok: false, reason: 'rejected', message: errMessage(err) }) as const),
      new Promise<{ ok: false; reason: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), effectiveTimeout);
      }),
    ]);
    // reject 也算「回过话」：原生侧真的执行了，慢的那一段（插件 load()）已经过去了。
    if (outcome.ok || outcome.reason === 'rejected') bridgeEverAnswered = true;
    const ms = Date.now() - started;
    return outcome.ok
      ? { ok: true, value: outcome.value, ms }
      : { ok: false, reason: outcome.reason, message: 'message' in outcome ? outcome.message : undefined, ms };
  } catch (err) {
    return { ok: false, reason: 'threw', message: errMessage(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一步的记录，形如 `current:ok(37ms)` / `current:timeout(25003ms)`。
 *
 * **耗时必须写进去**：没有它，「4 秒就放弃」和「等满 25 秒还没回」在日志里长得一模一样，
 * 而这两种情况的下一步完全不同（前者是我们等得不够，后者才是桥真的哑了）。
 */
function step<T>(name: string, outcome: BridgeOutcome<T>): string {
  return `${name}:${outcome.ok ? 'ok' : outcome.reason}(${outcome.ms}ms)`;
}

/**
 * 只要答案、不要诊断时的简化版 —— `runningBuild()` 用这个。
 * **不走冷启动放宽**（见 `askBridgeVerbose` 的 `allowCold`）：这条路是给人看的。
 */
async function askBridge<T>(make: () => Promise<T>): Promise<T | undefined> {
  const r = await askBridgeVerbose(make, BRIDGE_TIMEOUT_MS, false);
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
 * `notifyAppReady()` 失手之后，隔多久再试一次（毫秒）。四次机会，最后一次在
 * 启动后 43 秒左右。
 *
 * 这几个数是照着真机日志挑的：那次启动里插件的信号量**等满了 20 秒**才放开
 * （`Semaphore wait timed out after 20000ms`），而 `checkAppReady` 的回滚倒计时
 * 也是十几秒级。所以重试必须跨过那个二十秒的窗口，只隔一两秒地重试三次等于
 * 在同一堵墙上撞三下。最后一次落在墙外，才有意义。
 */
const APP_READY_RETRY_MS = [3000, 10_000, 30_000];

/** 「我起来了」这一趟的结果，给诊断看。 */
export interface AppReadyLog {
  at: number;
  /** 试到第几次才有这个结果。 */
  attempts: number;
  outcome: string;
}

const APP_READY_KEY = 'ota.appReady';

let appReadyLog: AppReadyLog | null = null;

function writeAppReadyLog(entry: AppReadyLog): void {
  appReadyLog = entry;
  try {
    localStorage.setItem(APP_READY_KEY, JSON.stringify(entry));
  } catch (err) {
    lastWriteError = errMessage(err);
  }
}

/** 上一次「我起来了」的结果。内存优先，理由同 `readLastCheckLog()`。 */
export function readAppReadyLog(): AppReadyLog | null {
  if (appReadyLog) return appReadyLog;
  try {
    const raw = localStorage.getItem(APP_READY_KEY);
    return raw ? (JSON.parse(raw) as AppReadyLog) : null;
  } catch {
    return null;
  }
}

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

/**
 * 这个会话里最新的那一份记录，**在内存里**。
 *
 * 为什么不能只有 localStorage 那一份（变更 59）：2026-09-23 那份真机诊断里，
 * 「上次查更新」停在第一步，而当时有两种完全不同的成因能长成这个样子 ——
 * 真的卡在那一步，或者**后面几步写不进 localStorage**（`writeCheckLog` 的 catch
 * 是哑的，写失败和没走到这一步在文件里一模一样）。分不清这两种，就等于这份诊断
 * 在最关键的那个问题上不可信。内存这一份不依赖任何存储，本次会话内它就是真相；
 * 存储那一份只负责跨会话。两份都在，`lastWriteError` 把差异说出来。
 */
let liveCheckLog: CheckLogEntry | null = null;

/** 最后一次写 localStorage 失败的原因；一直没失败过是 `null`。 */
let lastWriteError: string | null = null;

function writeCheckLog(entry: CheckLogEntry): void {
  liveCheckLog = entry;
  try {
    localStorage.setItem(CHECK_LOG_KEY, JSON.stringify(entry));
  } catch (err) {
    // 存不下就少一份跨会话的诊断，不影响更新本身 —— 但**要留下痕迹**，见 liveCheckLog。
    lastWriteError = errMessage(err);
  }
}

/** localStorage 写失败过没有。诊断报告要带上 —— 见 `liveCheckLog`。 */
export function readStorageWriteError(): string | null {
  return lastWriteError;
}

/**
 * **每一步都立刻落盘**的日志笔（变更 57）。
 *
 * ── 为什么不能等到最后一起写 ──
 * 原来这份记录只在 `checkNativeUpdate()` 的 `finally` 里写一次。那对「跑完了但结果不对」
 * 是够的，对**「根本跑不完」**却完全无效：函数不返回，`finally` 就不执行，一个字都不留。
 * 2026-09-23 真机上正是这样——按钮一直显示「查询中」，而设置页里连「上次查更新」那一块
 * 都不存在。于是最该被记下来的那种故障，恰恰是唯一不会留下记录的那种。
 *
 * 现在：进门先写一笔「开始了」，之后每一步 append 并立刻覆盖写。卡在哪一步，
 * 下次打开设置页就直接看得见——**日志停在哪儿，就是卡在哪儿**。
 *
 * 代价是每一步一次 `localStorage.setItem`，一次查更新统共七八次，可以忽略。
 */
function startCheckLog() {
  const at = Date.now();
  const steps: string[] = [];
  const probe = probePlugins();
  // 这句话会一直留在那里，直到某一步把它换掉。**留着就是答案**：看到它，
  // 就说明这一趟从来没有走到结束。
  let outcome = '（开始了，但没有走到结束——卡在下面最后那一步上）';
  const flush = (): void => writeCheckLog({ at, steps, outcome, probe });
  flush();
  return {
    steps,
    step(s: string): void {
      steps.push(s);
      flush();
    },
    finish(text: string): void {
      outcome = text;
      flush();
    },
  };
}

/**
 * 上一次 `checkNativeUpdate()` 跑下来的记录；从没跑过时是 `null`。给设置页和诊断用。
 *
 * **本次会话有记录就用内存里那一份**（见 `liveCheckLog`）：它不经过任何存储，
 * 写不进 localStorage 也照样是完整的。只有跨会话（这次还没查过）才回去读存储。
 */
export function readLastCheckLog(): CheckLogEntry | null {
  if (liveCheckLog) return liveCheckLog;
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
 *
 * ── 为什么它现在会重试，而且要留记录（变更 59）──
 * 2026-09-23 那份真机诊断里，这一趟**整个没有发生**：原生日志里没有那句
 * 「notifyAppReady was called」，只有回滚检查自己的定时器打出来的「Built-in bundle
 * is active. We skip the check for notifyAppReady.」。也就是说它在启动最忙的那二十秒里
 * 拿不到插件，然后就**永远地放弃了** —— 一次机会，失手即止，而且一个字都不留。
 *
 * 那次侥幸没事，因为当时跑的是随包那份 bundle（`isBuiltin()` 的分支直接跳过回滚检查）。
 * 但热更一旦真的装上一个 bundle，同一个失手就是：新版起来了 → 没人说「我起来了」→
 * 下次启动原生侧判定它起不来 → **回滚**。症状是「更新下下来了，可是永远不生效」，
 * 而这正是这台手机从 0.4.0 起一直在表现的症状之一。所以这一步必须是
 * 「**一直试到成功**」，不是「试一次算了」—— 它是整条热更链上唯一没有下一次机会的一步。
 */
export async function notifyNativeAppReady(): Promise<void> {
  if ((await nativePlatform()) !== 'ios') return;
  for (let attempt = 1; attempt <= APP_READY_RETRY_MS.length + 1; attempt++) {
    const { plugin, via } = await acquireUpdater();
    if (!plugin) {
      // 插件没装（比如还没出带热更的壳）也走这里 —— 但那种情况下重试几次的代价是零，
      // 而分辨「没装」和「这次没拿到」需要的正是下面那份记录。
      writeAppReadyLog({ at: Date.now(), attempts: attempt, outcome: `拿不到插件（${via}）` });
    } else {
      const r = await askBridgeVerbose(() => plugin.notifyAppReady());
      writeAppReadyLog({
        at: Date.now(),
        attempts: attempt,
        outcome: r.ok ? `ok(${r.ms}ms, via ${via})` : `${r.reason}(${r.ms}ms, via ${via})${r.message ? ` ${r.message}` : ''}`,
      });
      // **只重试「没人回话」这一种。** 原生侧真的报了错（rejected）意味着它收到了、
      // 也执行了 —— 比如旧壳里压根没有这个插件（`UNIMPLEMENTED`）。那种情况再试四次
      // 只是把同一句错话再听四遍，而每一次都要等满一个超时窗口。
      if (r.ok || r.reason === 'rejected') return;
    }
    const wait = APP_READY_RETRY_MS[attempt - 1];
    if (wait === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
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
  // **进门第一件事就是落一笔。** 这一行之后无论卡在哪里，设置页都看得见「开始了、
  // 走到了第几步」——见 `startCheckLog()`。在这之前不能有任何 `await`：2026-09-23
  // 真机上「连『上次查更新』那一块都不存在」正是因为原来第一个 `await` 就在这上面。
  const log = startCheckLog();

  // `nativePlatform()` 只是一次动态 import，不过桥——但它照样是个 `await`，
  // 而这一整条路上「某个 await 永不 settle」已经发生过三次了，所以它也要留脚印。
  const platform = await nativePlatform();
  log.step(`platform:${platform}`);
  if (platform !== 'ios') {
    log.finish('不是 iOS 壳，热更这条路本来就不走');
    return null;
  }

  let outcome: UpdateDecision | null = null;
  let outcomeText = '（异常中断）';
  try {
    // 拿插件。**这一步自己带死线**（见 acquireUpdater）—— 2026-09-23 那次真机
    // 就是停在这里，而当时它是这条路上唯一一个没有死线的 await。
    const { plugin: CapacitorUpdater, via } = await acquireUpdater();
    log.step(`plugin:${via}`);
    if (!CapacitorUpdater) {
      outcome = { action: 'skip', reason: `拿不到更新器插件（${via}）——这次不查了，下次再试` };
      outcomeText = outcome.reason;
      return outcome;
    }

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
        log.step(`fetch:threw:${errMessage(err)}`);
        throw err;
      })
      .finally(() => clearTimeout(fetchTimer));
    if (!res.ok) {
      log.step(`fetch:http-${res.status}`);
      outcome = { action: 'skip', reason: `manifest ${res.status}` };
      outcomeText = outcome.reason;
      return outcome;
    }
    log.step('fetch:ok');
    const manifest = (await res.json()) as OtaManifest;

    const [current, info] = await Promise.all([
      askBridgeVerbose(() => CapacitorUpdater.current()),
      askBridgeVerbose(async () => (await import('@capacitor/app')).App.getInfo()),
    ]);
    log.step(step('current', current));
    log.step(step('getInfo', info));

    const decision = decideUpdate(manifest, {
      // `?.` 一路到底：原生侧回的是什么形状不由我们说了算，而一个 `undefined.version`
      // 在这里会把整趟查更新变成「异常」，等于**桥回话了反而更糟**。
      currentVersion: current.ok ? (current.value?.bundle?.version ?? BUILTIN) : undefined,
      nativeVersion: info.ok ? info.value.version : undefined,
      queuedBuildId: readQueuedBuildId(),
    });
    log.step(`decide:${decision.action}`);
    if (decision.action === 'skip') {
      outcome = decision;
      outcomeText = decision.reason;
      return outcome;
    }

    const downloaded = await askBridgeVerbose(
      () => CapacitorUpdater.download({ url: decision.url, version: decision.version }),
      DOWNLOAD_TIMEOUT_MS,
    );
    log.step(step('download', downloaded));
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
    log.step(step('next', registered));
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
    // 每一步其实都已经写过了；这里只是把结论补上去。**走不到这里也没关系** ——
    // 那正是改成逐步落盘要解决的情况，日志会停在最后一步并保留「没有走到结束」那句话。
    log.finish(outcomeText);
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
    // 同上：`current` 有、但里面没有 `bundle` 时也该报 builtin，而不是抛出去 ——
    // 这条路的返回值直接喂给 `void runningBuild().then(setBuild)`，抛了就是
    // 一个没人接的 rejection，设置页永远停在「正在问原生侧版本号…」。
    bundle: current ? (current.bundle?.version ?? BUILTIN) : undefined,
    queued: readQueuedBuildId(),
  };
}
