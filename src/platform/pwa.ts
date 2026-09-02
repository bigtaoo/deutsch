// 应用壳的自动更新（SPEC §7.6）。
//
// ── 要修的症状 ──
// deploy 之后在浏览器里刷新，看到的仍然是旧版。原因不是没部署：§7.6 的
// `navigateFallback: '/index.html'` 让导航请求由 Service Worker 从预缓存直出，
// 所以那一次刷新拿到的是**旧** SW 手里的旧 index.html —— 新 sw.js 是在这一次加载的
// 后台才被取到、装好、`skipWaiting` 接管的，而页面早就渲染完了。于是要再刷一次
// 才吃到新壳，而「刷了没变」看起来跟「没部署成功」一模一样。
//
// ── 修法 ──
// 把注册从 vite-plugin-pwa 自动注入的那个 `registerSW.js` 换成虚拟模块
// `virtual:pwa-register`。那个注入的脚本只调 `navigator.serviceWorker.register`，
// 拿到更新之后什么也不做；虚拟模块在 `registerType: 'autoUpdate'` 下会监听新 SW 的
// `activated`，`isUpdate` 时自己 `location.reload()`。于是刷一次就够：这一次照旧是
// 旧壳，但新 SW 接管后页面立刻自己再刷一次，人看到的就是新版。
// 注入哪一个由插件按「有没有 import 这个虚拟模块」自动切（`injectRegister: 'auto'`），
// 所以 vite.config.ts 那边只需要一件事：原生模式下从「不加载这个插件」改成
// `disable: true`，否则虚拟模块没人解析、原生构建直接报错。
import { registerSW } from 'virtual:pwa-register';

/**
 * 每小时主动问一次服务器有没有新壳。
 *
 * 为什么不能只靠页面加载时那一次：装到主屏幕的 PWA 可以连着开好几天不重新加载
 * （§2.1 的用法就是碎片时间点开就用），那种用法下没有这个探测就永远等不到更新 ——
 * 而这恰好是「有更新就刷新」最需要生效的场景。
 */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** 光标正在某个可输入的地方 —— 此刻刷新会吞掉人刚打的字。 */
function isTyping(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/**
 * 刷新，但不在人打字的当口刷。
 *
 * 听写的答案只活在 React state 里（`DictationTab` 的 `answers`，没有落 IndexedDB），
 * 复习和跟读的当前进度同理 —— 打了半句被静默刷掉，比看到旧版更难接受。
 *
 * 只等到光标离开，不等更久：`skipWaiting` + `cleanupOutdatedCaches` 意味着新 SW 一激活，
 * 旧构建的预缓存就已经被删了。这个页面之后再去按需加载旧 chunk（词典分桶、对齐的
 * onnxruntime）会 404，所以「拖着不刷」不是安全的一侧，反而更糟。
 */
function reloadWhenNotTyping(): void {
  if (!isTyping()) {
    window.location.reload();
    return;
  }
  const onFocusOut = () => {
    // 推迟一轮再看：focusout 触发时焦点还没落定，此刻读 activeElement 可能是 body，
    // 也可能马上就要落到下一个输入框上（听写是一句里好几个空，Tab 过去还在打字）。
    setTimeout(() => {
      if (isTyping()) return;
      document.removeEventListener('focusout', onFocusOut);
      window.location.reload();
    }, 0);
  };
  document.addEventListener('focusout', onFocusOut);
}

/**
 * 注册 Service Worker，并让「有新版」自动变成「页面刷新」。
 *
 * 浏览器之外是空操作：原生壳的构建把插件 `disable` 掉了（理由见 vite.config.ts 顶部
 * 那段——原生壳没有「刷新」这回事），那种构建里 `registerSW` 是个空实现。
 */
export function initAppShellUpdates(): void {
  registerSW({
    // 不传 `immediate`：默认等 window load，与原先那个注入脚本的时机一致，
    // 不跟首屏的包和 IndexedDB 抢带宽。
    onNeedReload: reloadWhenNotTyping,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      // 断网时 update() 会 reject，那是正常情况，不是错误。
      const check = () => void registration.update().catch(() => {});
      setInterval(check, UPDATE_CHECK_INTERVAL_MS);
      // 回到前台、或刚连上网时也问一次：这两个时刻的前一段时间里最可能刚好错过一次部署，
      // 而定时器在页面被挂起时是不走的（手机上尤其）。
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.addEventListener('online', check);
    },
  });
}
