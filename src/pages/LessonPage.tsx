// 一课的工作台。§4 的动线②～⑦全部在这里，按 tab 切换。
// 音频/素材状态是全页共享的，所以放在壳里而不是各个 tab 里各查一遍。

import { useState } from 'react';
import { LESSON_TABS, LESSON_TAB_LABELS, href, navigate, type LessonTab } from '@/app/router';
import { useLessonStore, isMaterialMissing, isRehydratable } from '@/state/useLessonStore';
import { useAlignStore } from '@/state/useAlignStore';
import { SentencesTab } from './lesson/SentencesTab';
import { AlignStatus } from './lesson/AlignStatus';
import { ListenTab } from './lesson/ListenTab';
import { ShadowingTab } from './lesson/ShadowingTab';
import { StudyTab } from './lesson/StudyTab';
import { DictationTab } from './lesson/DictationTab';
import { Banner, Button, EmptyState, Hint, formatBytes, formatTime } from '@/components/ui';

export function LessonPage({ lessonId, tab }: { lessonId: string; tab: LessonTab }) {
  const lesson = useLessonStore((s) => s.lessons.find((l) => l.id === lessonId));
  const cache = useLessonStore((s) => s.caches[lessonId]);
  const loaded = useLessonStore((s) => s.loaded);

  if (!loaded) return <EmptyState>加载中…</EmptyState>;
  if (!lesson) return <EmptyState>找不到这一课。它可能已被删除。</EmptyState>;


  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{lesson.title}</h1>
        <p className="text-sm text-neutral-500">
          {lesson.audioDuration ? `音频 ${formatTime(lesson.audioDuration, 0)}` : '没有音频'}
          {cache?.audioBytes ? ` · ${formatBytes(cache.audioBytes)}` : ''}
        </p>
        {/* FR-6.4 的「已标注 N / M」搬到这里：它现在说的是自动对齐的覆盖率与可疑句数。 */}
        <AlignStatus lesson={lesson} />
      </header>

      {isMaterialMissing(cache) && <MissingMaterialBanner lessonId={lessonId} />}

      <nav className="flex flex-wrap gap-1 border-b border-neutral-200 pb-2">
        {LESSON_TABS.map((t) => (
          <a
            key={t}
            href={href({ name: 'lesson', lessonId, tab: t })}
            className={`rounded px-3 py-1.5 text-sm ${
              t === tab ? 'bg-neutral-800 text-white' : 'text-neutral-600 hover:bg-neutral-100'
            }`}
          >
            {LESSON_TAB_LABELS[t]}
          </a>
        ))}
      </nav>

      {tab === 'sentences' && <SentencesTab lesson={lesson} cache={cache} />}
      {tab === 'listen' && <ListenTab lesson={lesson} cache={cache} />}
      {tab === 'shadowing' && <ShadowingTab lesson={lesson} cache={cache} />}
      {tab === 'study' && <StudyTab lesson={lesson} cache={cache} />}
      {tab === 'dictation' && <DictationTab lesson={lesson} cache={cache} />}
    </div>
  );
}

/** FR-3.4：明确显示「素材未下载」，并给出补齐入口。绝不假装能播。 */
function MissingMaterialBanner({ lessonId }: { lessonId: string }) {
  const lesson = useLessonStore((s) => s.lessons.find((l) => l.id === lessonId))!;
  const attachAudio = useLessonStore((s) => s.attachAudio);
  const enqueueAlign = useAlignStore((s) => s.enqueue);
  const [message, setMessage] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    const { duration, mismatch } = await attachAudio(lessonId, file);
    // 换了音频文件 = 旧时间戳大概率作废，直接重对一遍（FR-15）。
    enqueueAlign(lessonId);
    setMessage(
      mismatch
        ? `已绑定，但时长不匹配（原 ${formatTime(lesson.audioDuration, 0)} vs 新 ${formatTime(duration, 0)}），时间戳可能失效。`
        : `已绑定：${file.name}`,
    );
  };

  return (
    <Banner tone="warn">
      <p className="font-medium">素材未下载</p>
      <p className="mt-1">
        标注层里有这一课，但本机没有音频，播放相关的功能全部不可用。
        {isRehydratable(lesson)
          ? '这一课来自 DW，可以按 lesson id 重新抓取（去「来源」页补齐）。'
          : '这一课是手动导入的，无法自动补齐，需要重新选择本地音频文件。'}
      </p>
      <div className="mt-2 flex items-center gap-3">
        <input type="file" accept="audio/*" className="text-sm" onChange={(e) => void pick(e.target.files?.[0])} />
        {isRehydratable(lesson) && (
          <Button onClick={() => navigate({ name: 'sources' })}>去自动补齐</Button>
        )}
      </div>
      {message && <Hint tone="warn">{message}</Hint>}
    </Banner>
  );
}
