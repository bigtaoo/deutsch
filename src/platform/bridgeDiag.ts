// 原生桥自检与诊断上报（变更 56）。
//
// ── 这一块要回答的问题 ──
// 「热更不动、版本号问不出来」这句话下面藏着至少四种完全不同的故障，而它们的下一步
// 互不相同：
//   ① 插件类根本没注册 → `probePlugins()` 已经能分辨（变更 52），要动 Swift；
//   ② 整个插件的**每一个**方法都不回话 → 插件实例造不出来，要换插件或换方案；
//   ③ 只有头一次调用慢（插件 `load()` 在主线程做一大堆磁盘活 + 发统计 + 切
//      serverBasePath）→ 纯粹是我们等得不够，放宽超时就好（见 nativeUpdate.ts 的
//      `COLD_BRIDGE_TIMEOUT_MS`）；
//   ④ 某个具体方法坏了（比如 `download` 撞上网络策略）→ 只修那一条路。
// 分辨它们只需要一件事：**把插件的一组只读方法逐个调一遍，各自计时、各自超时**。
// 全哑是 ②，第一个慢、后面都快是 ③，个别哑是 ④。这件事在这台设备上做一次，
// 比在 Windows 上猜十次都管用。
//
// ── 为什么连 console 都要抄一份 ──
// 见 `consoleTap.ts`：Capgo 插件的**原生**日志是 `evaluateJavaScript("console.info(…)")`
// 打进 JS console 的，抄下 console 等于把 Xcode 控制台搬进应用。这个项目的开发机是
// Windows，从来没有过 Xcode 控制台可看 —— 这是唯一一条能看见 `load()` 内部的路。
//
// ── 为什么要能发到服务器 ──
// 诊断长这么一大坨，念给人听或者截七张图都不现实。同步后端本来就在那儿、本来就有
// 会话令牌，多一个 `POST /v1/diag` 的成本几乎是零，而收益是「手机上点一下，
// 我在 VPS 上直接读」。**但它不能是唯一的出口**：真出问题的时候登录本身也可能是坏的，
// 所以同一份报告也能复制到剪贴板（`reportToText`），两条路各自独立。

import { nativePlatform, type NativePlatform } from './native';
import {
  askBridgeVerbose,
  probePlugins,
  readLastCheckLog,
  runningBuild,
  type CheckLogEntry,
  type PluginProbe,
} from './nativeUpdate';
import { consoleLines, type ConsoleLine } from './consoleTap';
import { getSessionToken } from '@/sync/session';
import { syncFetch } from '@/sync/client';
import { isSyncConfigured } from '@/sync/config';

/** 逐个试一遍的那组方法。**必须全是只读的** —— 自检不该改变这台设备上的任何状态。 */
const READONLY_METHODS = [
  // 放第一个是刻意的：它是插件里最便宜的一个调用（直接回一个常量字符串），
  // 所以它的耗时**就是插件 `load()` 本身的耗时**，不掺任何别的东西。
  'getPluginVersion',
  'getBuiltinVersion',
  'getDeviceId',
  'isAutoUpdateEnabled',
  'current',
  'getNextBundle',
  'list',
] as const;

export type UpdaterMethod = (typeof READONLY_METHODS)[number];

/** 一个方法试下来的结果。 */
export interface MethodOutcome {
  /** 方法名；对照组是 `App.getInfo`。 */
  method: string;
  outcome: 'ok' | 'timeout' | 'rejected' | 'threw';
  /** 等了多久（毫秒）。**这是整份自检最有用的一个数**。 */
  ms: number;
  /** 失败时原生侧说了什么；成功时是结果的一句话摘要。 */
  detail?: string;
}

/** 自检里每个方法**单独**等多久。头一个由 `askBridgeVerbose` 的冷启动规则自动放宽。 */
const SELF_TEST_TIMEOUT_MS = 6000;

/** 把一个结果压成一行能看的摘要 —— 整个对象塞进报告没必要，也可能很大。 */
function summarize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 300 ? text.slice(0, 300) + '…' : text;
  } catch {
    return '（无法序列化的返回值）';
  }
}

/**
 * 把 `CapacitorUpdater` 的一组只读方法逐个调一遍。**串行，不并行** ——
 * 并行会让「第一个调用触发 `load()`」这件事被后面的调用分摊掉，
 * 而分辨故障 ③ 靠的正是「第一个特别慢、后面都快」这个形状。
 *
 * 浏览器里返回空数组（那边没有桥可自检）。
 */
export async function runUpdaterSelfTest(): Promise<MethodOutcome[]> {
  if ((await nativePlatform()) === 'web') return [];
  const results: MethodOutcome[] = [];

  let plugin: Record<string, unknown>;
  try {
    const mod = await import('@capgo/capacitor-updater');
    plugin = mod.CapacitorUpdater as unknown as Record<string, unknown>;
  } catch (err) {
    return [
      {
        method: 'import(@capgo/capacitor-updater)',
        outcome: 'threw',
        ms: 0,
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  for (const name of READONLY_METHODS) {
    const fn = plugin[name];
    if (typeof fn !== 'function') {
      results.push({ method: name, outcome: 'threw', ms: 0, detail: 'JS 侧没有这个方法' });
      continue;
    }
    const r = await askBridgeVerbose(
      () => (fn as (this: unknown) => Promise<unknown>).call(plugin),
      SELF_TEST_TIMEOUT_MS,
    );
    results.push(
      r.ok
        ? { method: name, outcome: 'ok', ms: r.ms, detail: summarize(r.value) }
        : { method: name, outcome: r.reason, ms: r.ms, detail: r.message },
    );
  }

  // 对照组：另一个插件的一个同样便宜的调用。**没有它就分不清「桥整个坏了」和
  // 「只有更新器坏了」** —— 变更 52 那次真机结论（getInfo 好、current 哑）正是
  // 靠这个对比才成立的。
  const info = await askBridgeVerbose(
    async () => (await import('@capacitor/app')).App.getInfo(),
    SELF_TEST_TIMEOUT_MS,
  );
  results.push(
    info.ok
      ? { method: 'App.getInfo', outcome: 'ok', ms: info.ms, detail: summarize(info.value) }
      : { method: 'App.getInfo', outcome: info.reason, ms: info.ms, detail: info.message },
  );

  return results;
}

/** 上报时最多带多少行 console。整份报告控制在几百 KB 以内。 */
const MAX_REPORT_LINES = 300;

/** 一份完整的设备诊断。服务器上原样存一个 JSON 文件。 */
export interface DeviceReport {
  at: number;
  /** 报告格式版本 —— 以后改了形状，服务器上那堆旧文件还认得出来是哪一代。 */
  schema: 1;
  platform: NativePlatform;
  userAgent: string;
  screen: string;
  /** 原生壳版本 / 当前 bundle / 已登记待生效的 buildId。任何一个都可能问不出来。 */
  native?: string;
  bundle?: string;
  queued?: string;
  probe: PluginProbe;
  selfTest: MethodOutcome[];
  lastCheck: CheckLogEntry | null;
  console: ConsoleLine[];
}

/**
 * 收一份报告。`selfTest` 由调用方传进来（跑一次要好几秒，不该藏在这个函数里偷偷发生）。
 */
export async function collectDeviceReport(selfTest: MethodOutcome[]): Promise<DeviceReport> {
  const build = await runningBuild();
  return {
    at: Date.now(),
    schema: 1,
    platform: await nativePlatform(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    screen: typeof window === 'undefined' ? '' : `${window.screen?.width}×${window.screen?.height}`,
    native: build?.native,
    bundle: build?.bundle,
    queued: build?.queued,
    probe: probePlugins(),
    selfTest,
    lastCheck: readLastCheckLog(),
    console: consoleLines().slice(-MAX_REPORT_LINES),
  };
}

/**
 * 发到同步后端。**要求已登录** —— 服务器上除了 healthz 之外全都要会话令牌，
 * 而给诊断开一个匿名入口等于给公网开一个免鉴权写盘接口，不值得。
 * 没登录 / 没配同步时抛错，界面退回「复制诊断」那条路（它不依赖网络）。
 */
export async function sendDeviceReport(report: DeviceReport): Promise<{ id: string }> {
  if (!isSyncConfigured()) throw new Error('这个构建没有配同步后端，只能用「复制诊断」');
  const token = await getSessionToken();
  if (!token) throw new Error('还没登录 —— 先去上面登录，或者用「复制诊断」');
  return syncFetch<{ id: string }>('/v1/diag', { method: 'POST', body: report, token });
}

/**
 * 同一份报告的纯文本形式，给「复制诊断」用。
 *
 * **不是 JSON.stringify** ：这条路的终点是聊天窗口，要的是人能扫一眼就看懂的东西。
 * 自检那几行按「方法 → 结果(耗时)」排开，一眼就能看出是全哑、头一个慢、还是个别坏。
 */
export function reportToText(report: DeviceReport): string {
  const lines: string[] = [];
  lines.push(`时间 ${new Date(report.at).toLocaleString()}`);
  lines.push(`平台 ${report.platform} · 屏幕 ${report.screen}`);
  lines.push(`应用壳 ${report.native ?? '问不出来'} · 前端 ${report.bundle ?? '问不出来'} · 待生效 ${report.queued ?? '无'}`);
  lines.push(
    `插件注册 ${report.probe.registered.length} 个：${report.probe.registered.join('、') || '（空）'}`,
  );
  lines.push(`CapacitorUpdater 注册：${report.probe.updaterRegistered ? '是' : '否'}`);
  lines.push('');
  lines.push('桥自检：');
  for (const r of report.selfTest) lines.push(`  ${r.method} → ${r.outcome} (${r.ms}ms)${r.detail ? ` ${r.detail}` : ''}`);
  lines.push('');
  if (report.lastCheck) {
    lines.push(`上次查更新：${report.lastCheck.outcome}`);
    lines.push(`  步骤：${report.lastCheck.steps.join(' → ') || '（没走到任何一步）'}`);
    lines.push('');
  }
  lines.push(`原生日志（最近 ${report.console.length} 行）：`);
  for (const l of report.console) lines.push(`  [${l.level}] ${l.text}`);
  return lines.join('\n');
}
