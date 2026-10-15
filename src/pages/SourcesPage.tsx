// FR-13：来源与自动导入。三层降级都在这一页上，而且**互不依赖**：
//   L1 选来源 → 看期次列表 → 导入
//   L2 粘贴 URL 或裸 lesson id
//   L3 去手动导入（永不删除的地板）
// DW 改版会打掉 L1/L2，那时 L3 的按钮仍然在这里，指向的代码路径一行都没变。

import { useEffect, useState, useRef } from 'react';
import { navigate } from '@/app/router';
import { getMeta, putMeta } from '@/db/meta';
import { SOURCES, type SourceDefinition } from '@/sources/registry';
import { fetchCourse, fetchFeed, parseLessonId, type FeedItem } from '@/sources/dw/adapter';
import { acceptNewManuscript, importFromDw, rehydrateLesson, type ImportProgress } from '@/sources/importLesson';
import { backfillRecent, BACKFILL_LIMITS, SEASON_IMPORT_MAX, type BackfillProgress } from '@/sources/backfill';
import { queueLessonTranslation } from '@/ai/translate';
import { ChunkTabs, CHUNK_SIZE } from '@/components/ChunkTabs';
import { useLessonStore, isMaterialMissing } from '@/state/useLessonStore';
import { useAlignStore } from '@/state/useAlignStore';
import { hasTimings } from '@/align/apply';
import { Banner, Button, Chip, Disclosure, EmptyState, Hint, Note, Section, field, formatBytes } from '@/components/ui';
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
      const items = source.courseUrl ? await fetchCourse(source.courseUrl) : await fetchFeed(source.feedUrl ?? '');
      const cached = { items, fetchedAt: Date.now() };
      await putMeta(feedCacheKey(source.id), cached);
      setFeed(cached);
    } catch (err) {
      // FR-13.9：说清楚失败在哪一步，并且保留已缓存的列表
      setError(`拉取列表失败：${err instanceof Error ? err.message : err}。已缓存的列表仍可用。`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="hidden text-title font-semibold sm:block">来源</h1>

      <RehydratePanel />

      <Section title="订阅列表" aside={<Button disabled={loading} onClick={() => void refresh()}>{loading ? '拉取中…' : '刷新列表'}</Button>}>
        <div className="flex flex-wrap gap-2">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              onClick={() => setSource(s)}
              className={`rounded-ctl px-3 py-1.5 text-ui ${
                s.id === source.id ? 'bg-accent text-accent-ink' : 'border border-line-strong'
              }`}
            >
              {s.name}
              <span className="ml-2 text-note opacity-70">{s.level}</span>
            </button>
          ))}
        </div>
        {source.note && <Hint>{source.note}</Hint>}
        {error && <Note tone="danger">{error}</Note>}

        {feed ? (
          <>
            <Hint>
              抓取于 {new Date(feed.fetchedAt).toLocaleString('zh-CN', { hour12: false })} · {feed.items.length} 期
            </Hint>
            <FeedList items={feed.items} source={source} importedIds={importedIds} />
            <BackfillPanel items={feed.items} importedIds={importedIds} source={source} />
          </>
        ) : (
          <EmptyState>还没有列表。点「刷新列表」拉一次。</EmptyState>
        )}
      </Section>

      <ManualIdSection />

      <Section title="教材">
        <Hint>
          应用里不带教材内容。把自己那本的 Transkript（PDF 里全选复制）整份粘进来，按题切成一课一课，再选上对应的音频。
        </Hint>
        <Button onClick={() => navigate({ name: 'import-book' })}>导入整本教材</Button>
      </Section>

      <Section title="完全手动">
        <Hint>
          粘贴文本 + 选本地文件。教材音频、DW 改版之后都走这条 —— 它不依赖上面任何一层，永远可用。
        </Hint>
        <Button onClick={() => navigate({ name: 'import' })}>去手动导入</Button>
      </Section>
    </div>
  );
}

/**
 * 导入进度的一行文案。全是秒级的步骤 —— 自动对齐（几分钟）**不在这里**，
 * 它排进 useAlignStore 的队列，进度常驻在应用底部，切页面也看得见。
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
    default:
      return '完成';
  }
}

/**
 * 剧集（课程页列表，变更 81）按季折叠：一百多集平铺着，「下一集在哪」要滚好几屏才找得到。
 * 默认只展开「还有没导的」第一季 —— 那里就是接着往下看的地方。RSS 列表没有季，照旧平铺。
 * 季里面再按 11 集一页（变更 82 / §12.22），默认翻到这一季第一集没导的那一页。
 */
function FeedList({ items, source, importedIds }: { items: FeedItem[]; source: SourceDefinition; importedIds: ReadonlySet<string> }) {
  const row = (item: FeedItem) => (
    <FeedRow key={item.lessonId} item={item} source={source} imported={importedIds.has(item.lessonId)} />
  );
  const seasons = new Map<string, FeedItem[]>();
  for (const item of items) {
    if (!item.group) return <ul className="divide-y divide-line">{items.map(row)}</ul>;
    seasons.set(item.group, [...(seasons.get(item.group) ?? []), item]);
  }
  const current = items.find((i) => !importedIds.has(i.lessonId))?.group;
  return (
    <div className="space-y-2">
      {[...seasons.entries()].map(([season, list]) => (
        <Disclosure
          key={season}
          summary={`${season} · 已导 ${list.filter((i) => importedIds.has(i.lessonId)).length}/${list.length}`}
          defaultOpen={season === current}
        >
          <SeasonImport items={list} importedIds={importedIds} source={source} />
          <ChunkTabs
            items={list}
            defaultIndex={Math.floor(Math.max(0, list.findIndex((i) => !importedIds.has(i.lessonId))) / CHUNK_SIZE)}
          >
            {(page) => <ul className="divide-y divide-line">{page.map(row)}</ul>}
          </ChunkTabs>
        </Disclosure>
      ))}
    </div>
  );
}

function FeedRow({ item, source, imported }: { item: FeedItem; source: SourceDefinition; imported: boolean }) {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const enqueueAlign = useAlignStore((s) => s.enqueue);

  const run = async () => {
    setResult(null);
    try {
      const outcome = await importFromDw(item.lessonId, setProgress, item.link || undefined, source.name, item.group);
      // FR-15：音频一到位就立刻排对齐 —— 「下载完就能直接练」是它存在的理由。
      // 不等它跑完：几分钟的活儿不该把导入按钮和这一页钉在原地。
      if (outcome.hasAudio) enqueueAlign(outcome.lessonId);
      // 变更 82：中译同理，排进后台队列，没登录就静默不做
      if (source.autoTranslate) void queueLessonTranslation([outcome.lessonId]);
      const notes = [
        outcome.audioError ? `音频没抓到（${outcome.audioError}），文本已导入，可稍后补齐或手动选文件` : null,
      ].filter(Boolean);
      setResult(notes.length > 0 ? notes.join('；') : '导入成功，正在自动对齐（进度在页面底部）');
      if (notes.length === 0) {
        navigate({ name: 'lesson', lessonId: outcome.lessonId, tab: 'sentences' });
      }
    } catch (err) {
      setResult(`导入失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setProgress(null);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-3 py-2 text-ui">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{item.title}</p>
        <p className="text-note text-muted">
          {item.subtitle ? `${item.subtitle} · ` : ''}
          {item.durationText ?? (item.subtitle ? '' : '时长未知')}
          {item.enclosureBytes ? ` · ${formatBytes(item.enclosureBytes)}` : ''}
          {' · id '}
          {item.lessonId}
        </p>
        {progress && <p className="text-note text-accent">{importProgressText(progress)}</p>}
        {result && <p className="text-note text-warn">{result}</p>}
      </div>
      {/* FR-13.8：按 lesson id 判断已导入，不用带 ?maca= 的 link */}
      {imported ? (
        <Chip tone="ok">已导入</Chip>
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
  const enqueueAlign = useAlignStore((s) => s.enqueue);

  const run = async () => {
    const lessonId = parseLessonId(input);
    if (!lessonId) {
      setMessage('认不出 lesson id。粘贴形如 …/l-45334084 的地址，或直接粘数字 id。');
      return;
    }
    setMessage(null);
    try {
      const outcome = await importFromDw(lessonId, setProgress);
      if (outcome.hasAudio) enqueueAlign(outcome.lessonId);
      navigate({ name: 'lesson', lessonId: outcome.lessonId, tab: 'sentences' });
    } catch (err) {
      setMessage(`导入失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setProgress(null);
    }
  };

  return (
    <Section title="按地址或 id 导入">
      <Hint>RSS 只给最近 100 期。更老的期次把页面地址或 lesson id 粘到这里。</Hint>
      <div className="flex flex-wrap gap-2">
        <input
          className={`${field} min-w-72 flex-1 px-3 py-2`}
          placeholder="https://learngerman.dw.com/de/…/l-45334084 或 45334084"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <Button variant="primary" disabled={progress !== null} onClick={() => void run()}>
          {progress ? '导入中…' : '导入'}
        </Button>
      </div>
      {progress && <p className="text-note text-accent">{importProgressText(progress)}</p>}
      {message && <Note tone="danger">{message}</Note>}
    </Section>
  );
}

/** FR-3.5：本机缺素材的 DW 课程，在这里一键补齐。手机导入备份后走的就是这条路。 */
function RehydratePanel() {
  const { lessons, caches } = useLessonStore();
  const enqueueAlign = useAlignStore((s) => s.enqueue);
  const phone = useAlignStore((s) => s.phone);
  const remote = useAlignStore((s) => s.remote);
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
      } else if (!hasTimings(lesson.sentences) || outcome.audioChanged) {
        // **不再无条件重对**（§0 变更 34）。以前这里的理由是「补齐等于刚下载完，
        // 时间戳可能因为换过音频而全部作废，重对一遍最省心」—— 那条理由在同步落地之后
        // 站不住了：常态是「桌面算完 → 手机补齐素材」，标注层里那份时间戳正是桌面刚算出来的，
        // 而重算一遍算完还盖回同样的值（手机上没有服务器时被闸门挡住，其余情况会真跑）。
        // 真会让时间戳作废的是音频变了，那件事有时长可比。
        enqueueAlign(lesson.id);
        setMessage(
          phone && !remote
            ? `《${lesson.title}》素材已补齐。这一课还没有时间戳 —— 手机上不自己算对齐，登录同步后由服务器算，或者在桌面上对一次会同步回来。`
            : `《${lesson.title}》素材已补齐，正在自动对齐（进度在页面底部）。`,
        );
      } else {
        setMessage(`《${lesson.title}》素材已补齐。时间戳是同步来的，不用重对。`);
      }
    } catch (err) {
      setMessage(`补齐失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section title={`素材未下载（${missing.length}）`}>
      <Hint>标注层里有这些课，本机没有音频。DW 来源可以重新抓取，标注不受影响。</Hint>
      {message && <Note tone="ok">{message}</Note>}

      {conflict && (
        // FR-3.7：不能静默接受。这是「静默数据损坏」类风险，必须在补齐时就拦住。
        <Banner
          tone="danger"
          title={`DW 改过《${conflict.lesson.title}》的稿 —— 正文要你选一条路`}
          action={
            <>
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
            </>
          }
        >
          <p>文稿与本机记录的 hash 不一致，时间戳与挖空的 offset 可能全部失效。音频已经补齐。</p>
        </Banner>
      )}

      <ul className="divide-y divide-line">
        {missing.map((lesson) => (
          <li key={lesson.id} className="flex items-center gap-3 py-2 text-ui">
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

/**
 * 一批串行导入（「往下导 N 集」与「导入这一季」共用）。每导完一集就排对齐、
 * 该来源要中译就排中译 —— 不等整批结束：整季 33 集要十几分钟，导完一集就该能开始练那一集。
 */
function useBatchImport(source: SourceDefinition) {
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const stopRef = useRef(false);
  const enqueueAlign = useAlignStore((s) => s.enqueue);
  const unit = source.courseUrl ? '集' : '期';

  const run = async (items: FeedItem[], importedIds: ReadonlySet<string>, limit: number) => {
    stopRef.current = false;
    setResult(null);
    const pending = items.filter((i) => !importedIds.has(i.lessonId)).length;
    setProgress({ index: 0, total: Math.min(limit, pending), title: '' });
    const outcome = await backfillRecent({
      items,
      importedIds,
      limit,
      series: source.name,
      onProgress: setProgress,
      shouldStop: () => stopRef.current,
      importOne: async (...args) => {
        const one = await importFromDw(...args);
        // FR-15：与逐期导入同一条规矩 —— 音频到位就排对齐（变更 81 以前回填漏了这一步）
        if (one.hasAudio) enqueueAlign(one.lessonId);
        if (source.autoTranslate) void queueLessonTranslation([one.lessonId]);
        return one;
      },
    });
    setProgress(null);
    const parts = [`导入 ${outcome.imported.length} ${unit}`];
    if (outcome.withoutAudio.length) parts.push(`其中 ${outcome.withoutAudio.length} ${unit}没拿到音频（课程已建，可稍后补齐）`);
    if (outcome.failed.length) parts.push(`${outcome.failed.length} ${unit}失败：${outcome.failed.map((f) => f.title).join('、')}`);
    if (outcome.stopped) parts.push('（你停下的）');
    setResult(parts.join('，') + '。');
  };

  const status = progress && (
    <>
      <span className="text-ui text-muted">
        第 {progress.index}/{progress.total} {unit}
        {progress.step ? `（${{ page: '取文稿', audio: '取音频', saving: '落库', done: '完成' }[progress.step]}）` : ''}
        {progress.title ? ` · ${progress.title.slice(0, 28)}` : ''}
      </span>
      <Button variant="danger" onClick={() => { stopRef.current = true; }}>
        停
      </Button>
    </>
  );

  return { busy: progress !== null, result, run, status, unit };
}

/**
 * 变更 82：剧集一季一键导完。他按 33 集一个阶段学 —— 「往下导 10 集」点三次再补三集是纯摩擦。
 * 与 R-3 的关系写在 `src/sources/backfill.ts` 头部「整季导入」一段。
 */
function SeasonImport({ items, importedIds, source }: { items: FeedItem[]; importedIds: ReadonlySet<string>; source: SourceDefinition }) {
  const batch = useBatchImport(source);
  const pending = items.filter((i) => !importedIds.has(i.lessonId)).length;
  if (!source.courseUrl || items.length > SEASON_IMPORT_MAX) return null;
  if (pending === 0 && !batch.result) return null;
  return (
    <div className="mb-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {pending > 0 && (
          <Button variant="primary" disabled={batch.busy} onClick={() => void batch.run(items, importedIds, pending)}>
            {pending === items.length ? `导入这一季 ${pending} 集` : `导入这一季剩下的 ${pending} 集`}
          </Button>
        )}
        {batch.status}
      </div>
      {!batch.busy && pending > 0 && (
        <Hint>
          一集一集串行地导，导一集十来秒；导完的那一集马上开始对齐{source.autoTranslate ? '、加中译（要登录同步）' : ''}。
          可以随时停，停在集与集之间。
        </Hint>
      )}
      {batch.result && <Hint tone="ok">{batch.result}</Hint>}
    </div>
  );
}

/**
 * FR-13.12：回填最近几期。冷启动用 —— 一次导几期旧刊，
 * 它们的 Glossar 候选词（FR-14）就是一批**带真语料**的生词：
 * 有德德释义、有语境句、有真人朗读。FR-17 的预置词库这三样都给不了。
 *
 * **与 R-3 的关系写在 `src/sources/backfill.ts` 头部**，不在这里重复。
 * 界面上只需要三件事到位：期数有上限且没有「全部」、能停、进度看得见。
 */
function BackfillPanel({
  items,
  importedIds,
  source,
}: {
  items: FeedItem[];
  importedIds: ReadonlySet<string>;
  source: SourceDefinition;
}) {
  const batch = useBatchImport(source);
  /** 剧集：列表是播出顺序，「回填最近几期」其实是「接着往下导几集」（变更 81） */
  const serial = Boolean(source.courseUrl);
  const pending = items.filter((i) => !importedIds.has(i.lessonId)).length;

  if (pending === 0) {
    return <Hint>列表里的{serial ? '集数' : '期次'}都已经导入过了。</Hint>;
  }

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="text-ui">
        <b>{serial ? '接着往下导' : '回填最近几期'}</b>
        <span className="ml-2 text-muted">
          列表里还有 {pending} {batch.unit}没导入
        </span>
      </p>
      <Hint>
        每期的 Glossar 候选词能一键接受成生词，那些词带释义、带语境句、带真人朗读。
        不接受候选词的话，导入本身不往生词本里加任何东西。
      </Hint>
      <div className="flex flex-wrap items-center gap-2">
        {BACKFILL_LIMITS.map((n) => (
          <Button key={n} disabled={batch.busy} onClick={() => void batch.run(items, importedIds, n)}>
            {serial ? `往下导 ${n} 集` : `回填 ${n} 期`}
          </Button>
        ))}
        {batch.status}
      </div>
      <Disclosure summary="它到底会做什么">
        <p className="text-note text-muted">
          串行、每次出网间隔 ≥ 1 秒，只从上面这份已拉到的列表里取 —— 不翻页、不爬归档。
          <b>没有「全部」这个选项</b>，最多 {Math.max(...BACKFILL_LIMITS)} {batch.unit}
          {serial ? '；整季导入在每一季里面，一次只导一季' : ''}。
          「停」会停在期与期之间，不留半篇课程。
        </p>
      </Disclosure>
      {batch.result && <Hint tone="ok">{batch.result}</Hint>}
    </div>
  );
}
