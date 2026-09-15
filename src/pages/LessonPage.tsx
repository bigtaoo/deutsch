// 一课的工作台。§4 的动线②～⑦全部在这里，按 tab 切换。
// 音频/素材状态是全页共享的，所以放在壳里而不是各个 tab 里各查一遍。
//
// ── 动线（SPEC §12.6）──
// 落地页从「切句」改成「通听」。以前打开一课的默认状态是**编辑模式** —— 五个 tab
// 平级排着，第一个是切句，而切句是一次性的准备工作，不是每天要做的事。
// 现在 tab 条只有每天走的那四个，顺序就是真实动线（通听 → 跟读 → 学词 → 听写），
// 切句收进页头的「⋯」。`#/lesson/<id>/sentences` 这个深链接照旧有效。
//
// tab 名旁边那个点是**前提状态**，不是「做完了」：通听和跟读要时间戳，听写还要挖空。
// 缺前提时点进去会得到一句话说清缺什么 —— 但在点进去之前就该看得出来。

import { useEffect, useRef, useState } from 'react';
import {
  PRACTICE_TABS,
  LESSON_TAB_LABELS,
  href,
  navigate,
  type LessonTab,
} from '@/app/router';
import { useLessonStore, isMaterialMissing, isRehydratable } from '@/state/useLessonStore';
import { useAlignStore } from '@/state/useAlignStore';
import { rehydrateLesson } from '@/sources/importLesson';
import { hasTimings } from '@/align/apply';
import { SentencesTab } from './lesson/SentencesTab';
import { AlignStatus } from './lesson/AlignStatus';
import { ListenTab } from './lesson/ListenTab';
import { TranslationTab } from './lesson/TranslationTab';
import { ShadowingTab } from './lesson/ShadowingTab';
import { StudyTab } from './lesson/StudyTab';
import { DictationTab } from './lesson/DictationTab';
import { Banner, Button, EmptyState, FilePicker, Hint, Note, formatBytes, formatTime } from '@/components/ui';
import { translationCoverage } from '@/lesson/translation';
import type { Lesson } from '@/types/models';

/** 每个 tab 的前提。缺了它点进去只会看到一句「这里还不能用」。 */
function readiness(
  lesson: Lesson,
  tab: (typeof PRACTICE_TABS)[number],
): { ready: boolean; why: string } {
  const usable = lesson.sentences.filter((s) => !s.excluded);
  const timed = usable.filter((s) => s.startTime !== undefined);
  const dictatable = usable.filter((s) => s.blanks.length > 0 && s.startTime !== undefined);
  const blanks = usable.reduce((sum, s) => sum + s.blanks.length, 0);

  switch (tab) {
    case 'listen':
      return timed.length > 0
        ? { ready: true, why: `${timed.length}/${usable.length} 句有时间戳，跟着音频高亮` }
        : { ready: false, why: '还没有时间戳 —— 展开只是一份静态文本' };
    case 'shadowing':
      return timed.length > 0
        ? { ready: true, why: `可循环 ${timed.length} 句` }
        : { ready: false, why: '还没有时间戳 —— 句子没有可播的区间' };
    case 'study':
      return { ready: true, why: blanks > 0 ? `已挖空 ${blanks} 处` : '还没标过生词' };
    case 'dictation':
      return dictatable.length > 0
        ? { ready: true, why: `${dictatable.length} 句可听写` }
        : { ready: false, why: '需要「有时间戳 + 有挖空」的句子，去「学词」标几个词' };
  }
}

export function LessonPage({ lessonId, tab }: { lessonId: string; tab: LessonTab }) {
  const lesson = useLessonStore((s) => s.lessons.find((l) => l.id === lessonId));
  const cache = useLessonStore((s) => s.caches[lessonId]);
  const loaded = useLessonStore((s) => s.loaded);
  const menuRef = useRef<HTMLDetailsElement>(null);

  if (!loaded) return <EmptyState>加载中…</EmptyState>;
  if (!lesson) return <EmptyState>找不到这一课。它可能已被删除。</EmptyState>;

  // 「⋯」里的两页（切句 / 译文）都是一次性的准备工作：不占 tab 条，进去给一条明确的返回。
  const aside = tab === 'sentences' || tab === 'translation';
  const coverage = translationCoverage(lesson.sentences);

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <div className="flex items-start gap-2">
          <h1 className="min-w-0 flex-1 text-title font-semibold">{lesson.title}</h1>

          <details ref={menuRef} className="relative shrink-0">
            <summary
              aria-label="这一课的更多操作"
              className="flex size-11 cursor-pointer list-none items-center justify-center rounded-ctl text-muted hover:bg-sunken hover:text-ink"
            >
              <span aria-hidden className="text-title leading-none">
                ⋯
              </span>
            </summary>
            <div className="fixed inset-0 z-40" onClick={() => menuRef.current?.removeAttribute('open')} />
            <div className="absolute right-0 z-50 mt-1 w-60 overflow-hidden rounded-box border border-line bg-raised shadow-lg">
              <a
                href={href({ name: 'lesson', lessonId, tab: 'sentences' })}
                onClick={() => menuRef.current?.removeAttribute('open')}
                className={`block px-4 py-3 text-ui hover:bg-sunken ${tab === 'sentences' ? 'text-accent' : 'text-ink'}`}
              >
                切句
                <span className="block text-note text-faint">
                  {lesson.sentences.length} 句 · 合并、拆分、排除非朗读段落
                </span>
              </a>
              <a
                href={href({ name: 'lesson', lessonId, tab: 'translation' })}
                onClick={() => menuRef.current?.removeAttribute('open')}
                className={`block px-4 py-3 text-ui hover:bg-sunken ${tab === 'translation' ? 'text-accent' : 'text-ink'}`}
              >
                译文
                <span className="block text-note text-faint">
                  {coverage.translated > 0
                    ? `${coverage.total} 句里 ${coverage.translated} 句有中文`
                    : '在外面译好，按编号粘回来'}
                </span>
              </a>
              <a
                href={href({ name: 'cache' })}
                onClick={() => menuRef.current?.removeAttribute('open')}
                className="block px-4 py-3 text-ui text-ink hover:bg-sunken"
              >
                素材
                <span className="block text-note text-faint">
                  {lesson.audioDuration ? `音频 ${formatTime(lesson.audioDuration, 0)}` : '没有音频'}
                  {cache?.audioBytes ? ` · ${formatBytes(cache.audioBytes)}` : ''}
                </span>
              </a>
            </div>
          </details>
        </div>

        {/* FR-6.4 的「已标注 N / M」在这里：它现在说的是自动对齐的覆盖率与可疑句数。 */}
        <AlignStatus lesson={lesson} />
      </header>

      {isMaterialMissing(cache) && <MissingMaterialBanner lessonId={lessonId} />}

      {aside ? (
        // 这两页不在 tab 条里（都是一次性的准备工作），所以给一条明确的返回。
        <>
          <Note tone="accent" action={<a className="underline" href={href({ name: 'lesson', lessonId, tab: 'listen' })}>回到通听</a>}>
            {tab === 'sentences'
              ? '切句是一次性的准备工作 —— 改完就不用再来。'
              : '译文贴一次就够 —— 之后它跟着这一课同步到别的设备。'}
          </Note>
          {tab === 'sentences' ? (
            <SentencesTab lesson={lesson} cache={cache} />
          ) : (
            <TranslationTab lesson={lesson} cache={cache} />
          )}
        </>
      ) : (
        <>
          <nav className="flex gap-1 border-b border-line">
            {PRACTICE_TABS.map((t) => {
              const { ready, why } = readiness(lesson, t);
              const active = t === tab;
              return (
                <a
                  key={t}
                  href={href({ name: 'lesson', lessonId, tab: t })}
                  title={why}
                  aria-current={active ? 'page' : undefined}
                  className={`-mb-px flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-ui ${
                    active
                      ? 'border-accent text-ink'
                      : 'border-transparent text-muted hover:text-ink'
                  }`}
                >
                  {LESSON_TAB_LABELS[t]}
                  <span
                    aria-hidden
                    className={`size-1.5 rounded-full ${ready ? 'bg-accent' : 'bg-warn'}`}
                  />
                </a>
              );
            })}
          </nav>

          {tab === 'listen' && <ListenTab lesson={lesson} cache={cache} />}
          {tab === 'shadowing' && <ShadowingTab lesson={lesson} cache={cache} />}
          {tab === 'study' && <StudyTab lesson={lesson} cache={cache} />}
          {tab === 'dictation' && <DictationTab lesson={lesson} cache={cache} />}
        </>
      )}
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
 *
 * 它是「拦路」那一档（§12.3）：这一页现在真的做不了，所以有底色、有标题、有出口。
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
    <Banner
      tone="warn"
      title={busy ? '正在补齐素材…' : '素材未下载 —— 播放相关的功能全部不可用'}
      action={
        <>
          <FilePicker accept="audio/*" onPick={(file) => void pickAudio(file)}>
            选本地音频文件…
          </FilePicker>
          {rehydratable && !needsDecision && (
            <Button disabled={busy} onClick={() => void rehydrate()}>
              {busy ? '补齐中…' : '重新抓取'}
            </Button>
          )}
          {needsDecision && <Button onClick={() => navigate({ name: 'sources' })}>去「来源」页处理</Button>}
        </>
      }
    >
      <p>
        {busy
          ? '照标注层里记着的下载地址重新抓页面和音频（6~10MB）。'
          : rehydratable
            ? '这一课来自 DW，可以按 lesson id 重新抓取。'
            : '这一课是手动导入的，无法自动补齐，需要重新选择本地音频文件。'}
      </p>
      {message && <Hint tone="warn">{message}</Hint>}
    </Banner>
  );
}
