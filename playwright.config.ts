// E2E（§10 验收清单里「界面」那一段的自动化部分）。
//
// ── 为什么单独一套，而不是塞进 vitest ──
// vitest 那 745 个跑在 jsdom 里，而 jsdom 里**没有 IndexedDB 的真实持久化、没有音频
// 解码、没有 <input type=file>、没有刷新页面这回事**。这套测的正好就是那些：
// 「关掉再打开，东西还在吗」是这个应用最基本的承诺（素材只存本地），
// 而它在 jsdom 里连问都问不出来。
//
// ── 为什么跑构建产物而不是 dev server ──
// `npm run build` 只能证明它编得过。这里再往前一步：编出来的那份**真的能启动**。
// 代价是每次跑 E2E 前要构建一次（约十几秒），换来的是「类型过了、构建过了、
// 但打开是白屏」这一类事故进不了 main —— 而 main 一推就是上线。
//
// ── 只有 Chromium ──
// 这个应用的真实运行环境是桌面 Chrome 与 iOS 的 WKWebView。WebKit 那条在 CI 上
// 跑的是 Linux 版 WebKit，和真机 Safari 不是一回事，测出来的绿灯会给人虚假的安心。
// iPhone 那一侧照旧靠 §10 的人工复验。

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // 每个用例都要开一次库、导一次数据，十几秒是正常的；超过一分钟就是真的卡住了。
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // CI 上 .only 是忘了删，不是有意的。
  forbidOnly: !!process.env.CI,
  // 不重试：这套里任何一次红都该是真的红。允许重试等于允许写出不稳的用例，
  // 而一个会随机变绿的门禁比没有门禁更糟。
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: BASE_URL,
    // 只在失败时留证据 —— 全留会让 CI 的产物涨到几百 MB。
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // 导出备份那条路要真的落一个文件下来。
    acceptDownloads: true,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      // 窄屏那套只在 mobile 上跑 —— 桌面宽度下底部标签栏是 hidden，全会红。
      testIgnore: /mobile\.spec\.ts$/,
    },
    {
      // §12.1 的底部标签栏只在 sm 以下出现，只有真的窄屏才验得到。
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile\.spec\.ts$/,
    },
  ],

  webServer: {
    // 只 `vite build`，不走 `npm run build`（那一条前面还挂着 `tsc -b`）。
    // 类型检查在 CI 里是单独一步，重复跑一遍只会让**类型错误表现成 E2E 全红** ——
    // 而那时红的是十几个用例，每一个的报错都指向 webServer 起不来，
    // 真正的那行 TS 错误埋在日志最上面。让这里的红只代表一件事：应用跑不起来。
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
