// FR-9 生词本。
//
// FR-9.3 的去重降级发生在**新建时**（见 StudyTab 的 MarkPanel），这里只做管理：
// 编辑、删除、暂停复习、按课程/状态筛选。

import { useMemo, useState } from 'react';
import { href } from '@/app/router';
import { useLessonStore } from '@/state/useLessonStore';
import { needsGender, useVocabStore } from '@/state/useVocabStore';
import { Button, EmptyState, Hint } from '@/components/ui';
import type { VocabEntry } from '@/types/models';

const STATE_LABELS = ['新卡', '学习中', '复习中', '重学中'] as const;

export function VocabPage() {
  const { entries, updateEntry, removeEntry, loaded } = useVocabStore();
  const lessons = useLessonStore((s) => s.lessons);
  const [lessonFilter, setLessonFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      entries
        .filter((e) => !lessonFilter || e.lessonId === lessonFilter)
        .filter((e) => stateFilter === '' || String(e.fsrs.state) === stateFilter)
        .sort((a, b) => a.fsrs.due - b.fsrs.due),
    [entries, lessonFilter, stateFilter],
  );

  const missingGender = entries.filter(needsGender).length;

  if (!loaded) return <EmptyState>加载中…</EmptyState>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold">生词本（{entries.length}）</h1>
        <select
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
          value={lessonFilter}
          onChange={(e) => setLessonFilter(e.target.value)}
        >
          <option value="">全部课程</option>
          {lessons.map((l) => (
            <option key={l.id} value={l.id}>{l.title}</option>
          ))}
        </select>
        <select
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
        >
          <option value="">全部状态</option>
          {STATE_LABELS.map((label, i) => (
            <option key={label} value={String(i)}>{label}</option>
          ))}
        </select>
      </div>

      {missingGender > 0 && (
        <Hint tone="warn">
          有 {missingGender} 个名词还没填性。德语名词不带性等于没记 —— 下面标黄的就是。
        </Hint>
      )}

      {filtered.length === 0 ? (
        <EmptyState>没有符合条件的词条。</EmptyState>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200">
          {filtered.map((entry) => (
            <li key={entry.id} className={`p-3 ${needsGender(entry) ? 'bg-amber-50' : ''}`}>
              {editing === entry.id ? (
                <InlineEditor
                  entry={entry}
                  onSave={async (next) => { await updateEntry(next); setEditing(null); }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <Row
                  entry={entry}
                  lessonTitle={lessons.find((l) => l.id === entry.lessonId)?.title}
                  onEdit={() => setEditing(entry.id)}
                  onToggleSuspend={() => void updateEntry({ ...entry, suspended: !entry.suspended })}
                  onDelete={() => {
                    if (confirm(`删除「${entry.surface}」？句子上的挖空会保留，但会指向一个不存在的词条。`)) {
                      void removeEntry(entry.id);
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({
  entry,
  lessonTitle,
  onEdit,
  onToggleSuspend,
  onDelete,
}: {
  entry: VocabEntry;
  lessonTitle: string | undefined;
  onEdit: () => void;
  onToggleSuspend: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {entry.gender && <span className="mr-1 text-neutral-500">{{ m: 'der', f: 'die', n: 'das' }[entry.gender]}</span>}
          {entry.surface}
          {entry.plural && <span className="ml-2 text-sm text-neutral-500">{entry.plural}</span>}
          {entry.suspended && <span className="ml-2 rounded bg-neutral-200 px-1.5 text-xs">已暂停</span>}
          {!entry.hasTimestamp && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-800" title="来源句没有时间戳">
              无音频卡
            </span>
          )}
        </p>
        <p className="text-sm">{entry.meaning ?? <span className="text-neutral-400">（释义待填）</span>}</p>
        <p className="text-sm text-neutral-500">{entry.contextSentence}</p>
        <p className="text-xs text-neutral-400">
          {lessonTitle ? (
            <a className="hover:underline" href={href({ name: 'lesson', lessonId: entry.lessonId, tab: 'study' })}>
              《{lessonTitle}》
            </a>
          ) : (
            '（课程已删除）'
          )}
          {' · '}
          {STATE_LABELS[entry.fsrs.state]} · 下次 {new Date(entry.fsrs.due).toLocaleDateString('zh-CN')}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button onClick={onEdit}>编辑</Button>
        <Button onClick={onToggleSuspend}>{entry.suspended ? '恢复复习' : '暂停复习'}</Button>
        <Button variant="danger" onClick={onDelete}>删除</Button>
      </div>
    </div>
  );
}

function InlineEditor({
  entry,
  onSave,
  onCancel,
}: {
  entry: VocabEntry;
  onSave: (entry: VocabEntry) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(entry);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          className="w-40 rounded border border-neutral-300 px-2 py-1 text-sm"
          placeholder="词条（lemma）"
          value={draft.lemma ?? ''}
          onChange={(e) => setDraft({ ...draft, lemma: e.target.value })}
        />
        <select
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
          value={draft.gender ?? ''}
          onChange={(e) => setDraft({ ...draft, gender: (e.target.value || undefined) as VocabEntry['gender'] })}
        >
          <option value="">性…</option>
          <option value="m">der (m)</option>
          <option value="f">die (f)</option>
          <option value="n">das (n)</option>
        </select>
        <input
          className="w-24 rounded border border-neutral-300 px-2 py-1 text-sm"
          placeholder="复数"
          value={draft.plural ?? ''}
          onChange={(e) => setDraft({ ...draft, plural: e.target.value })}
        />
        <input
          className="min-w-60 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
          placeholder="释义"
          value={draft.meaning ?? ''}
          onChange={(e) => setDraft({ ...draft, meaning: e.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void onSave(draft)}>保存</Button>
        <Button variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}
