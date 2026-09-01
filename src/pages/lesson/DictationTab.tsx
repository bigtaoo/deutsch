// FR-8 听写模式。
//
// 队列 = 本篇**含 Blank 且有时间戳**的句子（FR-8.1）。没有时间戳就没有可重播的音频，
// 那是「看着挖空句填词」，不是听写。

import { useEffect, useMemo, useRef, useState } from 'react';
import { audioPlayer } from '@/audio/player';
import { useLessonAudio } from '@/audio/useLessonAudio';
import { resolveRange } from '@/lesson/timing';
import { toClozeSegments, type ClozeSegment } from '@/lesson/tokens';
import { checkAnswer, verdictToRating, type DictationResult, type DiffPart } from '@/dictation/check';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore } from '@/state/useVocabStore';
import { backupVocabNow } from '@/github/backupTrigger';
import { review } from '@/srs/fsrs';
import { Banner, Button, EmptyState } from '@/components/ui';
import type { Lesson, LessonCache, Sentence } from '@/types/models';

const UMLAUT_KEYS = ['ä', 'ö', 'ü', 'ß', 'Ä', 'Ö', 'Ü'];

export function DictationTab({ lesson }: { lesson: Lesson; cache: LessonCache | undefined }) {
  const audio = useLessonAudio(lesson.id);
  const { settings } = useSettingsStore();
  const { entries, updateEntry } = useVocabStore();

  const queue = useMemo(
    () => lesson.sentences.filter((s) => !s.excluded && s.blanks.length > 0 && s.startTime !== undefined),
    [lesson.sentences],
  );

  const [position, setPosition] = useState(0);
  const sentence = queue[position];

  if (queue.length === 0) {
    return (
      <EmptyState>
        这一课还没有可听写的句子。听写需要：句子有时间戳 + 句上有挖空。
        时间戳由自动对齐给（课程页头部可以重跑），挖空去「学词」点几个词。
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      {audio.status !== 'ready' && <Banner tone="warn">音频不可用，只能看着填空，不算听写。</Banner>}

      <p className="text-sm text-neutral-500">
        第 {position + 1} / {queue.length} 句
      </p>

      <DictationCard
        key={sentence.index}
        lesson={lesson}
        sentence={sentence}
        audioReady={audio.status === 'ready'}
        strictCase={settings.dictationStrictCase}
        onGrade={async (blankId, verdict) => {
          const blank = sentence.blanks.find((b) => b.id === blankId);
          const entry = entries.find((e) => e.id === blank?.vocabEntryId);
          if (!entry) return;
          // FR-8.6：听写结果直接回写 FSRS，不需要再去复习界面重评一次。
          await updateEntry({ ...entry, fsrs: review(entry.fsrs, verdictToRating(verdict)) });
        }}
        onNext={() => {
          if (position + 1 < queue.length) setPosition(position + 1);
          else void backupVocabNow(); // FR-11.6：一轮做完就把 vocab.json 推上去
        }}
        isLast={position + 1 >= queue.length}
      />
    </div>
  );
}

function DictationCard({
  lesson,
  sentence,
  audioReady,
  strictCase,
  onGrade,
  onNext,
  isLast,
}: {
  lesson: Lesson;
  sentence: Sentence;
  audioReady: boolean;
  strictCase: boolean;
  onGrade: (blankId: string, verdict: DictationResult['verdict']) => Promise<void>;
  onNext: () => void;
  isLast: boolean;
}) {
  const segments = useMemo(
    () => toClozeSegments(sentence.text, sentence.blanks.map((b) => b.ranges)),
    [sentence],
  );
  const blankSegments = segments.filter((s) => s.type === 'blank');

  const [answers, setAnswers] = useState<string[]>(() => blankSegments.map(() => ''));
  const [results, setResults] = useState<DictationResult[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const focusedRef = useRef(0);

  const range = resolveRange(lesson.sentences, sentence.index, lesson.audioDuration);
  const replay = () => range && audioReady && void audioPlayer.playRange(range.start, range.end);

  // 进入一句先自动播一遍 —— 听写的第一动作永远是「听」。
  useEffect(() => {
    replay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentence.index, audioReady]);

  // FR-8.2：非输入焦点时 Space 重播本句。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (e.key === ' ') { e.preventDefault(); replay(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const grade = async (forceWrong = false) => {
    const next = blankSegments.map((segment, i) =>
      forceWrong
        ? { verdict: 'wrong' as const, message: '答案是 ' + segment.text, diff: [] }
        : checkAnswer(segment.text, answers[i], { strictCase }),
    );
    setResults(next);
    setRevealed(true);

    // 一个 Blank 可能有多个空（`hing ___ ... ___ ab`）：取最差的一档回写，
    // 半对不该算过。
    const worstByBlank = new Map<number, DictationResult['verdict']>();
    const severity = { correct: 0, transliteration: 1, case: 2, wrong: 3 };
    blankSegments.forEach((segment, i) => {
      const blankIndex = segment.blankIndex!;
      const current = worstByBlank.get(blankIndex);
      if (!current || severity[next[i].verdict] > severity[current]) {
        worstByBlank.set(blankIndex, next[i].verdict);
      }
    });
    for (const [blankIndex, verdict] of worstByBlank) {
      const blank = sentence.blanks[blankIndex];
      if (blank) await onGrade(blank.id, verdict);
    }
  };

  const insertUmlaut = (ch: string) => {
    const i = focusedRef.current;
    const input = inputsRef.current[i];
    if (!input) return;
    const at = input.selectionStart ?? answers[i].length;
    const value = answers[i].slice(0, at) + ch + answers[i].slice(input.selectionEnd ?? at);
    setAnswers(answers.map((a, idx) => (idx === i ? value : a)));
    // 插完把光标放回字符后面，否则连打两个变音符会都落在同一个位置。
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(at + ch.length, at + ch.length);
    });
  };

  let blankCursor = -1;

  return (
    <div className="space-y-4 rounded-lg border border-neutral-200 p-5">
      <p className="text-lg leading-loose">
        {segments.map((segment, i) => {
          if (segment.type === 'text') return <span key={i}>{segment.text}</span>;
          blankCursor++;
          const index = blankCursor;
          const result = results?.[index];
          return (
            <BlankInput
              key={i}
              segment={segment}
              value={answers[index]}
              result={result}
              revealed={revealed}
              onChange={(v) => setAnswers(answers.map((a, idx) => (idx === index ? v : a)))}
              onFocus={() => { focusedRef.current = index; }}
              ref={(el) => { inputsRef.current[index] = el; }}
              onEnter={() => void grade()}
            />
          );
        })}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {/* FR-8.7：手机上打德语变音符很痛苦，这排按钮是必需品（Q4） */}
        {UMLAUT_KEYS.map((ch) => (
          <Button key={ch} onClick={() => insertUmlaut(ch)}>{ch}</Button>
        ))}
        <span className="mx-2 h-5 w-px bg-neutral-200" />
        <Button disabled={!audioReady} onClick={replay} title={audioReady ? undefined : '本机没有这一课的音频'}>
          重播本句 (Space)
        </Button>
        {!revealed ? (
          <>
            <Button variant="primary" onClick={() => void grade()}>对答案</Button>
            <Button variant="ghost" onClick={() => void grade(true)}>我不会</Button>
          </>
        ) : (
          <Button variant="primary" onClick={onNext}>{isLast ? '完成本轮' : '下一句 →'}</Button>
        )}
      </div>

      {results && <ResultList results={results} />}
    </div>
  );
}

const VERDICT_STYLE: Record<DictationResult['verdict'], { border: string; tone: string; label: string }> = {
  correct: { border: 'border-emerald-500', tone: 'text-emerald-700', label: '正确' },
  transliteration: { border: 'border-sky-500', tone: 'text-sky-700', label: '转写等价' },
  case: { border: 'border-amber-500', tone: 'text-amber-700', label: '仅大小写错' },
  wrong: { border: 'border-red-500', tone: 'text-red-700', label: '错误' },
};

const BlankInput = ({
  ref,
  segment,
  value,
  result,
  revealed,
  onChange,
  onFocus,
  onEnter,
}: {
  ref: (el: HTMLInputElement | null) => void;
  segment: ClozeSegment;
  value: string;
  result: DictationResult | undefined;
  revealed: boolean;
  onChange: (value: string) => void;
  onFocus: () => void;
  onEnter: () => void;
}) => (
  <input
    ref={ref}
    value={value}
    readOnly={revealed}
    onFocus={onFocus}
    onChange={(e) => onChange(e.target.value)}
    onKeyDown={(e) => e.key === 'Enter' && onEnter()}
    // 宽度按答案长度给，既是提示也避免输入框把版面撑烂
    style={{ width: `${Math.max(6, segment.text.length + 2)}ch` }}
    className={`mx-1 border-b-2 bg-transparent px-1 text-center outline-none ${
      result ? VERDICT_STYLE[result.verdict].border : 'border-neutral-400 focus:border-sky-500'
    }`}
    placeholder="____"
  />
);

function ResultList({ results }: { results: DictationResult[] }) {
  return (
    <ul className="space-y-2 border-t border-neutral-100 pt-3 text-sm">
      {results.map((result, i) => (
        <li key={i} className={VERDICT_STYLE[result.verdict].tone}>
          <span className="mr-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700">
            {VERDICT_STYLE[result.verdict].label}
          </span>
          {result.message}
          {result.verdict === 'wrong' && (
            <span className="ml-2 font-mono">
              <DiffView parts={result.diff} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** FR-8.4：字符级 diff。缺的字符标绿底、多打的标红删除线。 */
function DiffView({ parts }: { parts: DiffPart[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <span
          key={i}
          className={
            part.type === 'same'
              ? ''
              : part.type === 'missing'
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-red-100 text-red-800 line-through'
          }
        >
          {part.text}
        </span>
      ))}
    </>
  );
}
