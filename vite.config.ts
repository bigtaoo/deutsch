/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

// `--mode native` 是给 Capacitor 原生壳用的构建（npm run build:native）。
// 它与线上 web 版**只差一件事：不装 Service Worker**。
//
// 为什么原生壳里必须去掉 SW：
//   1. 它在那里没有用途。原生壳的 dist 已经在 App 包里，本来就 100% 离线可用，
//      SW 只是把同一批文件在 WebView 的 Cache Storage 里再存一份。
//   2. 它有害。`registerType: 'autoUpdate'` 是为「刷新页面就能拿到新版」设计的，
//      而原生壳没有「刷新」这回事 —— 版本更新走 App Store。一旦某次装出来的 SW
//      缓存了旧壳的 index.html，下次 `cap sync` 换掉了 dist 也照样吃旧的，
//      而用户没有任何界面可以清它（原生壳里没有地址栏、没有开发者工具）。
// `base` 保持 '/' —— 理由见 capacitor.config.ts 顶部那段（Capacitor 不走 file://）。
export default defineConfig(({ mode }) => {
  const native = mode === 'native';

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(native
        ? []
        : [
            VitePWA({
              registerType: 'autoUpdate',
              includeAssets: ['apple-touch-icon.png'],
              manifest: {
                name: '德语精听训练器',
                short_name: '精听',
                description: '德语精听：切句、打点、跟读、听写、FSRS 复习。素材自备，只存本地。',
                lang: 'zh-CN',
                start_url: '/',
                scope: '/',
                display: 'standalone',
                // background_color 是 PWA 启动闪屏的底，要跟原生启动图（白）一致；
                // theme_color 是浏览器/系统 UI 的着色，跟图标底色 TILE 一致。
                background_color: '#ffffff',
                theme_color: '#e0f2fe',
                icons: [
                  { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                  { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
                  { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
              },
              workbox: {
                // §7.6：**只缓存应用壳，不缓存学习数据**。
                // 学习数据在 IndexedDB 里，Service Worker 本来也碰不到；真正的风险是
                // 顺手把 DW 的 mp3 或 GitHub API 的响应缓存进来 —— 前者会让缓存层出现第二份副本
                // 且绕过 FR-3.8 的清除，后者会让备份读到过期的 sha。所以不配任何 runtimeCaching。
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
                navigateFallback: '/index.html',
                cleanupOutdatedCaches: true,
                // 200MB 的对齐权重（public/models/，npm run stage:align）不在 globPatterns 里，
                // 但 workbox 的默认单文件上限是 2MiB，撞上大文件会在构建时刷一片警告。
                // 明确写死上限，让「哪些文件进预缓存」这件事只由 globPatterns 决定。
                maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
              },
              devOptions: { enabled: false },
            }),
          ]),
    ],
    // 端口听 PORT 环境变量。Vite 默认不读它，自己在 5173 被占时递增 ——
    // 而外部工具（预览面板、脚本）是按它分配的那个端口来找服务器的，
    // 递增之后两边就对不上，症状是「服务起来了但打不开」。
    server: { port: Number(process.env.PORT) || 5173 },

    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      globals: true,
    },
  };
});
