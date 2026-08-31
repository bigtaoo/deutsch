// Capacitor 原生壳的适配层（SPEC §7.10）。**这是全项目唯一知道「自己可能不在浏览器里」
// 的地方** —— 业务代码一律不判平台，需要平台差异的两件事（存文件、返回键）从这里拿。
//
// ── 为什么连 @capacitor/core 都是动态 import ──
// 静态 import 会把 core 拽进首屏包：实测主包 498.0KB → 508.7KB，而线上 web 版
// 永远不会走进这里的任何一个分支。好在**没有一处真的需要同步知道平台** ——
// `initNativeShell` 内部本来就是异步的，`downloadJson` 也是 async。所以平台判定做成
// 一个带缓存的 async 函数，core 与四个插件一起留在按需加载的 chunk 里（→ 501.5KB，
// 剩下的 3.5KB 是 Vite 的 preload helper 加这个文件本身）。
// 不改成读 `window.Capacitor` 全局：那个全局确实由原生桥在 document start 注入，
// 但一旦哪个版本改了注入时机，失败方式是**静默的** —— `a[download]` 不下载、
// 返回键直接退出应用，而不是报错。为省 8KB 换一个静默失败面，不值。

export type NativePlatform = 'ios' | 'android' | 'web';

let platformPromise: Promise<NativePlatform> | null = null;

/** 当前平台。`'web'` 同时覆盖浏览器和「添加到主屏幕」的 PWA —— 两者都不是原生壳。 */
export function nativePlatform(): Promise<NativePlatform> {
  platformPromise ??= (async () => {
    try {
      const { Capacitor } = await import('@capacitor/core');
      if (!Capacitor.isNativePlatform()) return 'web';
      const p = Capacitor.getPlatform();
      return p === 'ios' || p === 'android' ? p : 'web';
    } catch {
      return 'web';
    }
  })();
  return platformPromise;
}

/** 真的跑在 iOS/Android 的 WebView 里。 */
export async function isNativeShell(): Promise<boolean> {
  return (await nativePlatform()) !== 'web';
}

let splashHidden = false;

/**
 * 关掉启动图。幂等 —— App.tsx 在四张表读完后调一次，initNativeShell 还挂了个
 * 兜底定时器，因为「某张表读挂了」不该让用户对着启动图干等。
 */
export async function hideNativeSplash(): Promise<void> {
  if (splashHidden || !(await isNativeShell())) return;
  splashHidden = true;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch {
    // 插件没装或原生端没起来 —— 启动图最坏就是自己不消失。不值得为它炸掉启动。
  }
}

export interface NativeShellHooks {
  /** 应用从后台回到前台。手机上这比「网络恢复」更常见，用来补推备份队列。 */
  onResume?: () => void;
}

/**
 * 原生壳的一次性初始化。在浏览器里是空操作，所以 main.tsx 可以无条件调。
 */
export function initNativeShell(hooks: NativeShellHooks = {}): void {
  void (async () => {
    const platform = await nativePlatform();
    if (platform === 'web') return;

    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      // Style.Light = 浅色背景下的深色文字。应用主体是白底（导航 bg-white），
      // 给 Dark 会让状态栏文字变白、在白底上看不见。
      await StatusBar.setStyle({ style: Style.Light });
      if (platform === 'android') {
        // Android 上让状态栏**不要**覆盖 WebView：Capacitor 的 Android 壳不会把
        // 系统 inset 喂给 CSS 的 env(safe-area-inset-top)，覆盖了就只能靠写死 24dp
        // 去躲，而那个值各机型不一样。iOS 不需要这一步 —— WKWebView 原生就给 env()。
        await StatusBar.setOverlaysWebView({ overlay: false });
        await StatusBar.setBackgroundColor({ color: '#ffffff' });
      }
    } catch {
      // 状态栏是纯观感，失败不影响任何功能。
    }

    try {
      const { App } = await import('@capacitor/app');

      if (platform === 'android') {
        // 硬件返回键。hash 路由的每次跳转都进了 history，所以 canGoBack 时退一格
        // 就是「回上一页」；到根了再按才退出应用 —— 默认行为是**任何一次按下都直接
        // 退出应用**，在跟读页误触一下就等于把整个循环关掉。
        await App.addListener('backButton', ({ canGoBack }) => {
          if (canGoBack) window.history.back();
          else void App.exitApp();
        });
      }

      const { onResume } = hooks;
      if (onResume) await App.addListener('resume', () => onResume());
    } catch {
      // 同上：拿不到 App 插件时退化成「没有返回键接管、没有 resume 钩子」，
      // 而不是让整个初始化抛出去。
    }

    // 兜底：五秒之后无论 React 那边发生了什么都把启动图关掉。
    setTimeout(() => void hideNativeSplash(), 5000);
  })();
}
