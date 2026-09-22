// iPhone 上顶部安全区的兜底（变更 46 / §12.15）。
//
// ── 症状 ──
// iPhone 13 的原生壳上，吸顶导航和系统状态栏（时间、信号、电量）**压在一起**。
// 而 `index.html` 里 `viewport-fit=cover` 在、`index.css` 里
// `.app-nav { padding-top: calc(0.5rem + env(safe-area-inset-top)) }` 也在 ——
// 也就是说，那条规则写对了，但 `env(safe-area-inset-top)` 在那台设备上解析成了 **0**。
//
// ── 为什么不去改 capacitor.config.ts 的 contentInset ──
// 最像的嫌疑是它：`contentInset: 'never'` 把 WKWebView 的
// `contentInsetAdjustmentBehavior` 设成 `.never`，而 WebKit 的 env(safe-area-inset-*)
// 取自同一套「未被遮挡区域」的计算。**但这只是嫌疑，没有在真机上验过**，
// 而另一个候选值 `'always'` 的失败方式更糟：系统再插一层 inset，和 CSS 的
// padding 叠起来，吸顶导航下面空出一条 —— 那是一个「看着像没坏」的坏法。
//
// 所以这里做的是一件**不需要知道成因**的事：把 env() 实测出来。
// 量到 0 就按屏幕尺寸补一个已知值，量到非 0 就什么都不做（`max()` 让兜底自动失效）。
// 实测值同时摆进设置页的诊断块 —— 下次在真机上看一眼那两个数，成因就定了。
//
// ── 为什么按屏幕尺寸查表 ──
// env() 坏掉之后，WebView 里没有第二个地方能问到真实的安全区高度。
// 屏幕的 CSS 尺寸是唯一还能信的东西，而它和机型一一对应。表里没有的机型退到
// 「长宽比 ≥ 2 就是有刘海/灵动岛」+ 一个保守的默认值。

/** 一次实测的结果。设置页的诊断块把它原样摆出来。 */
export interface SafeAreaProbe {
  /** `env(safe-area-inset-top)` 在这台设备上解析出来的像素数。 */
  top: number;
  bottom: number;
  /** 兜底真的生效了吗（= 量到 0 且判定这台设备该有安全区）。 */
  fallbackApplied: boolean;
  /** 兜底用的值，没生效时是 0。 */
  fallbackTop: number;
}

/**
 * 已知机型的顶部安全区（CSS px）。键是竖屏下的 `宽×高`。
 *
 * 一格都不要「顺手四舍五入」：补少了照旧压住状态栏，而这一整个文件就是为了这个。
 */
const KNOWN_TOP: Record<string, number> = {
  '375x812': 50, // X / XS / 11 Pro 是 44，12 mini / 13 mini 是 50 —— 同尺寸，取大的那个
  '414x896': 44, // XR / 11 / XS Max / 11 Pro Max
  '390x844': 47, // 12 / 12 Pro / 13 / 13 Pro / 14 ← 他手上这台
  '428x926': 47, // 12 Pro Max / 13 Pro Max / 14 Plus
  '393x852': 59, // 14 Pro / 15 / 15 Pro / 16（灵动岛）
  '430x932': 59, // 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus
  '402x874': 62, // 16 Pro
  '440x956': 62, // 16 Pro Max
};

/** 表里没有的刘海机用这个。取 47 而不是 59：宁可少补几像素，也不要在一台没有刘海的设备上凭空空出一条。 */
const DEFAULT_TOP = 47;
/** home indicator 那一条，所有全面屏 iPhone 都是 34。 */
const DEFAULT_BOTTOM = 34;

/**
 * 量一次 `env(safe-area-inset-*)`。
 *
 * 用 `padding` 而不是 `height`：`height: env(...)` 在值为 0 时元素会被折叠，
 * 而 `getComputedStyle().paddingTop` 无论如何都返回一个像素字符串。
 */
export function measureEnvInsets(): { top: number; bottom: number } {
  if (typeof document === 'undefined') return { top: 0, bottom: 0 };
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const top = Number.parseFloat(style.paddingTop) || 0;
  const bottom = Number.parseFloat(style.paddingBottom) || 0;
  probe.remove();
  return { top, bottom };
}

/**
 * 这台设备**应该**有多高的顶部安全区。查不到表就按长宽比猜。
 *
 * 纯函数，屏幕尺寸由调用方给 —— 测试里要能穷举机型，而 `screen` 是只读全局。
 */
export function expectedTopInset(screenWidth: number, screenHeight: number): number {
  const w = Math.round(Math.min(screenWidth, screenHeight));
  const h = Math.round(Math.max(screenWidth, screenHeight));
  const known = KNOWN_TOP[`${w}x${h}`];
  if (known !== undefined) return known;
  // 全面屏 iPhone 的长宽比全部 ≥ 2.16；SE（375×667）是 1.78，iPad 更方。
  // 判在 2.0 上：两边都留了足够的余量，不会把一台没有刘海的设备判进来。
  return h / w >= 2 ? DEFAULT_TOP : 0;
}

/**
 * 装上兜底。**只在原生 iOS 壳里做**：浏览器和 Android 上 env() 一直是对的，
 * 而在那里凭空加一条 47px 的白边是实打实的破坏。
 *
 * 幂等，返回实测结果供诊断块显示。
 */
export function applySafeAreaFallback(platform: 'ios' | 'android' | 'web'): SafeAreaProbe {
  const { top, bottom } = measureEnvInsets();
  const result: SafeAreaProbe = { top, bottom, fallbackApplied: false, fallbackTop: 0 };
  if (platform !== 'ios' || top > 0 || typeof document === 'undefined') return result;

  const expected = expectedTopInset(window.screen?.width ?? 0, window.screen?.height ?? 0);
  if (expected <= 0) return result;

  document.documentElement.style.setProperty('--safe-top-min', `${expected}px`);
  // 顶部坏了就当底部也坏了：它们来自同一个计算。量到底部非 0 时 `max()` 自己会选大的那个。
  document.documentElement.style.setProperty('--safe-bottom-min', `${DEFAULT_BOTTOM}px`);
  result.fallbackApplied = true;
  result.fallbackTop = expected;
  return result;
}

/** 最近一次实测。设置页的诊断块读它 —— 不自己再量一遍，免得两处数字对不上。 */
let lastProbe: SafeAreaProbe | null = null;

export function initSafeArea(platform: 'ios' | 'android' | 'web'): SafeAreaProbe {
  lastProbe = applySafeAreaFallback(platform);
  return lastProbe;
}

export function safeAreaProbe(): SafeAreaProbe | null {
  return lastProbe;
}
