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
 * 热更只换 JS，换不了原生代码（align-native 那个 Swift ONNX 插件、AppDelegate 的音频
 * 会话、Capacitor 插件本身）。一旦哪次前端改动开始调用新加的原生方法，推给旧壳就是
 * 「点了没反应」或直接崩 —— 而崩了至少还有 notifyAppReady 的回滚兜着，没反应连兜底都没有。
 * 所以每个包自报它要求的最低壳版本，够不着就不下。
 */
export function decideUpdate(
  manifest: OtaManifest,
  currentVersion: string,
  nativeVersion: string,
): UpdateDecision {
  if (!manifest.buildId || !manifest.url) {
    return { action: 'skip', reason: 'manifest 缺 buildId 或 url' };
  }
  if (!versionAtLeast(nativeVersion, manifest.minNative)) {
    return {
      action: 'skip',
      reason: `这个包要求原生壳 ≥ ${manifest.minNative}，当前 ${nativeVersion} —— 要去 TestFlight 装新壳`,
    };
  }
  // 内置 bundle 的 version 是 'builtin'，永远不等于 manifest.version，所以第一次
  // 启动就会下。这是对的：IPA 出包那一刻之后 main 上的改动全都在这个包里。
  if (currentVersion === manifest.version) {
    return { action: 'skip', reason: '已经是最新' };
  }
  return { action: 'download', version: manifest.version, url: manifest.url };
}

/** 插件是懒加载的 —— 和 native.ts 里其它插件一样，别把它拽进首屏包。 */
async function updater() {
  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
  return CapacitorUpdater;
}

/**
 * 告诉原生侧「这一版真的起来了」，取消回滚倒计时。
 *
 * 幂等，浏览器里是空操作。**必须调** —— 不调的话下次启动会退回上一个 bundle，
 * 而那看起来就是「热更根本没生效」。
 */
export async function notifyNativeAppReady(): Promise<void> {
  if ((await nativePlatform()) !== 'ios') return;
  try {
    await (await updater()).notifyAppReady();
  } catch {
    // 插件没装（比如还没出带热更的壳）就什么也不做。旧壳照常跑它自己那份 dist。
  }
}

/**
 * 查一次更新，有就下载并登记为「下次启动用」。
 *
 * 失败一律吞掉：热更拿不到新版是**退化不是故障**，手上这份照样能用，而弹一个
 * 「更新失败」除了打断练习什么也做不了。真要查就去设置页看当前 bundle（§12.12）。
 */
export async function checkNativeUpdate(): Promise<UpdateDecision | null> {
  if ((await nativePlatform()) !== 'ios') return null;
  try {
    const CapacitorUpdater = await updater();
    const { App } = await import('@capacitor/app');

    // cache: 'no-store' —— WKWebView 会缓存这个 JSON，缓存住了就等于热更停摆，
    // 而症状是「部署了但手机不更新」，和没接热更一模一样。
    const res = await fetch(`${OTA_BASE}/ota/manifest.json`, { cache: 'no-store' });
    if (!res.ok) return { action: 'skip', reason: `manifest ${res.status}` };
    const manifest = (await res.json()) as OtaManifest;

    const [current, info] = await Promise.all([CapacitorUpdater.current(), App.getInfo()]);
    const decision = decideUpdate(manifest, current.bundle.version ?? BUILTIN, info.version);
    if (decision.action === 'skip') return decision;

    const bundle = await CapacitorUpdater.download({
      url: decision.url,
      version: decision.version,
    });
    // next 而不是 set：只登记，不重载。见文件顶部「更新时机」。
    await CapacitorUpdater.next({ id: bundle.id });
    pending = decision.version;
    return decision;
  } catch {
    return null;
  }
}

/** 这次会话里下好、等着下次启动生效的版本。给设置页用（§12.12）。 */
let pending: string | null = null;

/** @see pending */
export function pendingUpdateVersion(): string | null {
  return pending;
}

export interface RunningBuild {
  /** 原生壳版本（IPA 的 MARKETING_VERSION）。换它必须过 App Store。 */
  native: string;
  /** 现在真正跑着的那份前端。内置是 `'builtin'`。 */
  bundle: string;
}

/**
 * 现在跑的是哪一版。浏览器里回 null —— 那边「哪一版」没有意义，
 * Service Worker 保证你看到的就是最新的（§7.6）。
 */
export async function runningBuild(): Promise<RunningBuild | null> {
  if ((await nativePlatform()) !== 'ios') return null;
  try {
    const CapacitorUpdater = await updater();
    const { App } = await import('@capacitor/app');
    const [current, info] = await Promise.all([CapacitorUpdater.current(), App.getInfo()]);
    return { native: info.version, bundle: current.bundle.version ?? BUILTIN };
  } catch {
    return null;
  }
}
