// FR-7 生词标记与挖空 + FR-14 Glossar 候选词的落点。
//
// §3.3 R1：挖空只允许在**有时间戳**的句子上做 —— 挖了空却没有音频，
// 听写和带音频的复习卡都无从谈起。没时间戳的句子上点词时给一键「自动对齐这一课」。

import { useMemo, useState } from 'react';
import { audioPlayer } from '@/audio/player';
import { useLessonAudio } from '@/audio/useLessonAudio';
import { resolveRange } from '@/lesson/timing';
import { displayNumbers } from '@/lesson/sentences';
import { isSelected, shouldSuggestCollocation, surfaceOf, toRanges, tokenize, type Range, type Token } from '@/lesson/tokens';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useAlignStore } from '@/state/useAlignStore';
import { GlossaryCandidates, acceptCandidate } from './GlossaryCandidates';
import { Banner, Button, Hint } from '@/components/ui';
import type { GlossaryCandidate, Lesson, LessonCache, Sentence, VocabEntry } from '@/types/models';

export function StudyTab({ lesson }: { lesson: Lesson; cache: LessonCache | undefined }) {
  const audio = useLessonAudio(lesson.id);
  const entries = useVocabStore((s) => s.entries);
  const numbers = useMemo(() => displayNumbers(lesson.sentences), [lesson.sentences]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<Token[]>([]);

  const visible = lesson.sentences.filter((s) => !s.excluded);

  // FR-14.2：候选词在正文里以浅色下划线标出，点一下即接受。面板（下面那个）是同一件事的列表视图。
  const acceptedIds = useMemo(
    () => new Set(entries.filter((e) => e.dwKnowledgeId).map((e) => e.dwKnowledgeId!)),
    [entries],
  );
  const candidatesBySentence = useMemo(() => {
    const map = new Map<number, GlossaryCandidate[]>();
    for (const c of lesson.glossary ?? []) {
      if (acceptedIds.has(c.dwKnowledgeId)) continue;
      const bucket = map.get(c.sentenceIndex);
      if (bucket) bucket.push(c);
      else map.set(c.sentenceIndex, [c]);
    }
    return map;
  }, [lesson.glossary, acceptedIds]);

  return (
    <div className="space-y-4">
      <Hint>
        点词标记生词：连点多个词可以标搭配，中间隔着别的词也行（`hing … ab`）。
        标记会同时在句子上挖空、在生词本里建草稿。
      </Hint>

      <GlossaryCandidates lesson={lesson} />

      <div className="space-y-3">
        {visible.map((sentence) => (
          <SentenceRow
            key={sentence.index}
            lesson={lesson}
            sentence={sentence}
            displayNumber={numbers.get(sentence.index)}
            entries={entries}
            active={activeIndex === sentence.index}
            selection={activeIndex === sentence.index ? selection : []}
            candidates={candidatesBySentence.get(sentence.index) ?? []}
            audioReady={audio.status === 'ready'}
            onActivate={() => { setActiveIndex(sentence.index); setSelection([]); }}
            onSelectionChange={setSelection}
          />
        ))}
      </div>
    </div>
  );
}

function SentenceRow({
  lesson,
  sentence,
  displayNumber,
  entries,
  active,
  selection,
  candidates,
  audioReady,
  onActivate,
  onSelectionChange,
}: {
  lesson: Lesson;
  sentence: Sentence;
  displayNumber: number | undefined;
  entries: VocabEntry[];
  active: boolean;
  selection: Token[];
  candidates: GlossaryCandidate[];
  audioReady: boolean;
  onActivate: () => void;
  onSelectionChange: (tokens: Token[]) => void;
}) {
  const tokens = useMemo(() => tokenize(sentence.text), [sentence.text]);
  const enqueueAlign = useAlignStore((s) => s.enqueue);
  const blankRanges = sentence.blanks.flatMap((b) => b.ranges);
  const selectedRanges = toRanges(sentence.text, selection);
  const hasTimestamp = sentence.startTime !== undefined;
  const range = resolveRange(lesson.sentences, sentence.index, lesson.audioDuration);

  const candidateAt = (token: Token): GlossaryCandidate | undefined =>
    candidates.find((c) => c.ranges.some((r) => token.start >= r.start && token.end <= r.end));

  const toggle = (token: Token) => {
    if (!token.isWord) return;
    // 候选词一点即接受（FR-14.2），不用先选中再确认 —— 词条信息 DW 已经给全了。
    const candidate = candidateAt(token);
    if (candidate && selection.length === 0 && !isSelected(blankRanges, token)) {
      void acceptCandidate(lesson.id, candidate);
      return;
    }
    onActivate();
    const exists = selection.some((t) => t.start === token.start);
    onSelectionChange(exists ? selection.filter((t) => t.start !== token.start) : [...selection, token]);
  };

  return (
    <div className={`rounded-lg border p-3 ${active ? 'border-sky-400' : 'border-neutral-200'}`}>
      <div className="flex items-start gap-3">
        <span className="w-8 shrink-0 pt-1 text-right text-xs text-neutral-400">{displayNumber ?? '—'}</span>

        <p className="min-w-0 flex-1 text-base leading-loose">
          {tokens.map((token) => {
            const inBlank = isSelected(blankRanges, token);
            const picked = active && selection.some((t) => t.start === token.start);
            const candidate = candidateAt(token);
            if (!token.isWord) return <span key={token.start}>{token.text}</span>;
            return (
              <span
                key={token.start}
                onClick={() => toggle(token)}
                title={candidate ? `Glossar：${candidate.title}（点一下接受）` : undefined}
                className={`cursor-pointer rounded px-0.5 ${
                  picked
                    ? 'bg-sky-200'
                    : inBlank
                      ? 'bg-amber-100 underline decoration-amber-400'
                      : candidate
                        ? 'underline decoration-sky-300 decoration-dotted underline-offset-4 hover:bg-neutral-100'
                        : 'hover:bg-neutral-100'
                }`}
              >
                {token.text}
              </span>
            );
          })}
        </p>

        <Button
          className="shrink-0"
          variant="ghost"
          disabled={!hasTimestamp || !audioReady || !range}
          title={!hasTimestamp ? '这一句还没有时间戳' : undefined}
          onClick={() => range && void audioPlayer.playRange(range.start, range.end)}
        >
          ▶
        </Button>
      </div>

      {active && selection.length > 0 && (
        hasTimestamp ? (
          <MarkPanel
            lesson={lesson}
            sentence={sentence}
            ranges={selectedRanges}
            onDone={() => onSelectionChange([])}
          />
        ) : (
          // §3.3 R1
          <Banner tone="warn">
            <p>这一句还没有时间戳，挖空既不能听写、也生成不了带音频的卡。先自动对齐一次。</p>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => enqueueAlign(lesson.id, { manual: true })}>自动对齐这一课</Button>
              <Button variant="ghost" onClick={() => onSelectionChange([])}>
                取消选择
              </Button>
            </div>
          </Banner>
        )
      )}

      {sentence.blanks.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-neutral-100 pt-2">
          {sentence.blanks.map((blank) => {
            const entry = entries.find((e) => e.id === blank.vocabEntryId);
            return (
              <li key={blank.id} className="flex items-center gap-2 text-sm">
                <span className="font-medium">{blank.surface}</span>
                <span className="text-neutral-500">{entry?.meaning ?? '（释义待填）'}</span>
                <BlankRemoveButton lesson={lesson} sentence={sentence} blankId={blank.id} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** FR-7.5：取消挖空 → 询问是否同时删除生词条目。 */
function BlankRemoveButton({ lesson, sentence, blankId }: { lesson: Lesson; sentence: Sentence; blankId: string }) {
  const removeBlank = useVocabStore((s) => s.removeBlank);
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <Button variant="ghost" className="ml-auto" onClick={() => setAsking(true)}>
        取消挖空
      </Button>
    );
  }
  return (
    <span className="ml-auto flex items-center gap-2">
      <span className="text-xs text-neutral-500">生词条目也删掉吗？</span>
      <Button variant="danger" onClick={() => { void removeBlank(lesson.id, sentence.index, blankId, true); setAsking(false); }}>
        一起删
      </Button>
      <Button onClick={() => { void removeBlank(lesson.id, sentence.index, blankId, false); setAsking(false); }}>
        只取消挖空
      </Button>
      <Button variant="ghost" onClick={() => setAsking(false)}>算了</Button>
    </span>
  );
}

/** 标记面板：去重提示（FR-9.3）+ 释义/性/复数（FR-7.4）。 */
function MarkPanel({
  lesson,
  sentence,
  ranges,
  onDone,
}: {
  lesson: Lesson;
  sentence: Sentence;
  ranges: Range[];
  onDone: () => void;
}) {
  const { createFromSelection, attachToExisting, findDuplicates, updateEntry } = useVocabStore();
  const [duplicates, setDuplicates] = useState<VocabEntry[] | null>(null);
  const [created, setCreated] = useState<VocabEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lessons = useLessonStore((s) => s.lessons);

  const surface = surfaceOf(sentence.text, ranges);

  const create = async () => {
    setError(null);
    try {
      setCreated(await createFromSelection({ lesson, sentence, ranges }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const check = async () => {
    const found = await findDuplicates(surface);
    if (found.length === 0) await create();
    else setDuplicates(found);
  };

  if (created) {
    return <EntryEditor entry={created} onSave={updateEntry} onClose={() => { setCreated(null); onDone(); }} />;
  }

  if (duplicates) {
    return (
      <Banner tone="info">
        <p>
          生词本里已经有「{surface}」
          {duplicates
            .map((d) => `（来自《${lessons.find((l) => l.id === d.lessonId)?.title ?? '未知课程'}》）`)
            .join('')}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => {
              void attachToExisting({ lesson, sentence, ranges, entryId: duplicates[0].id });
              setDuplicates(null);
              onDone();
            }}
          >
            合并到已有条目
          </Button>
          <Button onClick={() => { setDuplicates(null); void create(); }}>仍然新建</Button>
          <Button variant="ghost" onClick={() => { setDuplicates(null); onDone(); }}>取消</Button>
        </div>
      </Banner>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded border border-sky-200 bg-sky-50 p-3">
      <p className="text-sm">
        选中：<span className="font-medium">{surface}</span>
      </p>
      {shouldSuggestCollocation(surface) && (
        <Hint tone="warn">
          考虑连搭配一起标记 —— `sich einer Sache bewusst sein` 比 `bewusst` 有用得多。（不强制）
        </Hint>
      )}
      {error && <Hint tone="error">{error}</Hint>}
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void check()}>标记为生词并挖空</Button>
        <Button variant="ghost" onClick={onDone}>取消选择</Button>
      </div>
    </div>
  );
}

/** FR-7.4：释义 / 性 / 复数。名词不填性等于没记，所以性放在最显眼的位置。 */
export function EntryEditor({
  entry,
  onSave,
  onClose,
}: {
  entry: VocabEntry;
  onSave: (entry: VocabEntry) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(entry);

  return (
    <div className="mt-2 space-y-2 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm">
      <p className="font-medium">{entry.surface}</p>
      <div className="flex flex-wrap gap-2">
        <input
          className="min-w-48 flex-1 rounded border border-neutral-300 px-2 py-1"
          placeholder="释义"
          value={draft.meaning ?? ''}
          onChange={(e) => setDraft({ ...draft, meaning: e.target.value })}
        />
        <select
          className="rounded border border-neutral-300 px-2 py-1"
          value={draft.gender ?? ''}
          onChange={(e) => setDraft({ ...draft, gender: (e.target.value || undefined) as VocabEntry['gender'] })}
        >
          <option value="">性…</option>
          <option value="m">der (m)</option>
          <option value="f">die (f)</option>
          <option value="n">das (n)</option>
        </select>
        <input
          className="w-28 rounded border border-neutral-300 px-2 py-1"
          placeholder="复数"
          value={draft.plural ?? ''}
          onChange={(e) => setDraft({ ...draft, plural: e.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => { void onSave(draft); onClose(); }}>保存</Button>
        <Button variant="ghost" onClick={onClose}>稍后再填</Button>
      </div>
    </div>
  );
}
