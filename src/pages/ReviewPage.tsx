// FR-10 SRS 复习 —— 手机上的主界面。
//
// ── 形状：听音四选一，不是 Anki ──
// 卡片正面**只有声音**（FR-10.2）：进页面自动播一次，点按钮重播，不给任何文字。
// 给了文字这张卡就变成「看词回忆意思」，而这个应用存在的理由是听觉识别
// （听到 /ˈtsuːfɐˌzɪçt/ 反应过来是 Zuversicht）。
//
// 答对 → 顶部闪一下带冠词的词形 → 自动下一张（FR-10.11）。
// 答错 → 亮出正确项 + 完整卡背 → 底部〔继续〕。
//
// **评分不问用户**（FR-10.4）：作答的对错与用时映射成 FSRS 四档，见 srs/grade.ts。
// 原来那排「忘了 / 勉强 / 记得 / 太简单」连同按钮下面的间隔预览一起删掉了 ——
// 手评是元认知任务，而且它与自动评分喂给 FSRS 的分布不同，两条路径不能并存。

import { useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '@/app/router';
import { audioPlayer } from '@/audio/player';
import { getAudioBlob } from '@/db/cache';
import { resolveRange } from '@/lesson/timing';
import { buildReviewQueue, cardAudioStatus } from '@/srs/queue';
import { formatInterval, review } from '@/srs/fsrs';
import { articled, gradeFromAnswer } from '@/srs/grade';
import { buildQuestion } from '@/srs/questionSource';
import { syncVocabNow } from '@/sync/trigger';
import { loadDeck, lookupDict } from '@/dict/lookup';
import { ensureWordAudio, germanVoice, speak, type WordAudioSource } from '@/dict/audio';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore } from '@/state/useVocabStore';
import { Banner, Button, EmptyState, Hint } from '@/components/ui';
import type { Question } from '@/srs/choices';
import type { Lesson, VocabEntry } from '@/types/models';

/** 答对之后那一闪的时长（FR-10.11）。600ms 看不完卡背，但看得完 `der Vorhang`。 */
const FLASH_MS = 600;

type Phase = 'asking' | 'flash' | 'revealed';

export function ReviewPage() {
  const { entries, updateEntry, topUpNewCards, loaded } = useVocabStore();
  const { lessons, caches } = useLessonStore();
  const { settings } = useSettingsStore();

  // 队列在进入页面时算一次并冻结：随着评分实时重算会让卡片在手底下跳来跳去。
  const [session, setSession] = useState<VocabEntry[] | null>(null);
  const [position, setPosition] = useState(0);
  const [finished, setFinished] = useState(false);
  /** FR-17.4：进页面时先把今天缺的新卡从已报名的档里补上。 */
  const [topUp, setTopUp] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('asking');
  const [picked, setPicked] = useState<string | null>(null);
  const [nextDue, setNextDue] = useState<Date | null>(null);

  const breakdownRef = useRef<ReturnType<typeof buildReviewQueue> | null>(null);

  useEffect(() => {
    if (!loaded || session !== null) return;
    let cancelled = false;
    void (async () => {
      // 激活要先于建队列 —— 否则今天新激活的卡要等下次进页面才看得到。
      if ((settings.enrolledBands ?? []).length > 0) {
        setTopUp('正在准备今天的新卡…');
        try {
          const { added, human } = await topUpNewCards((p, done, total) =>
            setTopUp(p === 'picking' ? `查词典 ${done}/${total}` : `取发音 ${done}/${total}`),
          );
          if (!cancelled && added.length > 0) {
            setTopUp(`今天新加了 ${added.length} 个词（${human} 个有真人录音）`);
          } else if (!cancelled) setTopUp(null);
        } catch {
          // 断网时激活会失败，但**已有的卡照样能复习** —— 这是 §2.1 的主场景，
          // 不能因为补不到新卡就把整页拦住。
          if (!cancelled) setTopUp('离线：这次没能补新卡，已有的卡照常复习');
        }
      }
      if (cancelled) return;
      const fresh = useVocabStore.getState().entries;
      breakdownRef.current = buildReviewQueue(fresh, {
        newPerDay: settings.newPerDay,
        reviewPerDay: settings.reviewPerDay,
      });
      setSession(breakdownRef.current.queue);
    })();
    return () => {
      cancelled = true;
    };
    // settings/topUpNewCards 都是稳定引用；这个 effect 只在「加载完且还没建会话」时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, session]);

  const breakdown = breakdownRef.current;
  const queue = session ?? [];
  const entry = queue[position];
  // 评分会改 entries，卡面要用最新的那一份
  const current = entry ? (entries.find((e) => e.id === entry.id) ?? entry) : undefined;
  const lesson = current ? lessons.find((l) => l.id === current.lessonId) : undefined;

  const advance = useCallback(() => {
    setPhase('asking');
    setPicked(null);
    setNextDue(null);
    setPosition((p) => {
      if (p + 1 < queue.length) return p + 1;
      setFinished(true);
      // FR-11.6：每次复习会话结束就推 vocab.json —— 不可重建的数据不过夜。
      void syncVocabNow();
      return p;
    });
  }, [queue.length]);

  /**
   * 收下一次作答：评分、落库、决定下一步。
   *
   * `elapsedMs` 由卡面给出（从音频开始播算起），不在这里取 `Date.now()` ——
   * 组题和取音频都是异步的，从「卡片挂载」算起会把网络时间算成犹豫时间。
   */
  const answer = useCallback(
    async (choiceId: string | null, correct: boolean, elapsedMs: number) => {
      if (!current || phase !== 'asking') return;
      setPicked(choiceId);
      const rating = gradeFromAnswer({ correct, gaveUp: choiceId === null, elapsedMs }, current.fsrs);
      const next = review(current.fsrs, rating);
      setNextDue(new Date(next.due));
      await updateEntry({ ...current, fsrs: next });
      if (correct) {
        setPhase('flash');
      } else {
        setPhase('revealed');
      }
    },
    [current, phase, updateEntry],
  );

  // 答对之后自动进下一张。计时器要能被清掉 —— 否则连点两次会跳两张。
  useEffect(() => {
    if (phase !== 'flash') return;
    const timer = setTimeout(advance, FLASH_MS);
    return () => clearTimeout(timer);
  }, [phase, advance]);

  if (!loaded || (session === null && topUp === null)) return <EmptyState>加载中…</EmptyState>;
  if (session === null) return <EmptyState>{topUp}</EmptyState>;

  if (finished || queue.length === 0) {
    return (
      <EmptyState>
        <p className="text-base">{finished ? '这一轮做完了。' : '今天没有到期的卡片。'}</p>
        {breakdown?.nextDueAt && (
          <p className="mt-2">下一张卡 {new Date(breakdown.nextDueAt).toLocaleString('zh-CN', { hour12: false })} 到期。</p>
        )}
        {(settings.enrolledBands ?? []).length === 0 && entries.length === 0 && (
          <p className="mt-2 text-sm">
            还没有卡片。可以在生词本页报名一档预置词库，或者从课程里标几个生词。
          </p>
        )}
        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={() => navigate({ name: 'lessons' })}>回到课程</Button>
          <Button onClick={() => navigate({ name: 'vocab' })}>看生词本</Button>
        </div>
      </EmptyState>
    );
  }

  if (!current) return <EmptyState>加载中…</EmptyState>;

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm text-neutral-500">
        <span>
          {position + 1} / {queue.length}
        </span>
        {breakdown && (
          <span>
            新卡 {breakdown.newCount} · 复习 {breakdown.reviewCount}
          </span>
        )}
        {topUp && <span className="text-emerald-700">{topUp}</span>}
      </div>

      <QuizCard
        // key 让每张卡都是新的组件实例：组题、音频、计时全部随之重置，
        // 不必在一堆 effect 里手工清状态。
        key={current.id}
        entry={current}
        entries={entries}
        lesson={lesson}
        hasMaterial={Boolean(current.lessonId && caches[current.lessonId]?.hasAudio)}
        phase={phase}
        picked={picked}
        nextDue={nextDue}
        onAnswer={answer}
        onContinue={advance}
      />
    </div>
  );
}

function QuizCard({
  entry,
  entries,
  lesson,
  hasMaterial,
  phase,
  picked,
  nextDue,
  onAnswer,
  onContinue,
}: {
  entry: VocabEntry;
  entries: VocabEntry[];
  lesson: Lesson | undefined;
  hasMaterial: boolean;
  phase: Phase;
  picked: string | null;
  nextDue: Date | null;
  onAnswer: (choiceId: string | null, correct: boolean, elapsedMs: number) => void;
  onContinue: () => void;
}) {
  const audioStatus = cardAudioStatus(entry, hasMaterial);
  const sentence = entry.sentenceIndex === undefined ? undefined : lesson?.sentences[entry.sentenceIndex];
  const range = sentence && lesson ? resolveRange(lesson.sentences, sentence.index, lesson.audioDuration) : null;

  const [question, setQuestion] = useState<Question | null>(null);
  const [playable, setPlayable] = useState(false);
  const [wordSource, setWordSource] = useState<WordAudioSource | 'loading'>('loading');
  /** 例句只在答错时用，所以也只在那时去查（它在词典里，不在卡上 —— §2.3）。 */
  const [examples, setExamples] = useState<string[] | null>(null);
  /** 计时起点：音频开始播的那一刻，见 ReviewPage.answer 上面那段。 */
  const startedAt = useRef<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    void buildQuestion(entry, entries, loadDeck).then((q) => {
      if (cancelled) return;
      setQuestion(q);
      startedAt.current = Date.now();
    });
    return () => {
      cancelled = true;
    };
    // entries 每答一题都会变，但这张卡的题目只组一次 —— 不然选项会在手底下重排
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  // 正面自动播一次（FR-10.2）。课程卡放句子，预置卡放孤立词。
  useEffect(() => {
    let cancelled = false;
    setPlayable(false);
    if (audioStatus !== 'ok' || !range || !lesson) return;
    void (async () => {
      const blob = await getAudioBlob(lesson.id);
      if (!blob || cancelled) return;
      await audioPlayer.load(lesson.id, blob);
      if (cancelled) return;
      setPlayable(true);
      startedAt.current = Date.now();
      void audioPlayer.playRange(range.start, range.end).catch(() => {
        // iOS 上没有手势链时会被拒绝：留着「重播」按钮让用户点一下即可。
      });
    })();
    return () => {
      cancelled = true;
      audioPlayer.pause();
    };
  }, [entry.id, audioStatus, lesson, range]);

  // 预置卡（FR-17）：真人录音优先，没有就退 TTS。
  //
  // 走同一个全局单例 `<audio>`（键前缀 `word:`）而不是 new Audio()：§3.2 记着
  // iOS 只让「用户手势链」上的元素开始播放，每张卡新建一个元素的话第二张起就静默被拒。
  const playWord = useCallback(async () => {
    const blob = await ensureWordAudio(entry.surface).catch(() => undefined);
    if (blob) {
      await audioPlayer.load(`word:${entry.surface}`, blob);
      await audioPlayer.play(0).catch(() => {});
      return;
    }
    speak(entry.surface);
  }, [entry.surface]);

  useEffect(() => {
    let cancelled = false;
    if (audioStatus !== 'preset-word') return;
    setWordSource('loading');
    void (async () => {
      // 先只判**有没有**音源再播：把「查」和「播」并成一步的话，
      // iOS 拒绝自动播放时会被当成「没有音源」，卡面就会错报成纯文本卡。
      const blob = await ensureWordAudio(entry.surface).catch(() => undefined);
      if (cancelled) return;
      const source: WordAudioSource = blob ? 'human' : germanVoice() ? 'tts' : 'none';
      setWordSource(source);
      startedAt.current = Date.now();
      if (blob) {
        await audioPlayer.load(`word:${entry.surface}`, blob);
        if (!cancelled) await audioPlayer.play(0).catch(() => {});
      } else if (source === 'tts' && !cancelled) {
        speak(entry.surface);
      }
    })();
    return () => {
      cancelled = true;
      audioPlayer.pause();
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    };
  }, [entry.id, entry.surface, audioStatus]);

  // 答错时才取例句
  useEffect(() => {
    if (phase !== 'revealed' || !entry.preset || examples !== null) return;
    let cancelled = false;
    void lookupDict(entry.surface).then((hit) => {
      if (!cancelled) setExamples(hit?.entry.ex ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [phase, entry.preset, entry.surface, examples]);

  const choose = (id: string, correct: boolean) => onAnswer(id, correct, Date.now() - startedAt.current);

  // 键盘：1–4 选项，空格/回车继续。手机上用不到，桌面上一轮几十张卡时差别很大。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase === 'revealed' && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        onContinue();
        return;
      }
      if (phase !== 'asking' || !question) return;
      const i = Number(e.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < question.choices.length) {
        e.preventDefault();
        choose(question.choices[i].id, question.choices[i].correct);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const noAudio = audioStatus === 'preset-word' && wordSource === 'none';

  return (
    <>
      {/* FR-10.11：答对时那 600ms 是名词的性在主路径上唯一露脸的机会 */}
      <div className="flex h-9 items-center justify-center">
        {phase === 'flash' && (
          <p className="text-lg font-semibold text-emerald-700">
            ✓ {articled(entry.lemma ?? entry.surface, entry.gender)}
            {nextDue && <span className="ml-2 text-sm font-normal text-neutral-500">下次 {formatInterval(nextDue)}后</span>}
          </p>
        )}
      </div>

      {/* 卡面撑满剩余高度并把内容居中：正面只有一个播放键（FR-10.2），
          靠上贴着标题行的话，播放键和底部的选项之间会空掉半屏。
          选项那一块仍然由 `mt-auto` 钉在底部（FR-10.7），所以按钮位置不受影响。 */}
      <div className="flex flex-1 flex-col justify-center space-y-4 rounded-lg border border-neutral-200 p-6">
        {audioStatus === 'ok' ? (
          <div className="flex flex-col items-center gap-2">
            <PlayButton disabled={!playable} onClick={() => range && void audioPlayer.playRange(range.start, range.end)} />
            <p className="text-xs text-neutral-400">听这一句，选出挖掉的那个词</p>
          </div>
        ) : audioStatus === 'preset-word' ? (
          <div className="flex flex-col items-center gap-2">
            <PlayButton disabled={wordSource === 'loading' || wordSource === 'none'} onClick={() => void playWord()} />
            {noAudio ? (
              // FR-10.5：绝不静默降级。真人音没有、系统又没有德语嗓音时，
              // 这张卡确实只能看文字 —— 那就明说，并且把词显示出来（否则题面是空的）。
              <Banner tone="warn">
                <p>
                  这张卡没有声音：Wiktionary 上没有 <b>{entry.surface}</b> 的录音，系统里也没有德语嗓音。
                  只能当文字卡用。
                </p>
              </Banner>
            ) : (
              <p className="text-xs text-neutral-400">
                {wordSource === 'human' ? '真人录音（Wiktionary，CC BY-SA）' : wordSource === 'tts' ? '系统合成音' : '取音频中…'}
                {' · '}孤立词发音，练不到连读
              </p>
            )}
          </div>
        ) : (
          // FR-10.5：两种无音频原因给不同出口，绝不静默降级成纯文本卡
          <Banner tone="warn">
            {audioStatus === 'no-timestamp' ? (
              <>
                <p>这张卡没有音频：来源句还没有时间戳（自动对齐没覆盖到它）。</p>
                {lesson && (
                  <Button className="mt-2" onClick={() => navigate({ name: 'lesson', lessonId: lesson.id, tab: 'sentences' })}>
                    去这一课重新对齐
                  </Button>
                )}
              </>
            ) : (
              <>
                <p>这张卡没有音频：本机没有《{lesson?.title ?? '这一课'}》的素材。一键可解。</p>
                <Button className="mt-2" onClick={() => navigate({ name: 'sources' })}>
                  去下载素材
                </Button>
              </>
            )}
          </Banner>
        )}

        {/* 没有任何音源时把词显示出来，否则这道题无从下手 */}
        {noAudio && <p className="text-center text-2xl font-semibold">{entry.surface}</p>}

        {phase === 'revealed' && <CardBack entry={entry} sentence={sentence?.text} examples={examples} />}
      </div>

      <div className="mt-auto space-y-2">
        {question === null ? (
          <p className="py-4 text-center text-sm text-neutral-400">组题中…</p>
        ) : phase === 'revealed' ? (
          <>
            <ChoiceGrid question={question} picked={picked} revealed />
            <Button variant="primary" className="w-full py-4 text-base" onClick={onContinue}>
              继续 (Space)
            </Button>
          </>
        ) : (
          <>
            <ChoiceGrid
              question={question}
              picked={picked}
              revealed={false}
              onPick={phase === 'asking' ? choose : undefined}
            />
            {/* FR-10.8：这个出口不能省 —— 四选一有 25% 瞎猜命中率，
                没有它，猜对会被记成 Good，卡会越来越晚才回来 */}
            <Button
              className="w-full py-3"
              disabled={phase !== 'asking'}
              onClick={() => onAnswer(null, false, Date.now() - startedAt.current)}
            >
              没听清 / 不认识
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function PlayButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label="播放"
      className="flex h-20 w-20 items-center justify-center rounded-full bg-sky-600 text-3xl text-white transition active:scale-95 disabled:opacity-40"
    >
      ▶
    </button>
  );
}

/**
 * 2×2 选项网格（FR-10.7：拇指可达区）。
 *
 * `min-h` 固定而不是让格子跟着释义长短伸缩：否则每张卡的按钮都在不同的位置，
 * 手指得重新找一遍。释义已经被 shortGloss 截到 80 字符以内，装得下。
 */
function ChoiceGrid({
  question,
  picked,
  revealed,
  onPick,
}: {
  question: Question;
  picked: string | null;
  revealed: boolean;
  onPick?: (id: string, correct: boolean) => void;
}) {
  // 列数按题型分，而不是一套响应式断点走到底（实测 430px 下两种题都会变单列）：
  // 辨形题的选项是短词，手机上 2×2 按起来更省手；辨义题的选项是截到 80 字符的释义，
  // 挤进半个屏宽会折成四五行，那时单列才读得下去。
  const cols = question.kind === 'form' ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2';
  return (
    <div className={`grid gap-2 ${cols}`}>
      {question.choices.map((choice, i) => {
        const tone = !revealed
          ? 'border-neutral-300 bg-white hover:border-sky-400'
          : choice.correct
            ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
            : choice.id === picked
              ? 'border-red-500 bg-red-50 text-red-900'
              : 'border-neutral-200 bg-white text-neutral-400';
        return (
          <button
            key={choice.id}
            type="button"
            disabled={!onPick}
            onClick={() => onPick?.(choice.id, choice.correct)}
            className={`min-h-[4.5rem] rounded-lg border px-3 py-3 text-left text-sm leading-snug ${tone}`}
          >
            <span className="mr-2 text-xs text-neutral-400">{i + 1}</span>
            {question.kind === 'form' ? <span className="text-base font-medium">{choice.text}</span> : choice.text}
          </button>
        );
      })}
    </div>
  );
}

/** 答错时的完整卡背（FR-10.3）。 */
function CardBack({
  entry,
  sentence,
  examples,
}: {
  entry: VocabEntry;
  sentence: string | undefined;
  examples: string[] | null;
}) {
  return (
    <div className="space-y-2 border-t border-neutral-200 pt-4">
      <p className="text-2xl font-semibold">
        {articled(entry.lemma ?? entry.surface, entry.gender)}
        {entry.plural && <span className="ml-2 text-base text-neutral-500">{entry.plural}</span>}
      </p>
      {entry.ipa && <p className="text-sm text-neutral-400">[{entry.ipa}]</p>}
      <p className="text-base">{entry.meaning ?? <span className="text-neutral-400">（释义还没填）</span>}</p>
      {sentence ? (
        <p className="text-sm text-neutral-500">{sentence}</p>
      ) : (
        // 预置卡没有原句，例句来自词典（FR-16.9）
        examples?.map((ex) => (
          <p key={ex} className="text-sm text-neutral-500">
            {ex}
          </p>
        ))
      )}
      {entry.preset && (
        <Hint>
          预置词库 · 口语词频第 {entry.preset.band} 档第 {entry.preset.rank} 名（词频档，不是 CEFR 等级）
        </Hint>
      )}
    </div>
  );
}
