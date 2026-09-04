import { useEffect } from 'react';
import { useRoute, useScrollToTopOnRouteChange } from '@/app/router';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useSyncStore } from '@/state/useSyncStore';
import { setSyncHooks, startSyncAutoRetry, syncNow } from '@/sync/trigger';
import { audioPlayer } from '@/audio/player';
import { hideNativeSplash } from '@/platform/native';
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
    ]);
    // 原生壳的启动图等这四张表读完再关（capacitor.config.ts 里 launchAutoHide: false）。
    // allSettled 而不是 all：某张表读挂了也得关，否则用户对着启动图干等。
    // 浏览器里这是空操作。
    void ready.then(() => {
      hideNativeSplash();
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
      },
      onSessionExpired: () => useSyncStore.getState().markSessionExpired(),
    });
    const stopRetry = startSyncAutoRetry();

    return () => {
      stopRetry();
      audioPlayer.unload();
    };
  }, []);

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
        {route.name === 'settings' && <SettingsPage />}
      </main>

      {shouldShowBottomTabs(route) && <BottomTabs route={route} />}

      {/* 自动对齐要跑几分钟，进度必须跟着人走，而不是待在某一页上。 */}
      <AlignBar />
    </div>
  );
}

export default App;
