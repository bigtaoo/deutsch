// FR-18.7：这个应用开着的时候，别让屏幕自己灭掉。
//
// ── 为什么是需求，不是锦上添花 ──
// iOS 默认 30 秒到 2 分钟自动锁屏，而这个应用的主场景恰恰是**一句话都不碰屏幕**：
// 通听一课十分钟只有耳朵在动，跟读循环三遍之间也没有任何触摸。于是练到一半黑屏、
// 想看一眼原文还要先解锁 —— 而在 iOS 上锁屏还会把 `<audio>` 一起停掉。
//
// ── 范围：整个应用，不只是练习界面（2026-09-22 改）──
// 第一版的判据是 `isPracticeRoute`（和学习计时共用那五个界面），理由是「代价有界」。
// 用户的原话把它推翻了：「常亮改为整个 app 吧，只要我 app 处于打开状态，就常亮」。
// 他是对的，而且理由比省电重要：**边界本身就是个 bug 面**。
// 在生词本里读一段 AI 写回来的辨析、在查词面板上看变形表、贴一篇译文 ——
// 这些都是「盯着屏幕但不碰屏幕」，而它们一个都不在那五个界面里。
// 一条「有时候亮有时候不亮」的规则，比不亮更让人不信任。
//
// 代价是明确的、而且**自带上界**：页面一不可见（切走、锁屏、接电话）系统就收回这把锁，
// 所以「放在桌上忘了关」最多亮到手机自己被按灭那一下为止。
//
// ── 锁必须能被重新拿回来 ──
// Screen Wake Lock 规范规定：页面一不可见，浏览器就**自动释放**这把锁，
// 而且回到前台**不会**自己还给你。所以这里监听 visibilitychange，回前台时再申请一次。
// 少了这一步的表现是「切出去回来一次之后，常亮就永远失效了」——
// 一个只在特定路径上复现的静默失效。
//
// ── 不给开关 ──
// 页面一不可见就自动释放，代价有上界；而一个「要不要让屏幕在我用这个应用时保持亮着」
// 的开关，没有人有信息去回答它。真要关，把手机的自动锁屏调回来就是 ——
// 那本来就是系统给的那个开关。

interface Sentinel {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
}

interface WakeLockNavigator {
  wakeLock?: { request: (type: 'screen') => Promise<Sentinel> };
}

let sentinel: Sentinel | null = null;
/** 现在「应该」亮着吗。释放之后重新申请要靠它，所以它比 sentinel 活得长。 */
let wanted = false;
let requesting = false;

/**
 * 最近一次申请的结果，以及它发生在多久以前。
 *
 * **为什么非记不可**：申请是在应用挂载那一刻发生的，而人是过一会儿才走到设置页去看
 * 那一行。这中间可能切过后台（系统收走锁、回来再申请），也可能一开始就被拒了。
 * 只报「此刻有没有拿着」说不清「刚才那次到底成没成」，而那才是要诊断的东西。
 */
let lastResult: 'ok' | 'rejected' | null = null;
let lastAt = 0;

function api(): WakeLockNavigator['wakeLock'] | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as unknown as WakeLockNavigator).wakeLock;
}

/** 这台设备支不支持。给设置页的诊断行用 —— 不支持时那里要如实说，而不是装作开着。 */
export function wakeLockSupported(): boolean {
  return Boolean(api());
}

/**
 * 现在到底什么状况。设置页的诊断行读它。
 *
 * **三个字段缺一不可**，因为「屏幕没保持亮」有三种完全不同的成因，而它们要
 * 三个不同的下一步：`supported=false` → 这台 WebView 根本没有这个 API，
 * 只能去原生侧动 `isIdleTimerDisabled`（要出新包）；`wanted=false` → 应用没在跑
 * （正常情况下不该看到）；`wanted && !held` → API 在，但申请被拒了
 * （省电模式、权限策略）。少任何一个，这一行就只能告诉你「坏了」。
 */
export interface WakeLockState {
  supported: boolean;
  wanted: boolean;
  held: boolean;
  /** 最近一次申请的结果；`null` = 从来没试过（没进过练习界面）。 */
  lastResult: 'ok' | 'rejected' | null;
  /** 距最近一次申请过了多少毫秒；没试过时是 0。 */
  lastAgoMs: number;
}

export function wakeLockState(): WakeLockState {
  return {
    supported: wakeLockSupported(),
    wanted,
    held: Boolean(sentinel),
    lastResult,
    lastAgoMs: lastAt ? Date.now() - lastAt : 0,
  };
}

async function acquire(): Promise<void> {
  const wakeLock = api();
  // 页面不可见时申请一定会被拒（规范如此），等回到前台那一次再说。
  if (!wakeLock || sentinel || requesting || !wanted) return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  requesting = true;
  try {
    const next = await wakeLock.request('screen');
    lastResult = 'ok';
    lastAt = Date.now();
    // 等这一趟回来的时候可能已经不想要了（切出了练习界面）——那就立刻还回去。
    if (!wanted) {
      void next.release().catch(() => {});
    } else {
      sentinel = next;
      next.addEventListener('release', () => {
        if (sentinel === next) sentinel = null;
      });
    }
  } catch {
    // 省电模式、权限策略、或者这一版 WebView 不认 —— 屏幕照旧会灭，仅此而已。
    // 但要记一笔：这一档和「这台设备根本没有这个 API」要分得开，
    // 而它们的下一步完全不同（见 wakeLockState 的注释）。
    lastResult = 'rejected';
    lastAt = Date.now();
  } finally {
    requesting = false;
  }
}

function releaseNow(): void {
  const current = sentinel;
  sentinel = null;
  if (current && !current.released) void current.release().catch(() => {});
}

/**
 * 这个应用现在开着吗。由 App.tsx 在挂载时设成 true、卸载时设成 false ——
 * **不跟路由走**（见文件头「范围」那一段）。
 */
export function setKeepAwake(active: boolean): void {
  wanted = active;
  // **不做 `wanted === active` 就提前返回。** 那样写的话，第一次申请失败之后
  // （页面还没可见、系统临时拒绝）这一次会话里就再也没有第二次机会。
  // `acquire()` 自己是幂等的（已经拿着锁、或正在申请，都会立刻返回），多调没有代价。
  // 真正的重试点是 visibilitychange（切出去再回来）。
  if (active) void acquire();
  else releaseNow();
}

/**
 * 挂上「回到前台就把锁拿回来」。App.tsx 启动时调一次，返回值用于卸载。
 */
export function attachWakeLockListener(): () => void {
  if (typeof document === 'undefined') return () => {};
  const onVisible = () => {
    if (document.visibilityState === 'visible') void acquire();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}

/** 只给测试用。 */
export function resetWakeLockForTests(): void {
  sentinel = null;
  wanted = false;
  requesting = false;
  lastResult = null;
  lastAt = 0;
}
