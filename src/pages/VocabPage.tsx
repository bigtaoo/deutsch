// FR-9 生词本。
//
// FR-9.3 的去重降级发生在**新建时**（见 StudyTab 的 MarkPanel），这里只做管理：
// 编辑、删除、暂停复习、按课程/状态筛选。
//
// 页顶还挂着两块「进词」的入口：查词（FR-9.5，课上碰到的词）与预置词库报名（FR-17）。
// 词条因此有三种来源，列表行必须各说各的 —— 查词加进来的词从来没有过课程，
// 而 `（课程已删除）` 会让人以为丢了数据。

import { useMemo, useState } from 'react';
import { href } from '@/app/router';
import { useLessonStore } from '@/state/useLessonStore';
import { needsGender, useVocabStore } from '@/state/useVocabStore';
import { Button, EmptyState, Hint, field } from '@/components/ui';
import { DictLookup } from './vocab/DictLookup';
import { PresetPanel } from './vocab/PresetPanel';
import { ZhPanel } from './vocab/ZhPanel';
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
        .filter((e) =>
          lessonFilter === 'preset'
            ? Boolean(e.preset)
            : lessonFilter === 'lookup'
              ? Boolean(e.lookup)
              : !lessonFilter || e.lessonId === lessonFilter,
        )
        .filter((e) => stateFilter === '' || String(e.fsrs.state) === stateFilter)
        .sort((a, b) => a.fsrs.due - b.fsrs.due),
    [entries, lessonFilter, stateFilter],
  );

  const missingGender = entries.filter(needsGender).length;

  if (!loaded) return <EmptyState>加载中…</EmptyState>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto hidden text-title font-semibold sm:block">生词本（{entries.length}）</h1>
        <select
          className={`${field} min-w-0 max-w-full flex-1 px-2 py-1 sm:flex-none`}
          value={lessonFilter}
          onChange={(e) => setLessonFilter(e.target.value)}
        >
          <option value="">全部来源</option>
          <option value="preset">预置词库</option>
          <option value="lookup">查词添加</option>
          {lessons.map((l) => (
            <option key={l.id} value={l.id}>{l.title}</option>
          ))}
        </select>
        <select
          className={`${field} min-w-0 max-w-full flex-1 px-2 py-1 sm:flex-none`}
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
        >
          <option value="">全部状态</option>
          {STATE_LABELS.map((label, i) => (
            <option key={label} value={String(i)}>{label}</option>
          ))}
        </select>
      </div>

      <DictLookup />

      <PresetPanel />

      {missingGender > 0 && (
        <Hint tone="warn">
          有 {missingGender} 个名词还没填性。德语名词不带性等于没记 —— 下面标黄的就是。
        </Hint>
      )}

      {filtered.length === 0 ? (
        <EmptyState>没有符合条件的词条。</EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-box border border-line bg-raised">
          {filtered.map((entry) => (
            <li key={entry.id} className={`p-3 ${needsGender(entry) ? 'bg-warn-soft' : ''}`}>
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

      {/* FR-21.9：低频（一年点几次），所以在页底、而且是折叠的 —— 页顶留给查词（§12.11） */}
      <ZhPanel />
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
  // 手机上竖排：横排时按钮会压在词条上面（§2.1 手机是复习工位，生词本也得能用）
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {entry.gender && <span className="mr-1 text-muted">{{ m: 'der', f: 'die', n: 'das' }[entry.gender]}</span>}
          {entry.surface}
          {entry.plural && <span className="ml-2 text-ui text-muted">{entry.plural}</span>}
          {entry.suspended && <span className="ml-2 rounded-ctl bg-sunken px-1.5 text-note">已暂停</span>}
          {entry.preset ? (
            <span
              className="ml-2 rounded-ctl bg-accent-soft px-1.5 text-note text-accent"
              title={`预置词库第 ${entry.preset.band} 档第 ${entry.preset.rank} 名（词频档，不是 CEFR 等级）`}
            >
              预置 第{entry.preset.band}档
            </span>
          ) : entry.lookup ? (
            <span className="ml-2 rounded-ctl bg-sunken px-1.5 text-note text-muted">查词添加</span>
          ) : (
            !entry.hasTimestamp && (
              <span className="ml-2 rounded-ctl bg-warn-soft px-1.5 text-note text-warn" title="来源句没有时间戳">
                无音频卡
              </span>
            )
          )}
        </p>
        <p className="text-ui">{entry.meaning ?? <span className="text-faint">（释义待填）</span>}</p>
        {/* FR-21.9：中译补齐之前这里多半是空的，所以没有就不占一行 */}
        {entry.meaningZh && <p className="text-ui text-muted">{entry.meaningZh}</p>}
        {entry.contextSentence && <p className="text-ui text-muted">{entry.contextSentence}</p>}
        <p className="text-note text-faint">
          {entry.preset ? (
            // 预置卡没有出处课程，也没有原句。如实写出来，不要显示「（课程已删除）」
            // —— 那会让人以为丢了数据。
            '预置词库（孤立词发音）'
          ) : entry.lookup ? (
            // FR-9.5：查词加进来的词同理 —— 它从来没有过课程，不是课程丢了。
            '查词添加（孤立词发音）'
          ) : lessonTitle && entry.lessonId ? (
            <a className="hover:underline" href={href({ name: 'lesson', lessonId: entry.lessonId, tab: 'study' })}>
              《{lessonTitle}》
            </a>
          ) : (
            '（课程已删除）'
          )}
          {' · '}
          听 {STATE_LABELS[entry.fsrs.state]} · {new Date(entry.fsrs.due).toLocaleDateString('zh-CN')}
          {/* FR-21：读卡开了才显示。没开时不写「读 未开」—— 那是这个功能的常态，
              每一行都挂一句常态说明，等于把真正有信息的那几行淹掉 */}
          {entry.fsrsRead && (
            <>
              {' · '}
              读 {STATE_LABELS[entry.fsrsRead.state]} · {new Date(entry.fsrsRead.due).toLocaleDateString('zh-CN')}
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
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
          className={`${field} w-40 px-2 py-1`}
          placeholder="词条（lemma）"
          value={draft.lemma ?? ''}
          onChange={(e) => setDraft({ ...draft, lemma: e.target.value })}
        />
        <select
          className={`${field} px-2 py-1`}
          value={draft.gender ?? ''}
          onChange={(e) => setDraft({ ...draft, gender: (e.target.value || undefined) as VocabEntry['gender'] })}
        >
          <option value="">性…</option>
          <option value="m">der (m)</option>
          <option value="f">die (f)</option>
          <option value="n">das (n)</option>
        </select>
        <input
          className={`${field} w-24 px-2 py-1`}
          placeholder="复数"
          value={draft.plural ?? ''}
          onChange={(e) => setDraft({ ...draft, plural: e.target.value })}
        />
        <input
          className={`${field} min-w-60 flex-1 px-2 py-1`}
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
