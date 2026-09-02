// 首页：课程列表 + 两条横幅（备份状态 FR-11.9 / 手动导出提醒 FR-11.12）。

import { href, navigate } from '@/app/router';
import { useLessonStore, isMaterialMissing, isRehydratable } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { Button, EmptyState, formatBytes, formatTime } from '@/components/ui';
import { SyncStatusBar } from '@/components/SyncStatusBar';

export function LessonsPage() {
  const { lessons, caches, loaded, removeLesson } = useLessonStore();
  const entries = useVocabStore((s) => s.entries);
  const dueCount = entries.filter((e) => !e.suspended && e.fsrs.due <= Date.now()).length;

  return (
    <div className="space-y-4">
      <SyncStatusBar />

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">课程</h1>
        <Button onClick={() => navigate({ name: 'sources' })}>从 DW 导入</Button>
        <Button variant="primary" onClick={() => navigate({ name: 'import' })}>
          手动导入
        </Button>
      </div>

      {dueCount > 0 && (
        <a
          href={href({ name: 'review' })}
          className="block rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900"
        >
          今天有 {dueCount} 张卡到期 → 去复习
        </a>
      )}

      {!loaded ? (
        <EmptyState>加载中…</EmptyState>
      ) : lessons.length === 0 ? (
        <EmptyState>还没有课程。从 DW 自动导入，或手动粘贴 Manuskript + 选一个本地 mp3。</EmptyState>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200">
          {lessons.map((lesson) => {
            const cache = caches[lesson.id];
            const annotated = lesson.sentences.filter((s) => s.startTime !== undefined).length;
            const blanks = lesson.sentences.reduce((sum, s) => sum + s.blanks.length, 0);
            return (
              <li key={lesson.id} className="flex flex-wrap items-center gap-3 p-3">
                <a
                  className="min-w-0 flex-1 hover:underline"
                  href={href({ name: 'lesson', lessonId: lesson.id, tab: 'sentences' })}
                >
                  <span className="block font-medium">{lesson.title}</span>
                  <span className="block text-xs text-neutral-500">
                    {lesson.sentences.length} 句 · 已对齐 {annotated} · 挖空 {blanks}
                    {lesson.audioDuration ? ` · ${formatTime(lesson.audioDuration, 0)}` : ''}
                    {cache?.audioBytes ? ` · ${formatBytes(cache.audioBytes)}` : ''}
                  </span>
                </a>

                {isMaterialMissing(cache) && (
                  <span
                    className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
                    title={isRehydratable(lesson) ? '可按 lesson id 重新抓取' : '手动导入，需自己找回音频文件'}
                  >
                    素材未下载
                  </span>
                )}

                <Button
                  variant="danger"
                  onClick={() => {
                    if (confirm(`删除《${lesson.title}》？标注、时间戳、挖空都会一起删除，不可撤销。`)) {
                      void removeLesson(lesson.id);
                    }
                  }}
                >
                  删除
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
