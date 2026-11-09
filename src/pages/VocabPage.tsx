// 单词页（变更 84 / §12.21）：今日卡片 → 查词 → 「词库」折叠块。
//
// 以前这一页是 FR-9 生词本：一张张 VocabEntry 的列表，配编辑 / 暂停 / 问 AI。
// 变更 84 起复习整个撤掉，背词只剩一条路 —— 每天 200 个的速背（FR-22.13~17），
// 所以这一页只回答三件事：今天还剩几个、这个词什么意思、词库里有什么。
// 旧的 VocabEntry 数据没删，迁进了速背（见 src/drill/migrate.ts），这里不再展示。

import { useEffect, useMemo, useState } from 'react';
import { navigate } from '@/app/router';
import { useDrillToday } from '@/drill/useDrillToday';
import { updateDrillState, withMark, withPrefs } from '@/drill/state';
import { buildPool, countByCategory } from '@/drill/wordbank';
import { CATEGORY_LABELS, type CachedWordbank, type DrillCategory, type DrillState, type PoolItem } from '@/drill/types';
import { scheduleDrillSync } from '@/sync/trigger';
import { Button, Disclosure, EmptyState, Note, field } from '@/components/ui';
import { DictLookup } from './vocab/DictLookup';
import { drillArticled } from './drill/DrillCard';

const CATEGORIES: DrillCategory[] = ['daily', 'work', 'it', 'mine'];

async function update(fn: (s: DrillState) => DrillState): Promise<DrillState> {
  const next = await updateDrillState(fn);
  scheduleDrillSync();
  return next;
}

export function VocabPage() {
  const today = useDrillToday();
  if (!today.loaded || !today.state) return <EmptyState>加载中…</EmptyState>;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="hidden text-title font-semibold sm:block">单词</h1>
      <TodayCard
        total={today.progress?.total ?? Math.min(today.target, today.remaining)}
        done={today.progress?.done ?? 0}
        remaining={today.remaining}
        remainingReview={today.progress?.remainingReview}
        remainingNew={today.progress?.remainingNew}
        target={today.target}
        hasPool={today.pool.length > 0}
      />
      <DictLookup />
      <Library state={today.state} wordbank={today.wordbank} />
    </div>
  );
}

/** 今日卡片（FR-22.13）：`今天 x / 200` + 进度条 + 主按钮。做完了换成一句话。 */
export function TodayCard({
  total,
  done,
  remaining,
  remainingReview,
  remainingNew,
  target,
  hasPool,
}: {
  total: number;
  done: number;
  remaining: number;
  remainingReview?: number;
  remainingNew?: number;
  target: number;
  hasPool: boolean;
}) {
  if (!hasPool) {
    return (
      <Note tone="warn">词库还没下载（速背的词库放在同步服务器上，联网后会自动下载）。查过的词和课程里的词加进来之后也能背。</Note>
    );
  }
  const finished = done > 0 && remaining === 0;
  const denom = Math.max(total, 1);
  return (
    <section className="space-y-3 rounded-box border border-line bg-raised p-4" aria-label="今天">
      <div className="flex items-baseline gap-2">
        <span className="text-ui text-muted">今天</span>
        <span className="text-title font-semibold tnum">
          {done} / {total || target}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={denom} aria-valuenow={done}>
        <div className="h-full bg-accent" style={{ width: `${Math.round((done / denom) * 100)}%` }} />
      </div>
      {finished ? (
        <Note tone="ok">今天的 {total} 个背完了。明天再来。</Note>
      ) : (
        <>
          {remainingReview !== undefined && remainingNew !== undefined && (
            <p className="text-note text-faint tnum">
              到期复习 {remainingReview} · 新词 {remainingNew}
            </p>
          )}
          <Button variant="primary" className="w-full py-4 text-de" disabled={remaining === 0} onClick={() => navigate({ name: 'drill' })}>
            {done > 0 ? '继续' : '开始'}
          </Button>
        </>
      )}
    </section>
  );
}

/** 「词库」折叠块：范围、已标记、斩掉的、词库版本（FR-22.14 / 22.15 / 22.9）。 */
function Library({ state, wordbank }: { state: DrillState; wordbank: CachedWordbank | undefined }) {
  const counts = useMemo(() => countByCategory(wordbank, state), [wordbank, state]);
  const byId = useMemo(() => new Map(buildPool(wordbank, state, CATEGORIES).map((i) => [i.id, i])), [wordbank, state]);
  const { prefs } = state;

  const marked = (pick: (m: DrillState['marks'][string]) => boolean | undefined) =>
    Object.entries(state.marks)
      .filter(([, m]) => pick(m))
      .sort((a, b) => b[1].ts - a[1].ts)
      .map(([id]) => byId.get(id))
      .filter((x): x is PoolItem => Boolean(x));
  const flagged = marked((m) => m.flagged);
  const known = marked((m) => m.known);

  const toggleCategory = (c: DrillCategory) => {
    const has = prefs.categories.includes(c);
    const next = has ? prefs.categories.filter((x) => x !== c) : [...prefs.categories, c];
    if (next.length > 0) void update((s) => withPrefs(s, { categories: next }, Date.now()));
  };

  return (
    <Disclosure summary="词库">
      <div className="space-y-4">
        <div className="space-y-1">
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => {
              const on = prefs.categories.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleCategory(c)}
                  className={`rounded-full border px-3 py-1 text-ui ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'}`}
                >
                  {CATEGORY_LABELS[c]}（{counts[c]}）
                </button>
              );
            })}
          </div>
          <p className="text-note text-faint">新词从选中的范围里挑；已经排进今天的不变，明天起生效。</p>
        </div>

        {flagged.length > 0 && (
          <Disclosure summary={`已标记（${flagged.length}）`}>
            <ul className="divide-y divide-line rounded-box border border-line bg-raised">
              {flagged.map((item) => (
                <FlaggedRow key={item.id} item={{ ...item, zh: state.marks[item.id]?.zh?.trim() || item.zh }} />
              ))}
            </ul>
          </Disclosure>
        )}

        {known.length > 0 && (
          <Disclosure summary={`斩掉的（${known.length}）`}>
            <ul className="divide-y divide-line rounded-box border border-line bg-raised">
              {known.map((item) => (
                <li key={item.id} className="flex items-center gap-3 p-3">
                  <span className="min-w-24 text-de font-medium">{drillArticled(item)}</span>
                  <span className="min-w-0 flex-1 truncate text-ui text-muted">{item.zh}</span>
                  <Button variant="ghost" onClick={() => void update((s) => withMark(s, item.id, { known: false }, Date.now()))}>
                    撤回
                  </Button>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}

        <p className="text-note text-faint">
          {wordbank
            ? `词库 ${wordbank.items.length} 个词 · 版本 ${wordbank.version} · ${new Date(wordbank.fetchedAt).toLocaleString('zh-CN', { hour12: false })} 从服务器更新`
            : '词库还没下载（只有你自己加的词）'}
        </p>
      </div>
    </Disclosure>
  );
}

function FlaggedRow({ item }: { item: PoolItem }) {
  const [draft, setDraft] = useState(item.zh);
  useEffect(() => setDraft(item.zh), [item.zh]);
  const dirty = draft.trim() !== '' && draft.trim() !== item.zh;
  return (
    <li className="flex flex-wrap items-center gap-2 p-3">
      <span className="min-w-24 text-de font-medium">{drillArticled(item)}</span>
      <input
        className={`${field} min-w-0 flex-1 px-2 py-1`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={`${item.w} 的中文`}
      />
      <Button disabled={!dirty} onClick={() => void update((s) => withMark(s, item.id, { zh: draft.trim() }, Date.now()))}>
        保存
      </Button>
      <Button variant="ghost" onClick={() => void update((s) => withMark(s, item.id, { flagged: false }, Date.now()))}>
        取消标记
      </Button>
    </li>
  );
}
