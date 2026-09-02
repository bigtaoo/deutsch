import { useEffect } from 'react';
import { href, useRoute, useScrollToTopOnRouteChange } from '@/app/router';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useSyncStore } from '@/state/useSyncStore';
import { drainSyncQueue, setSyncHooks, startSyncAutoRetry } from '@/sync/trigger';
import { audioPlayer } from '@/audio/player';
import { hideNativeSplash } from '@/platform/native';
import { useAlignStore } from '@/state/useAlignStore';
import { AlignBar, AlignCrashBanner } from '@/components/AlignBar';
import { LessonsPage } from '@/pages/LessonsPage';
import { ImportPage } from '@/pages/ImportPage';
import { LessonPage } from '@/pages/LessonPage';
import { SourcesPage } from '@/pages/SourcesPage';
import { VocabPage } from '@/pages/VocabPage';
import { ReviewPage } from '@/pages/ReviewPage';
import { CachePage } from '@/pages/CachePage';
import { SettingsPage } from '@/pages/SettingsPage';

const NAV: Array<{ label: string; route: Parameters<typeof href>[0] }> = [
  { label: '课程', route: { name: 'lessons' } },
  { label: '来源', route: { name: 'sources' } },
  { label: '生词本', route: { name: 'vocab' } },
  { label: '复习', route: { name: 'review' } },
  { label: '素材', route: { name: 'cache' } },
  { label: '设置', route: { name: 'settings' } },
];

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
    void ready.then(() => hideNativeSplash());

    // FR-15：启动时问一次黑匣子「上次自动对齐是不是被系统杀掉的」。
    // 必须在这里、而且只做一次 —— detectCrash() 会把那条记录归档，第二次调用就看不到了。
    useAlignStore.getState().init();

    // FR-11.10：同步状态变化时刷新常驻状态条；网络恢复时自动重推排队项。
    // onRemoteDataWritten：合并把另一台设备的数据写进了本地库，内存里的 store
    // 得重读一遍 —— 否则界面上还是合并前的旧值，而用户什么提示都没有。
    // 设置也在其中（§0 变更 28）：它同步之后，「另一台设备改的值」同样会走这条路进来。
    setSyncHooks({
      onChange: () => void useSyncStore.getState().refreshPendingCount(),
      onRemoteDataWritten: () => {
        void useLessonStore.getState().load();
        void useVocabStore.getState().load();
        void useSettingsStore.getState().load();
      },
      onSessionExpired: () => useSyncStore.getState().markSessionExpired(),
    });
    void drainSyncQueue();
    const stopRetry = startSyncAutoRetry();

    return () => {
      stopRetry();
      audioPlayer.unload();
    };
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24">
      <nav className="app-nav sticky top-0 z-20 -mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-neutral-200 bg-white/95 px-4 py-2 backdrop-blur">
        {NAV.map((item) => (
          <a
            key={item.label}
            href={href(item.route)}
            className={`shrink-0 rounded px-3 py-1.5 text-sm ${
              route.name === item.route.name ? 'bg-neutral-800 text-white' : 'text-neutral-600 hover:bg-neutral-100'
            }`}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <AlignCrashBanner />

      {route.name === 'lessons' && <LessonsPage />}
      {route.name === 'import' && <ImportPage />}
      {route.name === 'sources' && <SourcesPage />}
      {route.name === 'lesson' && <LessonPage lessonId={route.lessonId} tab={route.tab} />}
      {route.name === 'vocab' && <VocabPage />}
      {route.name === 'review' && <ReviewPage />}
      {route.name === 'cache' && <CachePage />}
      {route.name === 'settings' && <SettingsPage />}

      {/* 自动对齐要跑几分钟，进度必须跟着人走，而不是待在某一页上。 */}
      <AlignBar />
    </div>
  );
}

export default App;
