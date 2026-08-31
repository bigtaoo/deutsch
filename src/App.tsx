import { useEffect } from 'react';
import { href, useRoute, useScrollToTopOnRouteChange } from '@/app/router';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useBackupStore } from '@/state/useBackupStore';
import { drainBackupQueue, setBackupHooks, startBackupAutoRetry } from '@/github/backupTrigger';
import { audioPlayer } from '@/audio/player';
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
    void useSettingsStore.getState().load();
    void useLessonStore.getState().load();
    void useVocabStore.getState().load();
    void useBackupStore.getState().hydrate();

    // FR-11.10：备份状态变化时刷新常驻状态条；网络恢复时自动重推排队项。
    setBackupHooks({ onChange: () => void useBackupStore.getState().refreshPendingCount() });
    void drainBackupQueue();
    const stopRetry = startBackupAutoRetry();

    return () => {
      stopRetry();
      audioPlayer.unload();
    };
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16">
      <nav className="sticky top-0 z-20 -mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-neutral-200 bg-white/95 px-4 py-2 backdrop-blur">
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

      {route.name === 'lessons' && <LessonsPage />}
      {route.name === 'import' && <ImportPage />}
      {route.name === 'sources' && <SourcesPage />}
      {route.name === 'lesson' && <LessonPage lessonId={route.lessonId} tab={route.tab} />}
      {route.name === 'vocab' && <VocabPage />}
      {route.name === 'review' && <ReviewPage />}
      {route.name === 'cache' && <CachePage />}
      {route.name === 'settings' && <SettingsPage />}
    </div>
  );
}

export default App;
