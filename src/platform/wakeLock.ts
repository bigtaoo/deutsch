// FR-18.5：练习时别让屏幕自己灭掉。
//
// ── 为什么是需求，不是锦上添花 ──
// iOS 默认 30 秒到 2 分钟自动锁屏，而这个应用的主场景恰恰是**一句话都不碰屏幕**：
// 通听一课十分钟只有耳朵在动，跟读循环三遍之间也没有任何触摸。于是练到一半黑屏、
// 想看一眼原文还要先解锁 —— 而在 iOS 上锁屏还会把 `<audio>` 一起停掉。
//
// ── 判据跟计时器同一条 ──
// 「在练」= `isPracticeRoute`（study/surface.ts）那五个界面。刻意不写第二份名单：
// 一个「什么时候算在学习」的问题有两个答案，迟早会漂成两个。翻生词本、看设置页、
// 挑课不亮屏 —— 它们本来就是用手在操作的页面，系统自己的超时是对的。
//
// ── 锁必须能被重新拿回来 ──
// Screen Wake Lock 规范规定：页面一不可见（切到别的 App、手动锁屏、接个电话），
// 浏览器就**自动释放**这把锁，而且回到前台**不会**自己还给你。所以这里监听
// visibilitychange，回前台时若仍在练习界面就再申请一次。少了这一步的表现是
// 「切出去回来一次之后，常亮就永远失效了」—— 一个只在特定路径上复现的静默失效。
//
// ── 不给开关 ──
// 它只在那五个界面上生效，页面一不可见就自动释放，代价是有界的；
// 而一个「要不要让屏幕在我练习时保持亮着」的开关，没有人有信息去回答它。
// 真要关，把手机的自动锁屏调回来就是 —— 那本来就是系统给的那个开关。

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

function api(): WakeLockNavigator['wakeLock'] | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as unknown as WakeLockNavigator).wakeLock;
}

/** 这台设备支不支持。给设置页的诊断行用 —— 不支持时那里要如实说，而不是装作开着。 */
export function wakeLockSupported(): boolean {
  return Boolean(api());
}

async function acquire(): Promise<void> {
  const wakeLock = api();
  // 页面不可见时申请一定会被拒（规范如此），等回到前台那一次再说。
  if (!wakeLock || sentinel || requesting || !wanted) return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  requesting = true;
  try {
    const next = await wakeLock.request('screen');
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
 * 现在在不在练习界面上。由 App.tsx 跟着路由调，和 `studyClock.setActive` 并排。
 */
export function setKeepAwake(active: boolean): void {
  if (wanted === active) return;
  wanted = active;
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
}
