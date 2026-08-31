// FR-13：来源与自动导入。三层降级都在这一页上，而且**互不依赖**：
//   L1 选来源 → 看期次列表 → 导入
//   L2 粘贴 URL 或裸 lesson id
//   L3 去手动导入（永不删除的地板）
// DW 改版会打掉 L1/L2，那时 L3 的按钮仍然在这里，指向的代码路径一行都没变。

import { useEffect, useState } from 'react';
import { navigate } from '@/app/router';
import { getMeta, putMeta } from '@/db/meta';
import { SOURCES, type SourceDefinition } from '@/sources/registry';
import { fetchFeed, parseLessonId, type FeedItem } from '@/sources/dw/adapter';
import { acceptNewManuscript, importFromDw, rehydrateLesson, type ImportProgress } from '@/sources/importLesson';
import { useLessonStore, isMaterialMissing } from '@/state/useLessonStore';
import { Banner, Button, EmptyState, Hint, Section, formatBytes } from '@/components/ui';
import type { Lesson } from '@/types/models';
import type { DwLesson } from '@/sources/dw/adapter';

interface CachedFeed {
  items: FeedItem[];
  fetchedAt: number;
}

const feedCacheKey = (sourceId: string) => `feedCache:${sourceId}`;

export function SourcesPage() {
  const [source, setSource] = useState<SourceDefinition>(SOURCES[0]);
  const [feed, setFeed] = useState<CachedFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lessons = useLessonStore((s) => s.lessons);
  const importedIds = new Set(
    lessons.map((l) => (l.source.type === 'dw' ? l.source.dwLessonId : '')).filter(Boolean),
  );

  // FR-13.2：列表缓存进 IndexedDB，离线也能看，并显示「抓取于 X」。
  useEffect(() => {
    setFeed(null);
    setError(null);
    void getMeta<CachedFeed>(feedCacheKey(source.id)).then((cached) => cached && setFeed(cached));
  }, [source.id]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await fetchFeed(source.feedUrl);
      const cached = { items, fetchedAt: Date.now() };
      await putMeta(feedCacheKey(source.id), cached);
      setFeed(cached);
    } catch (err) {
      // FR-13.9：说清楚失败在哪一步，并且保留已缓存的列表
      setError(`拉取 RSS 失败：${err instanceof Error ? err.message : err}。已缓存的列表仍可用。`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">来源</h1>

      <RehydratePanel />

      <Section title="L1 全自动" aside={<Button disabled={loading} onClick={() => void refresh()}>{loading ? '拉取中…' : '刷新列表'}</Button>}>
        <div className="flex flex-wrap gap-2">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              onClick={() => setSource(s)}
              className={`rounded px-3 py-1.5 text-sm ${
                s.id === source.id ? 'bg-neutral-800 text-white' : 'border border-neutral-300'
              }`}
            >
              {s.name}
              <span className="ml-2 text-xs opacity-70">{s.level}</span>
            </button>
          ))}
        </div>
        {source.note && <Hint>{source.note}</Hint>}
        {error && <Banner tone="warn">{error}</Banner>}

        {feed ? (
          <>
            <Hint>
              抓取于 {new Date(feed.fetchedAt).toLocaleString('zh-CN', { hour12: false })} · {feed.items.length} 期
            </Hint>
            <ul className="divide-y divide-neutral-100">
              {feed.items.map((item) => (
                <FeedRow key={item.lessonId} item={item} imported={importedIds.has(item.lessonId)} />
              ))}
            </ul>
            {/* R-3 / FR-13.10：没有「一键导入全部」。既是礼貌，也是防止灌进 100 期后一篇不学。 */}
            <Hint>一次导入一期。没有批量导入 —— 那既不礼貌，也不会让你多学一篇。</Hint>
          </>
        ) : (
          <EmptyState>还没有列表。点「刷新列表」拉一次 RSS。</EmptyState>
        )}
      </Section>

      <ManualIdSection />

      <Section title="L3 手动（地板）">
        <Hint>
          DW 改版、教材音频、任何非 DW 素材都走这条路：粘贴文本 + 选本地文件。
          它不依赖上面任何一层的代码，永远可用。
        </Hint>
        <Button onClick={() => navigate({ name: 'import' })}>去手动导入</Button>
      </Section>
    </div>
  );
}

/**
 * 导入进度的一行文案。align 阶段单独拎出来是因为它是这里唯一**长耗时**的一步：
 * 抓页面和下音频都是秒级，自动打点在 WASM 后端可能要几分钟，
 * 不给子进度的话看起来就像卡死了。
 */
function importProgressText(progress: ImportProgress): string {
  switch (progress.step) {
    case 'page':
      return '抓取页面…';
    case 'audio':
      return `下载音频 ${
        progress.total
          ? `${Math.round(((progress.loaded ?? 0) / progress.total) * 100)}%`
          : formatBytes(progress.loaded ?? 0)
      }`;
    case 'saving':
      return '写入本地…';
    case 'align': {
      const a = progress.align;
      if (!a) return '自动打点…';
      if (a.stage === 'model') {
        return a.total
          ? `自动打点 · 下载模型 ${Math.round(((a.loaded ?? 0) / a.total) * 100)}%`
          : '自动打点 · 加载模型…';
      }
      const label = a.stage === 'infer' ? '识别音频' : '对齐文本';
      return `自动打点 · ${label} ${Math.round((a.fraction ?? 0) * 100)}%`;
    }
    default:
      return '完成';
  }
}

function FeedRow({ item, imported }: { item: FeedItem; imported: boolean }) {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const run = async () => {
    setResult(null);
    try {
      const outcome = await importFromDw(item.lessonId, setProgress, item.link || undefined);
      const notes = [
        outcome.audioError ? `音频没抓到（${outcome.audioError}），文本已导入，可稍后补齐或手动选文件` : null,
        outcome.teaserNeedsReview ? '开头的 teaser 块与 teaser 对不上，没有自动排除，请在「切句」里确认' : null,
        // FR-15：打点失败不算导入失败，但一定要说出来 —— 否则你会以为可以直接开始跟读。
        outcome.alignError ? `自动打点失败（${outcome.alignError}），去「标注」里手动打点或重试` : null,
      ].filter(Boolean);
      const ok = outcome.aligned !== undefined ? `导入成功，自动打点 ${outcome.aligned} 句（待校对）` : '导入成功';
      setResult(notes.length > 0 ? notes.join('；') : ok);
      // 打点过就直接进「标注」页校对；没打点则照旧先去「切句」。
      if (notes.length === 0) {
        navigate({
          name: 'lesson',
          lessonId: outcome.lessonId,
          tab: outcome.aligned !== undefined ? 'timestamps' : 'sentences',
        });
      }
    } catch (err) {
      setResult(`导入失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setProgress(null);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{item.title}</p>
        <p className="text-xs text-neutral-500">
          {item.durationText ?? '时长未知'}
          {item.enclosureBytes ? ` · ${formatBytes(item.enclosureBytes)}` : ''}
          {' · id '}
          {item.lessonId}
        </p>
        {progress && <p className="text-xs text-sky-700">{importProgressText(progress)}</p>}
        {result && <p className="text-xs text-amber-700">{result}</p>}
      </div>
      {/* FR-13.8：按 lesson id 判断已导入，不用带 ?maca= 的 link */}
      {imported ? (
        <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">已导入</span>
      ) : (
        <Button disabled={progress !== null} onClick={() => void run()}>
          {progress ? '导入中…' : '导入'}
        </Button>
      )}
    </li>
  );
}

/** FR-13 L2：RSS 只给 100 期窗口，存档期次靠粘 URL 或裸 id 进来（Q7）。 */
function ManualIdSection() {
  const [input, setInput] = useState('');
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async () => {
    const lessonId = parseLessonId(input);
    if (!lessonId) {
      setMessage('认不出 lesson id。粘贴形如 …/l-45334084 的地址，或直接粘数字 id。');
      return;
    }
    setMessage(null);
    try {
      const outcome = await importFromDw(lessonId, setProgress);
      navigate({ name: 'lesson', lessonId: outcome.lessonId, tab: 'sentences' });
    } catch (err) {
      setMessage(`导入失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setProgress(null);
    }
  };

  return (
    <Section title="L2 半自动（存档期次）">
      <Hint>RSS 只给最近 100 期。更老的期次把页面地址或 lesson id 粘到这里。</Hint>
      <div className="flex flex-wrap gap-2">
        <input
          className="min-w-72 flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
          placeholder="https://learngerman.dw.com/de/…/l-45334084 或 45334084"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <Button variant="primary" disabled={progress !== null} onClick={() => void run()}>
          {progress ? '导入中…' : '导入'}
        </Button>
      </div>
      {progress && <p className="text-xs text-sky-700">{importProgressText(progress)}</p>}
      {message && <Banner tone="warn">{message}</Banner>}
    </Section>
  );
}

/** FR-3.5：本机缺素材的 DW 课程，在这里一键补齐。手机导入备份后走的就是这条路。 */
function RehydratePanel() {
  const { lessons, caches } = useLessonStore();
  const missing = lessons.filter((l) => l.source.type === 'dw' && isMaterialMissing(caches[l.id]));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ lesson: Lesson; dw: DwLesson } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (missing.length === 0 && !conflict) return null;

  const run = async (lesson: Lesson) => {
    setBusyId(lesson.id);
    setMessage(null);
    try {
      const outcome = await rehydrateLesson(lesson);
      if (outcome.manuscriptChanged && outcome.fresh) {
        setConflict({ lesson, dw: outcome.fresh.dw });
      } else if (outcome.audioError) {
        setMessage(`《${lesson.title}》的音频没抓到：${outcome.audioError}`);
      } else {
        setMessage(`《${lesson.title}》素材已补齐。`);
      }
    } catch (err) {
      setMessage(`补齐失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section title={`素材未下载（${missing.length}）`}>
      <Hint>标注层里有这些课，本机没有素材。DW 来源可以按 lesson id 重新抓取，标注不受影响。</Hint>
      {message && <Banner tone="info">{message}</Banner>}

      {conflict && (
        // FR-3.7：不能静默接受。这是「静默数据损坏」类风险，必须在补齐时就拦住。
        <Banner tone="error">
          <p className="font-medium">《{conflict.lesson.title}》的文稿与本机记录的 hash 不一致 —— DW 改过稿。</p>
          <p className="mt-1">
            时间戳与挖空的 offset 可能全部失效。音频已经补齐，但正文要你选一条路：
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              onClick={() => {
                void acceptNewManuscript(conflict.lesson, conflict.dw).then((result) => {
                  setMessage(
                    `已按新文稿重切：${result.sentences.length} 句，沿用 ${result.carriedOver.size} 处标注` +
                      (result.orphaned.length > 0 ? `，${result.orphaned.length} 处对不上已丢弃` : ''),
                  );
                });
                setConflict(null);
              }}
            >
              按新文稿重切（保留能匹配上的标注）
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConflict(null);
                setMessage('保留旧标注。本机正文仍是旧版，请自行核对时间戳是否还对得上。');
              }}
            >
              保留旧标注，自行核对
            </Button>
          </div>
        </Banner>
      )}

      <ul className="divide-y divide-neutral-100">
        {missing.map((lesson) => (
          <li key={lesson.id} className="flex items-center gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1">{lesson.title}</span>
            <Button disabled={busyId !== null} onClick={() => void run(lesson)}>
              {busyId === lesson.id ? '补齐中…' : '补齐素材'}
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
