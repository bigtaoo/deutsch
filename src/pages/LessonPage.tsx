// 一课的工作台。§4 的动线②～⑦全部在这里，按 tab 切换。
// 音频/素材状态是全页共享的，所以放在壳里而不是各个 tab 里各查一遍。

import { useEffect, useState } from 'react';
import { LESSON_TABS, LESSON_TAB_LABELS, href, navigate, type LessonTab } from '@/app/router';
import { useLessonStore, isMaterialMissing, isRehydratable } from '@/state/useLessonStore';
import { useAlignStore } from '@/state/useAlignStore';
import { rehydrateLesson } from '@/sources/importLesson';
import { hasTimings } from '@/align/apply';
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

/**
 * 打开这一课时已经自动补齐过一次的 lessonId。
 *
 * 模块级而不是组件状态：切 tab 会让这个组件重新挂载，用组件状态记的话，
 * 一次失败的补齐会在每次切 tab 时重跑 —— 每次都是 6~10MB。
 * StrictMode 在开发模式下把 effect 跑两遍，也靠这个集合挡住。
 */
const autoRehydrated = new Set<string>();

/**
 * FR-3.4：明确显示「素材未下载」，并给出补齐入口。绝不假装能播。
 *
 * FR-3.5a（§0 变更 34）：DW 来源的课程**打开就自动补齐**，不用先绕去「来源」页。
 * 理由是同步落地之后这条路成了常态而不是例外：桌面导入 → 手机上课程自己出现（FR-11.19）
 * → 缺的只有音频和原文这两样按设计不同步的东西。让人在这里读一句「去『来源』页补齐」
 * 再自己找过去，是把一个纯机械的步骤留给人做。
 *
 * 代价说清楚：它会在移动网络下直接开始下 6~10MB。取舍是「练不了」比「省流量」更疼 ——
 * 而且下载中横幅一直在，不是偷偷进行。
 */
function MissingMaterialBanner({ lessonId }: { lessonId: string }) {
  const lesson = useLessonStore((s) => s.lessons.find((l) => l.id === lessonId))!;
  const attachAudio = useLessonStore((s) => s.attachAudio);
  const enqueueAlign = useAlignStore((s) => s.enqueue);
  const native = useAlignStore((s) => s.native);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 文稿 hash 变了（FR-3.7）：那两个选项的界面在「来源」页，这里只能把人送过去。 */
  const [needsDecision, setNeedsDecision] = useState(false);

  const rehydratable = isRehydratable(lesson);

  const rehydrate = async () => {
    setBusy(true);
    setMessage(null);
    setNeedsDecision(false);
    try {
      const outcome = await rehydrateLesson(lesson);
      if (outcome.manuscriptChanged) {
        setNeedsDecision(true);
        setMessage('DW 改过稿：音频补齐了，但正文要你选一条路（重切还是保留旧标注）。');
      } else if (outcome.audioError) {
        setMessage(`音频没抓到：${outcome.audioError}`);
      } else if (!hasTimings(lesson.sentences) || outcome.audioDurationChanged) {
        // 只有「压根没有时间戳」和「音频换过了」才值得对齐，见 align/apply.ts 的 hasTimings。
        enqueueAlign(lessonId);
        setMessage(
          native
            ? '素材已补齐。这一课还没有时间戳 —— 手机上不自动对齐，在桌面上对一次会同步回来。'
            : '素材已补齐，正在自动对齐（进度在页面底部）。',
        );
      } else {
        setMessage('素材已补齐。时间戳是同步来的，不用重对。');
      }
    } catch (err) {
      setMessage(`补齐失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const pickAudio = async (file: File | undefined) => {
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

  useEffect(() => {
    if (!rehydratable || autoRehydrated.has(lessonId)) return;
    // 离线时不试：失败之后这一课在本次会话里就不再自动补了，白占一次机会。
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    autoRehydrated.add(lessonId);
    void rehydrate();
    // rehydrate 只依赖 lessonId 那一课；依赖数组刻意只写 lessonId，
    // 否则 store 每次刷新都会重建 rehydrate 并让这个 effect 再跑一遍。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId, rehydratable]);

  return (
    <Banner tone="warn">
      <p className="font-medium">{busy ? '正在补齐素材…' : '素材未下载'}</p>
      <p className="mt-1">
        {busy
          ? '照标注层里记着的下载地址重新抓页面和音频（6~10MB），抓完这一页的播放功能就恢复。'
          : '标注层里有这一课，但本机没有音频，播放相关的功能全部不可用。'}
        {!busy &&
          (rehydratable
            ? '这一课来自 DW，可以按 lesson id 重新抓取。'
            : '这一课是手动导入的，无法自动补齐，需要重新选择本地音频文件。')}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept="audio/*"
          className="text-sm"
          onChange={(e) => void pickAudio(e.target.files?.[0])}
        />
        {rehydratable && !needsDecision && (
          <Button disabled={busy} onClick={() => void rehydrate()}>
            {busy ? '补齐中…' : '重新抓取'}
          </Button>
        )}
        {needsDecision && <Button onClick={() => navigate({ name: 'sources' })}>去「来源」页处理</Button>}
      </div>
      {message && <Hint tone="warn">{message}</Hint>}
    </Banner>
  );

}
