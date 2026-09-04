// 首页：课程列表。
//
// ── 它以前长什么样 ──
// 在你看到第一课之前，这一页先给你三层壳：六个横向滚动的 tab、一行五个字段的同步
// 状态、一段三行的黄底论文（内容是「自动同步与手动导出是不同的故障域」这个取舍论证）。
// 而那段横幅在**全新安装第一次打开时就会出现** —— `lastBackupAt` 只在导出时才写，
// 所以「距上次手动导出已超过 90 天」是新装机的默认状态，那时你还没有任何东西可丢。
//
// 现在：同步状态跟着应用外壳走（SyncChip），备份提醒分两档且有东西可丢才说
// （FR-11.12 的修订，见 SyncChip.tsx 的 manualExportStage），到期卡是导航上的角标
// 加这一页顶上一行可点的入口。列表从第一屏就开始。

import { href, lessonHref, navigate } from '@/app/router';
import { useLessonStore, isMaterialMissing, isRehydratable } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useDueCount } from '@/components/AppNav';
import { manualExportStage } from '@/components/SyncChip';
import { Banner, Button, Chip, EmptyState, Note, formatBytes, formatTime } from '@/components/ui';

export function LessonsPage() {
  const { lessons, caches, loaded, removeLesson } = useLessonStore();
  const vocabCount = useVocabStore((s) => s.entries.length);
  const lastBackupAt = useSettingsStore((s) => s.settings.lastBackupAt);
  const dueCount = useDueCount();

  // 「有东西可丢」= 标注层里真有内容。空库上提醒备份是纯噪声。
  const backupStage = manualExportStage(lastBackupAt, lessons.length > 0 || vocabCount > 0);

  return (
    <div className="space-y-4">
      {backupStage === 'overdue' && (
        <Banner
          tone="warn"
          title="手动备份已经过期半年了"
          action={<Button onClick={() => navigate({ name: 'settings' })}>去导出</Button>}
        >
          <p>自动同步只防一种故障。同步服务器本身出问题（机器没了、证书过期、账号登不上）时，能救回来的只有那份导出文件。</p>
        </Banner>
      )}

      {dueCount > 0 && (
        <a
          href={href({ name: 'review' })}
          className="flex items-center gap-3 rounded-box border border-accent/40 bg-accent-soft px-4 py-3 text-ui text-accent"
        >
          <span className="tnum text-title font-semibold">{dueCount}</span>
          <span className="flex-1">张卡今天到期</span>
          <span aria-hidden>›</span>
        </a>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto hidden text-title font-semibold sm:block">课程</h1>
        <Button onClick={() => navigate({ name: 'sources' })}>从 DW 导入</Button>
        <Button variant="primary" onClick={() => navigate({ name: 'import' })}>
          手动导入
        </Button>
      </div>

      {backupStage === 'remind' && (
        <Note tone="warn" action={<a className="underline" href={href({ name: 'settings' })}>去导出</a>}>
          {lastBackupAt === undefined ? '还没手动导出过备份。' : '距上次手动导出已超过 90 天。'}
        </Note>
      )}

      {!loaded ? (
        <EmptyState>加载中…</EmptyState>
      ) : lessons.length === 0 ? (
        <EmptyState>还没有课程。从 DW 自动导入，或手动粘贴 Manuskript + 选一个本地 mp3。</EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-box border border-line bg-raised">
          {lessons.map((lesson) => {
            const cache = caches[lesson.id];
            const usable = lesson.sentences.filter((s) => !s.excluded);
            const aligned = usable.filter((s) => s.startTime !== undefined).length;
            const blanks = lesson.sentences.reduce((sum, s) => sum + s.blanks.length, 0);
            return (
              <li key={lesson.id} className="flex items-center gap-3 p-3">
                <a
                  className="min-w-0 flex-1 hover:underline"
                  href={lessonHref(lesson.id)}
                >
                  <span className="block font-medium">{lesson.title}</span>
                  <span className="tnum block text-note text-faint">
                    {usable.length} 句 · 已对齐 {aligned} · 挖空 {blanks}
                    {lesson.audioDuration ? ` · ${formatTime(lesson.audioDuration, 0)}` : ''}
                    {cache?.audioBytes ? ` · ${formatBytes(cache.audioBytes)}` : ''}
                  </span>
                </a>

                {isMaterialMissing(cache) && (
                  <Chip
                    tone="warn"
                    title={isRehydratable(lesson) ? '可按 lesson id 重新抓取' : '手动导入，需自己找回音频文件'}
                  >
                    素材未下载
                  </Chip>
                )}

                {/* 删除不该在每一行上都喊一声。默认是灰的，指到才变红。 */}
                <Button
                  variant="ghost"
                  className="shrink-0 hover:text-danger"
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
