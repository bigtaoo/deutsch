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
//
// ── FR-21：队列里有两种卡 ──
// 一个词挂两张独立调度的卡：**听卡**（上面说的那种）与**读卡**（正面是文字，
// 不放声音）。队列的单位因此是 `ReviewCard`（词 + 是哪一张），不是词本身 ——
// 同一个词的两张卡不会在同一天出现（FR-21.3），但会在不同的日子各自到期。
//
// 界面上两者**必须一眼分得出来，而且不能靠「有没有声音」去分**（§12.13）：
// 长得一样的话，每次进读卡都要先愣一秒等声音。所以卡顶那行题干是必需的，
// 它同时说清了这一关考什么。

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_LESSON_TAB, navigate } from '@/app/router';
import { audioPlayer } from '@/audio/player';
import { playSfx, preloadSfx } from '@/audio/sfx';
import { getAudioBlob } from '@/db/cache';
import { resolveRange } from '@/lesson/timing';
import { buildReviewQueue, cardAudioStatus, newCardShortfall, type Deck, type ReviewCard } from '@/srs/queue';
import { formatInterval, review } from '@/srs/fsrs';
import { articled, gradeFromAnswer } from '@/srs/grade';
import { buildQuestion, buildReadQuestion } from '@/srs/questionSource';
import { choicesAreWords } from '@/srs/choices';
import { syncVocabNow } from '@/sync/trigger';
import { loadDeck, lookupDict } from '@/dict/lookup';
import { ensureWordAudio, germanVoice, speak, type WordAudioSource } from '@/dict/audio';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore } from '@/state/useVocabStore';
import { Banner, Button, Card, EmptyState, Hint } from '@/components/ui';
import type { Question } from '@/srs/choices';
import type { Lesson, VocabEntry } from '@/types/models';

/** 答对之后那一闪的时长（FR-10.11）。600ms 看不完卡背，但看得完 `der Vorhang`。 */
const FLASH_MS = 600;

/**
 * 点击音和判定音之间隔多久（FR-10.12）。
 *
 * 不能是 0：点击音 43ms、判定音紧跟着起头，两个一起响会糊成一声，
 * 而这两声要说的是两件事（「收到了」和「对/错」）。也不能太长 ——
 * 判定音要压在那 600ms 的闪之内，否则它落在下一张卡上。
 */
const VERDICT_SFX_MS = 120;

type Phase = 'asking' | 'flash' | 'revealed';

export function ReviewPage() {
  const { entries, updateEntry, topUpNewCards, openReadCards, loaded } = useVocabStore();
  const { lessons, caches } = useLessonStore();
  const { settings } = useSettingsStore();

  // 队列在进入页面时算一次并冻结：随着评分实时重算会让卡片在手底下跳来跳去。
  const [session, setSession] = useState<ReviewCard[] | null>(null);
  const [position, setPosition] = useState(0);
  const [finished, setFinished] = useState(false);
  /** FR-17.4：进页面时先把今天缺的新卡从已报名的档里补上。 */
  const [topUp, setTopUp] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('asking');
  const [picked, setPicked] = useState<string | null>(null);
  const [nextDue, setNextDue] = useState<Date | null>(null);

  const breakdownRef = useRef<ReturnType<typeof buildReviewQueue> | null>(null);

  // FR-10.12：三个音效一共 43KB，进页面时先取好。等第一次答题才去 fetch 的话，
  // 那一声会比「答对」的闪晚半秒到 —— 而晚到的反馈比没有反馈更分神。
  useEffect(() => {
    if (settings.soundEffects) void preloadSfx();
  }, [settings.soundEffects]);

  useEffect(() => {
    if (!loaded || session !== null) return;
    let cancelled = false;
    void (async () => {
      // 激活要先于建队列 —— 否则今天新激活的卡要等下次进页面才看得到。
      //
      // FR-21.2：**开读卡排在补预置新卡前面**。两者共用 newPerDay 这一个额度，
      // 谁先谁就先占 —— 而「已经在学的词加深」比「再发一个陌生词」更值得占。
      const quota = newCardShortfall(useVocabStore.getState().entries, {
        newPerDay: settings.newPerDay,
      });
      if (quota > 0) {
        const opened = await openReadCards(quota).catch(() => []);
        if (!cancelled && opened.length > 0) setTopUp(`今天新开了 ${opened.length} 张识词卡`);
      }
      if (cancelled) return;
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
  const item = queue[position];
  const deck: Deck = item?.deck ?? 'listen';
  // 评分会改 entries，卡面要用最新的那一份
  const current = item ? (entries.find((e) => e.id === item.entry.id) ?? item.entry) : undefined;
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
      // FR-21.1：评分落在**这一次作答的那张卡**上。两张卡的 FSRS 状态各自演化 ——
      // 写错一边的症状是静默的：读卡答对了却把听卡的间隔拉长。
      const card = deck === 'listen' ? current.fsrs : (current.fsrsRead ?? current.fsrs);
      // FR-10.12：判定音。**排在评分前面**发起（只是个定时器），因为下面这几行
      // 有一次 await 落库 —— 在慢一点的手机上那是几十毫秒，足够让声音听着像延迟。
      if (settings.soundEffects) {
        const verdict = correct ? 'right' : 'wrong';
        setTimeout(() => playSfx(verdict), VERDICT_SFX_MS);
      }
      const rating = gradeFromAnswer({ correct, gaveUp: choiceId === null, elapsedMs }, card);
      const next = review(card, rating);
      setNextDue(new Date(next.due));
      await updateEntry(deck === 'listen' ? { ...current, fsrs: next } : { ...current, fsrsRead: next });
      if (correct) {
        setPhase('flash');
      } else {
        setPhase('revealed');
      }
    },
    [current, deck, phase, settings.soundEffects, updateEntry],
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
        <p className="text-ui">{finished ? '这一轮做完了。' : '今天没有到期的卡片。'}</p>
        {breakdown?.nextDueAt && (
          <p className="mt-2">下一张卡 {new Date(breakdown.nextDueAt).toLocaleString('zh-CN', { hour12: false })} 到期。</p>
        )}
        {(settings.enrolledBands ?? []).length === 0 && entries.length === 0 && (
          <p className="mt-2 text-ui">
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
      <div className="flex flex-wrap items-baseline gap-x-3 text-ui text-muted">
        <span>
          {position + 1} / {queue.length}
        </span>
        {breakdown && (
          <span>
            新卡 {breakdown.newCount} · 复习 {breakdown.reviewCount}
          </span>
        )}
        {topUp && <span className="text-ok">{topUp}</span>}
      </div>

      <QuizCard
        // key 让每张卡都是新的组件实例：组题、音频、计时全部随之重置，
        // 不必在一堆 effect 里手工清状态。**带上 deck**：同一个词的两张卡
        // 虽然不会在同一天相邻出现，但 key 相同会让第二张复用第一张的状态。
        key={`${current.id}:${deck}`}
        deck={deck}
        entry={current}
        entries={entries}
        lesson={lesson}
        hasMaterial={Boolean(current.lessonId && caches[current.lessonId]?.hasAudio)}
        soundOn={settings.soundEffects}
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
  deck,
  entry,
  entries,
  lesson,
  hasMaterial,
  soundOn,
  phase,
  picked,
  nextDue,
  onAnswer,
  onContinue,
}: {
  deck: Deck;
  entry: VocabEntry;
  entries: VocabEntry[];
  lesson: Lesson | undefined;
  hasMaterial: boolean;
  soundOn: boolean;
  phase: Phase;
  picked: string | null;
  nextDue: Date | null;
  onAnswer: (choiceId: string | null, correct: boolean, elapsedMs: number) => void;
  onContinue: () => void;
}) {
  // FR-21.5：读卡正面是文字、不放声音，所以下面所有跟音频有关的分支都绕开它。
  // audioStatus 仍然算出来 —— 卡背上要不要显示「孤立词发音」那行还看它。
  const isRead = deck === 'read';
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
    const building = isRead
      ? buildReadQuestion(entry, entries, loadDeck)
      : buildQuestion(entry, entries, loadDeck);
    void building.then((q) => {
      if (cancelled) return;
      setQuestion(q);
      startedAt.current = Date.now();
    });
    return () => {
      cancelled = true;
    };
    // entries 每答一题都会变，但这张卡的题目只组一次 —— 不然选项会在手底下重排
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, isRead]);

  // 正面自动播一次（FR-10.2）。课程卡放句子，预置卡放孤立词。
  useEffect(() => {
    let cancelled = false;
    setPlayable(false);
    if (isRead || audioStatus !== 'ok' || !range || !lesson) return;
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
  }, [entry.id, audioStatus, isRead, lesson, range]);

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
    if (isRead || audioStatus !== 'word-only') return;
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
  }, [entry.id, entry.surface, audioStatus, isRead]);

  // 答错时才取例句。`word-only` 这一档就是「没有原句的卡」——
  // 预置词库与查词加进来的词都在里面，两者都只能靠词典里的例句撑起卡背。
  //
  // FR-21.6：读卡开卡时已经把句子拷进 `entry.examples` 了，那一份优先 ——
  // 它就是 cloze 题面用的那一句，卡背上显示别的句子会让人以为自己看错了题。
  useEffect(() => {
    if (phase !== 'revealed' || examples !== null) return;
    if (entry.examples?.length) {
      setExamples(entry.examples);
      return;
    }
    if (!isRead && audioStatus !== 'word-only') return;
    let cancelled = false;
    void lookupDict(entry.surface).then((hit) => {
      if (!cancelled) setExamples(hit?.entry.ex ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [phase, audioStatus, isRead, entry.surface, entry.examples, examples]);

  /**
   * FR-10.12：点击音。**在这里响、不在 ChoiceGrid 里响** —— 它同时要盖住
   * 键盘那条路（1–4 选项），而那条路也走这个函数。
   *
   * 它还兼着一件 iOS 上必需的事：AudioContext 只能在用户手势里 resume，
   * 而这是复习页上唯一保证发生在手势中的调用点。
   */
  const tap = () => {
    if (soundOn) playSfx('tap');
  };

  const choose = (id: string, correct: boolean) => {
    tap();
    onAnswer(id, correct, Date.now() - startedAt.current);
  };

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

  const noAudio = !isRead && audioStatus === 'word-only' && wordSource === 'none';

  return (
    <>
      {/* FR-10.11：答对时那 600ms 是名词的性在主路径上唯一露脸的机会 */}
      <div className="flex h-9 items-center justify-center">
        {phase === 'flash' && (
          <p className="text-de font-semibold text-ok">
            ✓ {articled(entry.lemma ?? entry.surface, entry.gender)}
            {nextDue && <span className="ml-2 text-ui font-normal text-muted">下次 {formatInterval(nextDue)}后</span>}
          </p>
        )}
      </div>

      {/* 卡面撑满剩余高度并把内容居中：正面只有一个播放键（FR-10.2），
          靠上贴着标题行的话，播放键和底部的选项之间会空掉半屏。
          选项那一块仍然由 `mt-auto` 钉在底部（FR-10.7），所以按钮位置不受影响。 */}
      <Card className="flex flex-1 flex-col justify-center space-y-4 p-6">
        {isRead ? (
          <ReadPrompt question={question} />
        ) : audioStatus === 'ok' ? (
          <div className="flex flex-col items-center gap-2">
            <PlayButton disabled={!playable} onClick={() => range && void audioPlayer.playRange(range.start, range.end)} />
            <p className="text-note text-faint">听这一句，选出挖掉的那个词</p>
          </div>
        ) : audioStatus === 'word-only' ? (
          <div className="flex flex-col items-center gap-2">
            <PlayButton disabled={wordSource === 'loading' || wordSource === 'none'} onClick={() => void playWord()} />
            {noAudio ? (
              // FR-10.5：绝不静默降级。真人音没有、系统又没有德语嗓音时，
              // 这张卡确实只能看文字 —— 那就明说，并且把词显示出来（否则题面是空的）。
              <Banner tone="warn" title="这张卡没有声音，只能当文字卡用">
                <p>
                  Wiktionary 上没有 <b>{entry.surface}</b> 的录音，系统里也没有德语嗓音。
                </p>
              </Banner>
            ) : (
              <p className="text-note text-faint">
                {wordSource === 'human' ? '真人录音（Wiktionary，CC BY-SA）' : wordSource === 'tts' ? '系统合成音' : '取音频中…'}
                {' · '}孤立词发音，练不到连读
              </p>
            )}
          </div>
        ) : (
          // FR-10.5：两种无音频原因给不同出口，绝不静默降级成纯文本卡
          audioStatus === 'no-timestamp' ? (
            <Banner
              tone="warn"
              title="这张卡没有音频：来源句还没有时间戳"
              action={
                lesson && (
                  <Button
                    onClick={() =>
                      navigate({ name: 'lesson', lessonId: lesson.id, tab: DEFAULT_LESSON_TAB })
                    }
                  >
                    去这一课重新对齐
                  </Button>
                )
              }
            >
              <p>自动对齐没覆盖到它。</p>
            </Banner>
          ) : (
            <Banner
              tone="warn"
              title="这张卡没有音频：本机没有这一课的素材"
              action={<Button onClick={() => navigate({ name: 'sources' })}>去下载素材</Button>}
            >
              <p>《{lesson?.title ?? '这一课'}》—— 一键可解。</p>
            </Banner>
          )
        )}

        {/* 没有任何音源时把词显示出来，否则这道题无从下手 */}
        {noAudio && <p className="text-center text-word font-semibold">{entry.surface}</p>}

        {phase === 'revealed' && (
          <CardBack
            entry={entry}
            sentence={sentence?.text}
            examples={examples}
            onPlayWord={isRead ? () => void playWord() : undefined}
          />
        )}
      </Card>

      <div className="mt-auto space-y-2">
        {question === null ? (
          <p className="py-4 text-center text-ui text-faint">组题中…</p>
        ) : phase === 'revealed' ? (
          <>
            <ChoiceGrid question={question} picked={picked} revealed />
            <Button variant="primary" className="w-full py-4 text-de" onClick={onContinue}>
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
            {/* FR-10.8 / FR-21.11：这个出口不能省 —— 四选一有 25% 瞎猜命中率，
                没有它，猜对会被记成 Good，卡会越来越晚才回来。
                **读卡上不写「没听清」**：那张卡从头到尾没有声音，一个说不通的
                选项会让人犹豫一下它是不是点错了地方。 */}
            <Button
              className="w-full py-3"
              disabled={phase !== 'asking'}
              onClick={() => {
                tap();
                onAnswer(null, false, Date.now() - startedAt.current);
              }}
            >
              {isRead ? '不认识' : '没听清 / 不认识'}
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
      className="flex size-20 items-center justify-center rounded-full bg-accent text-word text-accent-ink transition active:scale-95 disabled:opacity-40"
    >
      ▶
    </button>
  );
}

/**
 * §12.13：读卡的题面。
 *
 * **这一行题干不是装饰。** 听卡进去就自动播一次，读卡什么都不播 ——
 * 两张卡长得一样的话，每次进读卡都会先愣一秒等声音。所以卡顶用人话
 * 说清这一关考什么，它同时就是「这是哪一张卡」的答案。
 */
const READ_LABEL: Record<string, string> = {
  'read-gloss': '这个词是什么意思',
  'read-form': '哪个词是这个意思',
  cloze: '哪个词填得进这个空',
};

function ReadPrompt({ question }: { question: Question | null }) {
  // 长句默认收到两行（§12.13）：cloze 考的是那个空，不是耐心。
  // 点一下展开 —— 不给「展开」按钮而是整句可点，是因为按钮要占一行，
  // 而这一块下面紧跟着的就是选项。
  const [expanded, setExpanded] = useState(false);
  if (!question) return <p className="text-center text-ui text-faint">组题中…</p>;

  return (
    <div className="space-y-3">
      <p className="text-center text-note text-faint">{READ_LABEL[question.kind] ?? ''}</p>
      {question.kind === 'read-gloss' ? (
        // 题面给裸词形、不带冠词：冠词会顺手把性教掉，而性该在答对的 600ms
        // 和卡背上给（FR-10.11）—— 题面里带着它，反向题就再也考不到它了。
        <p className="text-center text-word font-semibold">{question.prompt}</p>
      ) : question.kind === 'cloze' ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`w-full text-left text-de leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}
        >
          {question.prompt}
        </button>
      ) : (
        <p className="text-center text-de leading-relaxed">{question.prompt}</p>
      )}
    </div>
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
  // 列数按**选项里放的是什么**分，而不是一套响应式断点走到底（实测 430px 下
  // 两种题都会变单列）：选项是短词时手机上 2×2 按起来更省手；选项是截到 80 字符
  // 的释义时，挤进半个屏宽会折成四五行，那时单列才读得下去。
  // 判据落在 choicesAreWords 上而不是列举题型（§12.13）——
  // FR-21 一次加了三种题，按题型列举的写法漏一种就是一屏挤成四行。
  const words = choicesAreWords(question.kind);
  const cols = words ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2';
  return (
    <div className={`grid gap-2 ${cols}`}>
      {question.choices.map((choice, i) => {
        const tone = !revealed
          ? 'border-line-strong bg-raised hover:border-accent'
          : choice.correct
            ? 'border-ok bg-ok-soft text-ok'
            : choice.id === picked
              ? 'border-danger bg-danger-soft text-danger'
              : 'border-line bg-raised text-faint';
        return (
          <button
            key={choice.id}
            type="button"
            disabled={!onPick}
            onClick={() => onPick?.(choice.id, choice.correct)}
            className={`min-h-[4.5rem] rounded-box border px-3 py-3 text-left text-ui leading-snug ${tone}`}
          >
            <span className="mr-2 text-note text-faint">{i + 1}</span>
            {words ? <span className="text-de font-medium">{choice.text}</span> : choice.text}
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
  onPlayWord,
}: {
  entry: VocabEntry;
  sentence: string | undefined;
  examples: string[] | null;
  /**
   * §12.13：读卡的卡背上多一个「念一遍」。**这是读卡唯一出现声音的地方** ——
   * 卡面上不给（给了两张卡又变回一张），而「我认得这个词但从没听过它」
   * 正是答错之后最该被补上的那件事。听卡不传这个 prop：它刚刚才播过。
   */
  onPlayWord?: () => void;
}) {
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <p className="text-word font-semibold">
        {articled(entry.lemma ?? entry.surface, entry.gender)}
        {entry.plural && <span className="ml-2 text-ui text-muted">{entry.plural}</span>}
        {onPlayWord && (
          <button
            type="button"
            onClick={onPlayWord}
            className="ml-3 rounded-box border border-line px-2 py-1 align-middle text-note text-muted active:scale-95"
          >
            ♪ 念一遍
          </button>
        )}
      </p>
      {entry.ipa && <p className="text-ui text-faint">[{entry.ipa}]</p>}
      <p className="text-ui">{entry.meaning ?? <span className="text-faint">（释义还没填）</span>}</p>
      {/* FR-21.9：中译只出现在卡背，题面一律德语（词典的中译只覆盖约 60%，凑不齐四个选项） */}
      {entry.meaningZh && <p className="text-ui text-muted">{entry.meaningZh}</p>}
      {/* FR-9.12：从 AI 会话里接回来的详细解释。**排在词典释义之后** ——
          它是三百字的辨析，先出现的话卡背就变成一篇文章，而卡背的第一件事
          仍然是「这个词是什么」。答错才会看到这里，篇幅长是对的。 */}
      {entry.note && (
        <p className="whitespace-pre-line border-l-2 border-line pl-3 text-ui text-muted">
          {entry.note}
        </p>
      )}
      {sentence ? (
        <p className="text-ui text-muted">{sentence}</p>
      ) : (
        // 预置卡没有原句，例句来自词典（FR-16.9）
        examples?.map((ex) => (
          <p key={ex} className="text-ui text-muted">
            {ex}
          </p>
        ))
      )}
      {entry.preset && (
        <Hint>
          预置词库 · 口语词频第 {entry.preset.band} 档第 {entry.preset.rank} 名（词频档，不是 CEFR 等级）
        </Hint>
      )}
      {entry.lookup && <Hint>查词时加进来的词，不来自这里的任何一课</Hint>}
    </div>
  );
}
