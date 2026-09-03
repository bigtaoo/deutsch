import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initStoragePersistence } from './db';
import { initNativeShell } from './platform/native';
import { syncNow } from './sync/trigger';
import { initAppShellUpdates } from './platform/pwa';
import { isOAuthPopupReturn } from './sync/session';

// web 版的 Google 登录弹窗跳回来时落在的就是这个入口（重定向地址是本站 origin）。
// 那个窗口不该再启动一遍 App —— 只要 import 一下登录插件，它的 import 副作用会把令牌
// postMessage 回主窗口再关掉自己。插件平时是懒加载的，弹窗里没人 import 它的话，
// 主窗口就一直等到 5 分钟超时。理由与判断依据见 src/sync/session.ts。
if (isOAuthPopupReturn()) {
  void import('@capgo/capacitor-social-login');
} else {
  bootApp();
}

function bootApp(): void {
  // 注册 Service Worker，并让「服务器上有新壳」自动变成「这个页面刷新一次」。
  // 不这样接的话，deploy 之后刷新拿到的是旧壳（理由见 src/platform/pwa.ts 顶部）。
  initAppShellUpdates();

  // FR-11.16: 启动时申请持久化配额，不阻塞渲染。
  void initStoragePersistence();

  // Capacitor 原生壳的一次性初始化（状态栏、Android 返回键、回前台补推备份）。
  // 浏览器里是空操作，所以无条件调。启动图由 App.tsx 在读完 IndexedDB 之后关。
  //
  // onResume 为什么值得接：自动重试挂在 window 的 online 事件上，而手机把 App 挂起时
  // 事件一起冻住 —— 「打完一课 → 切走 → 三天后回来」这条最常见的路径上，
  // 队列要等下一次网络抖动才动。回前台立刻推一次，备份的时效才对得上 FR-11.10。
  //
  // 拉也挂在这里（FR-11.19）：「在桌面上导完一课 → 拿起手机」里的「拿起手机」
  // 就是一次 resume，这是让手机端**不用点任何按钮**就拿到新课的那一下。
  // 频繁 resume 由 pullSyncNow 的 60 秒节流兜着。
  initNativeShell({ onResume: () => void syncNow() });

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
