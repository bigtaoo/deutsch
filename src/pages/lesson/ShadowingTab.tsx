// FR-6 跟读模式 —— §9 里排在最前面的界面，因为它每次都会用。
//
// 只在**已标注**的句子间循环（FR-6.4）：未标注句没有区间，播不了，
// 混进队列就会变成「点了没声音」的死角（§3.3 R3）。

import { useEffect, useMemo, useRef, useState } from 'react';
import { audioPlayer } from '@/audio/player';
import { useLessonAudio } from '@/audio/useLessonAudio';
import { ShadowingMachine, type PlayRange, type ShadowingState } from '@/audio/shadowing';
import { annotatedSentences, resolveRange } from '@/lesson/timing';
import { displayNumbers } from '@/lesson/sentences';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { PLAYBACK_RATES, RateSwitch } from '@/components/AudioBar';
import { Banner, Button, Card, EmptyState, Hint, field } from '@/components/ui';
import type { Lesson, LessonCache } from '@/types/models';

export function ShadowingTab({ lesson }: { lesson: Lesson; cache: LessonCache | undefined }) {
  const audio = useLessonAudio(lesson.id);
  const patchLesson = useLessonStore((s) => s.patchLesson);
  const { settings, update } = useSettingsStore();
  const [difficultOnly, setDifficultOnly] = useState(false);
  const [state, setState] = useState<ShadowingState>({
    phase: 'idle',
    position: -1,
    repeatsLeft: 0,
    gapStartedAt: 0,
    gapMs: 0,
  });

  const machineRef = useRef<ShadowingMachine>(null);
  if (!machineRef.current) machineRef.current = new ShadowingMachine({ player: audioPlayer });
  const machine = machineRef.current;

  useEffect(() => machine.subscribe(setState), [machine]);
  useEffect(() => () => machine.stop(), [machine]);

  const numbers = useMemo(() => displayNumbers(lesson.sentences), [lesson.sentences]);

  const queue = useMemo<PlayRange[]>(() => {
    return annotatedSentences(lesson.sentences)
      .filter((s) => !difficultOnly || s.markedDifficult)
      .map((s) => {
        const range = resolveRange(lesson.sentences, s.index, lesson.audioDuration)!;
        return { sentenceIndex: s.index, start: range.start, end: range.end };
      });
  }, [lesson.sentences, lesson.audioDuration, difficultOnly]);

  useEffect(() => {
    machine.setQueue(queue, { gapRatio: settings.shadowingGapRatio, repeat: settings.shadowingRepeat });
  }, [machine, queue, settings.shadowingGapRatio, settings.shadowingRepeat]);

  // §3.2：手机锁屏/切后台会打断循环。暂停并保留位置，不做后台播放。
  useEffect(() => {
    const onHidden = () => document.hidden && machine.stop();
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [machine]);

  const currentSentenceIndex = machine.current()?.sentenceIndex ?? null;

  const toggleDifficult = (index: number | null) => {
    if (index === null) return;
    void patchLesson(lesson.id, (current) => ({
      ...current,
      sentences: current.sentences.map((s) =>
        s.index === index ? { ...s, markedDifficult: !s.markedDifficult } : s,
      ),
    }));
  };

  const changeRate = (delta: number) => {
    const pos = PLAYBACK_RATES.indexOf(settings.playbackRate as (typeof PLAYBACK_RATES)[number]);
    const next = PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0, (pos < 0 ? 2 : pos) + delta))];
    audioPlayer.setRate(next);
    void update({ playbackRate: next });
  };

  // FR-6.5 快捷键。输入框里不拦截 —— 这个 tab 没有输入框，但设置面板有数字框。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      switch (e.key) {
        case ' ': e.preventDefault(); machine.replay(); break;
        case 'ArrowRight': e.preventDefault(); machine.next(); break;
        case 'ArrowLeft': e.preventDefault(); machine.previous(); break;
        case 'd': case 'D': e.preventDefault(); toggleDifficult(currentSentenceIndex); break;
        case '+': case '=': e.preventDefault(); changeRate(1); break;
        case '-': e.preventDefault(); changeRate(-1); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (audio.status === 'ready' && queue.length === 0) {
    return (
      <EmptyState>
        {difficultOnly
          ? '还没有标记为困难的句子。跟读时按 D 标记跟不上的那几句。'
          : '这一课还没有任何时间戳 —— 自动对齐还没跑过或没跑成。去课程页头部点一次「自动对齐」。'}
        <div className="mt-3">
          <Button onClick={() => setDifficultOnly(false)} disabled={!difficultOnly}>
            看全部已对齐句
          </Button>
        </div>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      {audio.status !== 'ready' && (
        <Banner tone="warn" title="音频不可用，跟读无法开始">
          {audio.error && <p>{audio.error}</p>}
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-ui">
          <input
            type="checkbox"
            checked={difficultOnly}
            onChange={(e) => setDifficultOnly(e.target.checked)}
          />
          只练标记为困难的句子
        </label>
        <label className="flex items-center gap-2 text-ui">
          每句重复
          <input
            type="number"
            min={0}
            className={`${field} w-16 px-2 py-1`}
            value={settings.shadowingRepeat}
            onChange={(e) => void update({ shadowingRepeat: Math.max(0, Number(e.target.value) || 0) })}
          />
          <span className="text-muted">次（0 = 无限，手动推进）</span>
        </label>
        <label className="flex items-center gap-2 text-ui">
          静默间隔 ×
          <input
            type="number"
            min={0.2}
            step={0.1}
            className={`${field} w-16 px-2 py-1`}
            value={settings.shadowingGapRatio}
            onChange={(e) => void update({ shadowingGapRatio: Number(e.target.value) || 1.2 })}
          />
        </label>
      </div>

      <CurrentSentenceCard
        lesson={lesson}
        state={state}
        sentenceIndex={currentSentenceIndex}
        displayNumber={currentSentenceIndex !== null ? numbers.get(currentSentenceIndex) : undefined}
      />

      <div className="flex flex-wrap items-center gap-2">
        {state.phase === 'idle' ? (
          <Button variant="primary" disabled={audio.status !== 'ready'} onClick={() => machine.start()}>
            开始跟读
          </Button>
        ) : (
          <Button variant="primary" onClick={() => machine.stop()}>
            停止
          </Button>
        )}
        <Button onClick={() => machine.previous()}>← 上一句</Button>
        <Button onClick={() => machine.replay()}>重播 (Space)</Button>
        <Button onClick={() => machine.next()}>下一句 →</Button>
        <Button
          variant={
            currentSentenceIndex !== null && lesson.sentences[currentSentenceIndex]?.markedDifficult
              ? 'primary'
              : 'secondary'
          }
          onClick={() => toggleDifficult(currentSentenceIndex)}
        >
          标记困难 (D)
        </Button>
        <RateSwitch
          rate={settings.playbackRate}
          onChange={(r) => void update({ playbackRate: r })}
        />
      </div>

      <Hint>
        队列 {queue.length} 句 · Space 重播 · ←/→ 换句 · D 标困难 · +/- 变速。
        变速即时生效，不重启当前句。
      </Hint>
    </div>
  );
}

function CurrentSentenceCard({
  lesson,
  state,
  sentenceIndex,
  displayNumber,
}: {
  lesson: Lesson;
  state: ShadowingState;
  sentenceIndex: number | null;
  displayNumber: number | undefined;
}) {
  const sentence = sentenceIndex !== null ? lesson.sentences[sentenceIndex] : undefined;

  return (
    <Card className="space-y-3 p-6">
      {sentence ? (
        <>
          <div className="flex items-baseline gap-3">
            <span className="text-note text-faint">第 {displayNumber ?? '—'} 句</span>
            {sentence.markedDifficult && (
              <span className="rounded-ctl bg-warn-soft px-2 py-0.5 text-note text-warn">困难</span>
            )}
            <span className="text-note text-faint">
              {state.repeatsLeft === Infinity ? '手动推进' : `还剩 ${state.repeatsLeft} 遍`}
            </span>
          </div>
          <p className="text-de">{sentence.text}</p>
        </>
      ) : (
        <p className="text-faint">按「开始跟读」进入循环。</p>
      )}

      <GapCountdown state={state} />
    </Card>
  );
}

/** FR-6.6：静默间隔要有看得见的倒计时 —— 让人知道该开口了。用 rAF 自己画，机器不逐帧发状态。 */
function GapCountdown({ state }: { state: ShadowingState }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (state.phase !== 'gap') {
      setProgress(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      const elapsed = Date.now() - state.gapStartedAt;
      setProgress(Math.min(1, elapsed / state.gapMs));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.phase, state.gapStartedAt, state.gapMs]);

  if (state.phase !== 'gap') {
    return (
      <div className="h-2 rounded-ctl bg-sunken">
        <div className={`h-2 rounded-ctl ${state.phase === 'playing' ? 'w-full bg-accent' : 'w-0'}`} />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="h-2 overflow-hidden rounded-ctl bg-ok-soft">
        <div className="h-2 bg-ok transition-none" style={{ width: `${(1 - progress) * 100}%` }} />
      </div>
      <p className="text-note text-ok">现在跟读 —— 还有 {((1 - progress) * (state.gapMs / 1000)).toFixed(1)} 秒</p>
    </div>
  );
}
