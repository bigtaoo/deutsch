import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initStoragePersistence } from './db';
import { initNativeShell } from './platform/native';
import { drainBackupQueue } from './github/backupTrigger';

// FR-11.16: 启动时申请持久化配额，不阻塞渲染。
void initStoragePersistence();

// Capacitor 原生壳的一次性初始化（状态栏、Android 返回键、回前台补推备份）。
// 浏览器里是空操作，所以无条件调。启动图由 App.tsx 在读完 IndexedDB 之后关。
//
// onResume 为什么值得接：startBackupAutoRetry() 是个 setInterval，而手机把 App 挂起时
// 定时器一起冻住 —— 「打完一课 → 切走 → 三天后回来」这条最常见的路径上，
// 队列要等下一次 interval 才动。回前台立刻推一次，备份的时效才对得上 FR-11.10。
initNativeShell({ onResume: () => void drainBackupQueue() });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
