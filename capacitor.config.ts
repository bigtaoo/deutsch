import type { CapacitorConfig } from '@capacitor/cli';

// 原生壳配置（SPEC Q9：桌面用 Electron，手机用 Capacitor）。
//
// ── 为什么要套壳 ──
// FR-15 之后有了两个纯 web 版给不了的东西：**随包带对齐权重**（装完第一次用就离线；
// 实测 490.2 MiB，IPA 381MB，装机 553.6MB —— 见 SPEC §7.10 的首次发布实测）
// 和 **iOS 上的 storage 不再被 7 天策略清除**（原生 App 的 WebView 数据只在卸载时消失，
// 不需要用户记得「添加到主屏幕」—— README §一那条「不装主屏幕 = 数据一定会丢」在原生壳里失效）。
// 壳里跑的是同一份 `npm run build:native` 产物，业务代码一行不变。
//
// ── 路径：不需要 base: './' ──
// KICKOFF 里那句「打包要给 vite 配 base: './'」是针对 **Electron 的 file://** 的。
// Capacitor 不走 file://：iOS 从 `capacitor://localhost/` 提供 webDir，Android 从
// `https://localhost/`，两边都有真正的 URL 根。所以 `?url` 产出的绝对路径 `/assets/…`
// 原样就对，改成相对路径反而会让 Worker 里的动态导入基准变得可疑。**不要动 base。**
//
// ── 不启用 CapacitorHttp ──
// 它会 patch `window.fetch` 走原生栈以绕过 CORS。这里一是不需要（附录 A.1 实测 DW 的
// RSS / 页面 / mp3 三者全部 `Access-Control-Allow-Origin: *`），二是有害：mp3 是几 MB 的
// 二进制，原生桥要把它 base64 过一遍 JSON，内存和耗时都翻番，而且拿不到流式响应。
const config: CapacitorConfig = {
  appId: 'com.gamestao.deutsch',
  appName: '精听',
  webDir: 'dist',
  server: {
    // iOS 固定用 capacitor://localhost；这里只影响 Android 的 scheme。
    // 必须是 https —— IndexedDB 的持久化配额只在安全上下文里给，
    // http://localhost 在 WebView 里不算。
    // （原注释还提到 getUserMedia，那是给 FR-11.18 扫码配对用的，
    // 那条需求已随 GitHub 备份一起删掉，见 SPEC §0 变更 25。）
    androidScheme: 'https',
  },
  ios: {
    // never：WebView 铺满整屏，安全区完全交给 CSS 的 env(safe-area-inset-*) 处理
    // （src/index.css 的 .app-nav / body）。用 'always' 会让系统再插一层 inset，
    // 和 CSS 的 padding 叠起来，吸顶导航下面会空出一条。
    contentInset: 'never',
    // 应用主体是浅色（导航 bg-white），所以壳的底色也给白 —— 否则启动到首帧之间
    // 会闪一下深色。启动图是白底 + 居中的浅蓝图案（不画图标的方框），见 scripts/generate-icons.mjs。
    backgroundColor: '#ffffff',
  },
  android: {
    backgroundColor: '#ffffff',
  },
  plugins: {
    // 热更新（SPEC §7.12 / 变更 41）。判断逻辑全在 src/platform/nativeUpdate.ts，
    // 这里只关掉插件自带的那套、把安全网调到位。
    CapacitorUpdater: {
      // 手动模式。插件自带的 autoUpdate 会 **POST** 到 updateUrl，而 wrangler.jsonc
      // 是纯静态资源部署、没有 Worker 脚本；为一次更新检查引入后端不划算。
      // 改成自己 GET 一份静态 manifest.json，判断留在 TS 里（可单测）。
      autoUpdate: false,
      // 装了新 IPA 就丢掉所有热更 bundle，回到包里那份。
      // **这条是对的方向**：新壳可能带了新的原生方法，而留着的旧 JS 不知道它们存在。
      // 丢掉之后下一次 checkNativeUpdate 会按新壳的版本重新判一遍 minNative。
      resetWhenUpdate: true,
      // 没在这个时间内等到 notifyAppReady() 就回滚到上一个 bundle。
      // 默认 10 秒。放宽到 20：那句 notify 排在「四张 IndexedDB 表读完」之后
      // （App.tsx），冷启动时攒了几十课的标注层读起来并不快,而误判回滚
      // 的症状是「热更装上了又自己退回去」，比多等十秒难查得多。
      appReadyTimeout: 20000,
    },
    SplashScreen: {
      // 自己在 initNativeShell() 里 hide()：默认的 launchAutoHide 是按固定毫秒数关，
      // 而这个应用启动时要读四张 IndexedDB 表（App.tsx 的 useEffect），
      // 定时关会先闪一屏空白再出内容。改成「React 挂载完了才关」。
      launchAutoHide: false,
      backgroundColor: '#ffffff',
    },
  },
};

export default config;
