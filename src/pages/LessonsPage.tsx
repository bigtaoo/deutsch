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
//
// FR-1.9（2026-09-26）：有分组名的课（教材）收进各自的折叠组，其余照旧平铺在最上面。

import { useMemo, useState } from 'react';
import { href, lessonHref, navigate } from '@/app/router';
import { useLessonStore, isMaterialMissing, isRehydratable } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useDueCount } from '@/components/AppNav';
import { manualExportStage } from '@/components/SyncChip';
import { Banner, Button, Chip, EmptyState, FilePicker, Note, formatBytes, formatTime } from '@/components/ui';
import { bindPickedAudio, listedAudioFiles, matchGroupFiles } from '@/lesson/bindAudio';
import type { Lesson } from '@/types/models';

export function LessonsPage() {
  const { lessons, loaded } = useLessonStore();
  const vocabCount = useVocabStore((s) => s.entries.length);
  const lastBackupAt = useSettingsStore((s) => s.settings.lastBackupAt);
  const dueCount = useDueCount();
  const { ungrouped, groups } = useMemo(() => groupLessons(lessons), [lessons]);

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
        <Button onClick={() => navigate({ name: 'import-book' })}>导入教材</Button>
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
        <>
          {ungrouped.length > 0 && <LessonList lessons={ungrouped} />}
          {groups.map(([name, members]) => (
            <CollectionGroup key={name} name={name} lessons={members} />
          ))}
        </>
      )}
    </div>
  );
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/**
 * FR-1.9：分组。组内按标题自然排序（`Kapitel 2` 在 `Kapitel 10` 前面）—— 教材的顺序
 * 就写在标题里；按导入时间排的话，先导第 5 章再导第 1 章，列表就是倒的。
 * 组与组之间按名字排。没分组的课保持原来的顺序（新的在上）。
 */
export function groupLessons(lessons: readonly Lesson[]): {
  ungrouped: Lesson[];
  groups: Array<[string, Lesson[]]>;
} {
  const ungrouped: Lesson[] = [];
  const byName = new Map<string, Lesson[]>();
  for (const lesson of lessons) {
    if (!lesson.collection) {
      ungrouped.push(lesson);
      continue;
    }
    const list = byName.get(lesson.collection) ?? [];
    list.push(lesson);
    byName.set(lesson.collection, list);
  }
  const groups = [...byName.entries()]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([name, list]): [string, Lesson[]] => [name, [...list].sort((a, b) => collator.compare(a.title, b.title))]);
  return { ungrouped, groups };
}

function LessonList({ lessons }: { lessons: Lesson[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-box border border-line bg-raised">
      {lessons.map((lesson) => (
        <LessonRow key={lesson.id} lesson={lesson} />
      ))}
    </ul>
  );
}

function LessonRow({ lesson }: { lesson: Lesson }) {
  const cache = useLessonStore((s) => s.caches[lesson.id]);
  const removeLesson = useLessonStore((s) => s.removeLesson);
  const usable = lesson.sentences.filter((s) => !s.excluded);
  const aligned = usable.filter((s) => s.startTime !== undefined).length;
  const blanks = lesson.sentences.reduce((sum, s) => sum + s.blanks.length, 0);
  return (
    <li className="flex items-center gap-3 p-3">
      <a className="min-w-0 flex-1 hover:underline" href={lessonHref(lesson.id)}>
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
}

const OPEN_KEY = 'lessons.openGroups';

function readOpenGroups(): string[] {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

function writeOpenGroups(names: string[]) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(names));
  } catch {
    // 私密窗口里写不进去就算了：只是少记住一次展开状态
  }
}

/**
 * 一组课。默认折叠 —— 一本教材四五十课，展开着会把每周那篇 DW 挤到第二屏以下。
 * 展开状态记在本机（进一课再返回时不该又收起来），它是个人习惯，不同步。
 */
function CollectionGroup({ name, lessons }: { name: string; lessons: Lesson[] }) {
  const caches = useLessonStore((s) => s.caches);
  const [open, setOpen] = useState(() => readOpenGroups().includes(name));
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const missing = lessons.filter((l) => isMaterialMissing(caches[l.id]) && listedAudioFiles(l).length > 0);
  const aligned = lessons.filter((l) => l.sentences.some((s) => s.startTime !== undefined)).length;

  const onToggle = (next: boolean) => {
    if (next === open) return;
    setOpen(next);
    const rest = readOpenGroups().filter((n) => n !== name);
    writeOpenGroups(next ? [...rest, name] : rest);
  };

  /** FR-3.6a：换设备后一次补齐整组的音频，每课按自己记着的文件名认领。 */
  const bindGroup = async (picked: File[]) => {
    if (picked.length === 0) return;
    setBusy(true);
    setMessage(null);
    const { matched, unmatched } = matchGroupFiles(missing, picked);
    let realigned = 0;
    let failed = 0;
    for (const { lesson, files } of matched) {
      try {
        const result = await bindPickedAudio(lesson, files);
        if (result.ok && result.realigned) realigned++;
      } catch {
        failed++;
      }
    }
    setBusy(false);
    setMessage(groupBindSummary(matched.length - failed, realigned, unmatched.length, failed));
  };

  return (
    <details
      className="group rounded-box border border-line bg-raised"
      open={open}
      onToggle={(e) => onToggle(e.currentTarget.open)}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2">
        <span className="inline-block w-3 text-muted transition-transform group-open:rotate-90">›</span>
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        <span className="tnum shrink-0 text-note text-faint">
          {lessons.length} 课 · 已对齐 {aligned}
        </span>
        {missing.length > 0 && <Chip tone="warn">{missing.length} 课缺音频</Chip>}
      </summary>
      <div className="space-y-2 border-t border-line p-2">
        {missing.length > 0 && (
          <Note
            tone="warn"
            action={
              <FilePicker accept="audio/*" onPickMany={(files) => void bindGroup(files)}>
                {busy ? '正在补…' : '一次选齐音频…'}
              </FilePicker>
            }
          >
            {missing.length} 课在这台设备上还没有音频。把这本书的音频文件一次全选上，按文件名各归各课。
          </Note>
        )}
        {message && <Note>{message}</Note>}
        <LessonList lessons={lessons} />
      </div>
    </details>
  );
}

export function groupBindSummary(bound: number, realigned: number, unmatched: number, failed: number): string {
  const parts = [`补上了 ${bound} 课`];
  if (bound > 0) parts.push(realigned > 0 ? `其中 ${realigned} 课要重新对齐` : '时间戳都是同步来的，不用重对');
  if (unmatched > 0) parts.push(`还有 ${unmatched} 课的文件不在这次选的里面`);
  if (failed > 0) parts.push(`${failed} 课读不出来`);
  return `${parts.join('，')}。`;
}
