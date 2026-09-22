import { useEffect } from 'react';
import { useRoute, useScrollToTopOnRouteChange } from '@/app/router';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useSyncStore } from '@/state/useSyncStore';
import { connectStudyClock, useStudyStore } from '@/state/useStudyStore';
import { attachStudyClockListeners, studyClock } from '@/study/tracker';
import { isPracticeRoute } from '@/study/surface';
import { setSyncHooks, startSyncAutoRetry, syncNow } from '@/sync/trigger';
import { audioPlayer } from '@/audio/player';
import { hideNativeSplash, nativePlatform } from '@/platform/native';
import { initSafeArea } from '@/platform/safeArea';
import { attachWakeLockListener, setKeepAwake } from '@/platform/wakeLock';
import { checkNativeUpdate, notifyNativeAppReady } from '@/platform/nativeUpdate';
import { useAlignStore } from '@/state/useAlignStore';
import { AlignBar, AlignCrashBanner } from '@/components/AlignBar';
import { BottomTabs, TopBar, shouldShowBottomTabs } from '@/components/AppNav';
import { LessonsPage } from '@/pages/LessonsPage';
import { ImportPage } from '@/pages/ImportPage';
import { LessonPage } from '@/pages/LessonPage';
import { SourcesPage } from '@/pages/SourcesPage';
import { VocabPage } from '@/pages/VocabPage';
import { ReviewPage } from '@/pages/ReviewPage';
import { CachePage } from '@/pages/CachePage';
import { RecordPage } from '@/pages/RecordPage';
import { SettingsPage } from '@/pages/SettingsPage';

function App() {
  const route = useRoute();
  useScrollToTopOnRouteChange(route);

  useEffect(() => {
    // 四个 store 各读一次 IndexedDB。都是几百 KB 的标注层，一次读完最省事。
    const ready = Promise.allSettled([
      useSettingsStore.getState().load(),
      useLessonStore.getState().load(),
      useVocabStore.getState().load(),
      useSyncStore.getState().hydrate(),
      useStudyStore.getState().load(),
    ]);
    // 原生壳的启动图等这四张表读完再关（capacitor.config.ts 里 launchAutoHide: false）。
    // allSettled 而不是 all：某张表读挂了也得关，否则用户对着启动图干等。
    // 浏览器里这是空操作。
    void ready.then(() => {
      hideNativeSplash();
      // FR-21：热更的两件事都挂在「表读完了」这一刻。
      // notifyNativeAppReady 取消原生侧的回滚倒计时 —— 判据必须是「库真的读出来了」，
      // 放在模块顶层等于没判：一个连 IndexedDB 都打不开的构建照样能执行到 import。
      void notifyNativeAppReady();
      // 查更新排在同步后面：它要下 36MB，而「打开就想用」的那几秒该留给同步。
      // 下载在原生侧的后台线程上，不占 WebView，所以不用再额外延时。
      void checkNativeUpdate();
      // FR-11.19：启动时同步一次 —— 先把排队的推出去，再把别的设备改过的拉回来。
      // **必须等这四张表读完**：拉取会往库里写，写完由 onRemoteDataWritten 让 store 重读，
      // 而初次 load() 如果晚于那次重读，界面就退回到拉取之前的旧值了。
      void syncNow();
    });

    // FR-15：启动时问一次黑匣子「上次自动对齐是不是被系统杀掉的」。
    // 必须在这里、而且只做一次 —— detectCrash() 会把那条记录归档，第二次调用就看不到了。
    useAlignStore.getState().init();

    // FR-11.10：同步状态变化时刷新常驻状态（现在是头部那个芯片，见 SyncChip.tsx）；
    // 网络恢复时自动重推排队项。
    // onRemoteDataWritten：合并把另一台设备的数据写进了本地库，内存里的 store
    // 得重读一遍 —— 否则界面上还是合并前的旧值，而用户什么提示都没有。
    // 设置也在其中（§0 变更 28）：它同步之后，「另一台设备改的值」同样会走这条路进来。
    setSyncHooks({
      onChange: () => void useSyncStore.getState().refreshStatus(),
      onRemoteDataWritten: () => {
        void useLessonStore.getState().load();
        void useVocabStore.getState().load();
        void useSettingsStore.getState().load();
        void useStudyStore.getState().load();
      },
      onSessionExpired: () => useSyncStore.getState().markSessionExpired(),
    });
    const stopRetry = startSyncAutoRetry();

    // FR-18：学习计时。监听挂在 window 上（全局，与路由无关），
    // 「现在算不算在练」由下面那个 effect 按路由开关。
    connectStudyClock();
    const stopClockListeners = attachStudyClockListeners();
    // FR-18.5：屏幕常亮。规范规定页面一不可见浏览器就自动收走这把锁，
    // 而回到前台不会自己还 —— 所以必须有人在 visibilitychange 上把它要回来。
    const stopWakeLock = attachWakeLockListener();

    // 顶部安全区的兜底（变更 46）：iPhone 13 上量到过 env(safe-area-inset-top) = 0，
    // 导航因此压住状态栏。**要等 platform 定下来**才能做 —— 只在 iOS 原生壳上补，
    // 浏览器和 Android 上凭空加一条 47px 白边是实打实的破坏。
    void nativePlatform().then(initSafeArea);

    return () => {
      stopRetry();
      stopClockListeners();
      stopWakeLock();
      setKeepAwake(false);
      audioPlayer.unload();
    };
  }, []);

  // FR-18.1：进出练习界面就是开表与停表。停表时计时器会把攒着的秒数立刻落库 ——
  // 所以从跟读页走到记录页，那一页看到的就是刚刚练完的数。
  useEffect(() => {
    const practising = isPracticeRoute(route);
    studyClock.setActive(practising);
    // FR-18.5：同一条判据也决定屏幕要不要保持亮着。**共用 isPracticeRoute**，
    // 不写第二份名单 —— 一个「什么时候算在学习」的问题有两个答案，迟早会漂成两个。
    setKeepAwake(practising);
  }, [route.name, route.name === 'lesson' ? route.tab : '']);

  return (
    <div className="min-h-dvh">
      <TopBar route={route} />

      {/* app-content 的下边距来自 --bottom-inset（§12.2）：底部真实占了多高由
          bottomLayer.ts 按实测算出来，不再是容器上那个写死的 pb-24。 */}
      <main className="app-content mx-auto max-w-4xl space-y-4 px-4 pt-4">
        <AlignCrashBanner />

        {route.name === 'lessons' && <LessonsPage />}
        {route.name === 'import' && <ImportPage />}
        {route.name === 'sources' && <SourcesPage />}
        {route.name === 'lesson' && <LessonPage lessonId={route.lessonId} tab={route.tab} />}
        {route.name === 'vocab' && <VocabPage />}
        {route.name === 'review' && <ReviewPage />}
        {route.name === 'cache' && <CachePage />}
        {route.name === 'record' && <RecordPage />}
        {route.name === 'settings' && <SettingsPage />}
      </main>

      {shouldShowBottomTabs(route) && <BottomTabs route={route} />}

      {/* 自动对齐要跑几分钟，进度必须跟着人走，而不是待在某一页上。 */}
      <AlignBar />
    </div>
  );
}

export default App;
