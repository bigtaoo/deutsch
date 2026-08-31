// FR-4 时间戳标注。
//
// 稀疏打点是**设计**（§3.3）：一期 112 句里真正要反复听的可能就五六句。
// 所以这个界面必须让「跳到任意一句直接标」和「顺着播一句标一句」一样顺手，
// 而且不能把「还有 106 句没标」渲染成待办清单。

import { useEffect, useMemo, useRef, useState } from 'react';
import { audioPlayer } from '@/audio/player';
import { useAudioTime, useLessonAudio } from '@/audio/useLessonAudio';
import { resolveRange } from '@/lesson/timing';
import { displayNumbers } from '@/lesson/sentences';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { AudioBar } from '@/components/AudioBar';
import { AutoAlignPanel } from './AutoAlignPanel';
import { reviewQueue } from '@/align/apply';
import { Button, Hint, formatTime } from '@/components/ui';
import type { Lesson, LessonCache, Sentence } from '@/types/models';

const NUDGE_STEPS = [-0.5, -0.1, 0.1, 0.5];

export function TimestampsTab({ lesson }: { lesson: Lesson; cache: LessonCache | undefined }) {
  const audio = useLessonAudio(lesson.id);
  const time = useAudioTime();
  const patchLesson = useLessonStore((s) => s.patchLesson);
  const { settings, update } = useSettingsStore();

  const selectable = useMemo(() => lesson.sentences.filter((s) => !s.excluded), [lesson.sentences]);
  const [selected, setSelectedState] = useState<number>(selectable[0]?.index ?? 0);
  // 连按 Enter 时两次回调可能落在同一帧里，React state 还没重新渲染 ——
  // 那样第二次会重复标注同一句。ref 是同步的，用它做"当前是哪一句"的唯一真相。
  const selectedRef = useRef(selected);
  const setSelected = (index: number) => {
    selectedRef.current = index;
    setSelectedState(index);
  };
  const numbers = useMemo(() => displayNumbers(lesson.sentences), [lesson.sentences]);
  const listRef = useRef<HTMLOListElement>(null);

  // 走 patchLesson 而不是 saveLesson：连按 Enter 打点时，两次回调可能拿到同一个旧快照，
  // 后一次会把前一次的时间戳静默抹掉。
  //
  // FR-15：这个界面里的任何一次改动都意味着「人看过了」，所以一律把 timingSource 升成
  // 'manual' 并清掉置信度。不这么做的话，自动对齐给的低置信句就算你亲手校准过，
  // 也会永远留在待校对列表里，那个列表马上就不可信了。
  const patch = (index: number, changes: Partial<Sentence>) =>
    patchLesson(lesson.id, (current) => ({
      ...current,
      sentences: current.sentences.map((s) =>
        s.index === index
          // changes 放在最后：让调用方能显式覆盖 timingSource —— 「清除时间戳」要的是
          // 退回未标注，而不是「我人工确认这句没有时间戳」（后者会让自动打点永远跳过它）。
          ? { ...s, timingSource: 'manual' as const, timingConfidence: undefined, ...changes }
          : s,
      ),
    }));

  const selectNext = (from: number) => {
    const pos = selectable.findIndex((s) => s.index === from);
    const next = selectable[pos + 1];
    if (next) setSelected(next.index);
  };

  /** FR-4.2：记录当前 currentTime 为选中句的 startTime，并自动选中下一句。 */
  const mark = () => {
    const index = selectedRef.current;
    void patch(index, { startTime: audioPlayer.currentTime });
    selectNext(index);
  };

  const markEnd = () => {
    void patch(selectedRef.current, { endTime: audioPlayer.currentTime, endTimeExplicit: true });
  };

  const clear = (index: number) =>
    patch(index, {
      startTime: undefined,
      endTime: undefined,
      endTimeExplicit: false,
      // 退回「从未标注」，这样下次自动打点会重新填它。
      timingSource: undefined,
      timingConfidence: undefined,
    });

  /** FR-4.5：微调后立即试听，否则要靠脑内换算 0.1 秒听起来是什么样。 */
  const nudge = async (field: 'startTime' | 'endTime', delta: number) => {
    const sentence = lesson.sentences.find((s) => s.index === selected);
    if (!sentence) return;
    // 微调推断出来的终点 = 把它固化成显式终点再挪。否则「终点看得见却调不动」。
    const base =
      field === 'startTime'
        ? sentence.startTime
        : (sentence.endTime ?? resolveRange(lesson.sentences, sentence.index, lesson.audioDuration)?.end);
    if (base === undefined) return;
    const value = Math.max(0, base + delta);
    await patch(selected, field === 'startTime' ? { startTime: value } : { endTime: value, endTimeExplicit: true });
    if (audio.status === 'ready') {
      const preview = field === 'startTime' ? value : Math.max(0, value - 1.5);
      void audioPlayer.playRange(preview, preview + 1.8);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (e.key === 'Enter') { e.preventDefault(); mark(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); selectNext(selected); }
      else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const pos = selectable.findIndex((s) => s.index === selected);
        const prev = selectable[pos - 1];
        if (prev) setSelected(prev.index);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 选中句滚进视野 —— 键盘连续打点时列表必须自己跟着走。
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [selected]);

  const pendingIndexes = useMemo(
    () => new Set(reviewQueue(lesson.sentences).map((s) => s.index)),
    [lesson.sentences],
  );

  const current = lesson.sentences.find((s) => s.index === selected);
  const currentRange = current ? resolveRange(lesson.sentences, current.index, lesson.audioDuration) : null;

  return (
    <div className="space-y-3">
      <Hint>
        播放中按 <kbd className="rounded border px-1">Enter</kbd> 给选中句打点，自动跳到下一句；
        <kbd className="rounded border px-1">↑</kbd>/<kbd className="rounded border px-1">↓</kbd> 换句。
        也可以直接点任意一句跳着标 —— 打点不需要按顺序，也不需要标完。
      </Hint>

      <AutoAlignPanel lesson={lesson} />

      <ol ref={listRef} className="max-h-[52vh] overflow-y-auto rounded-lg border border-neutral-200">
        {lesson.sentences.map((s) => {
          const range = resolveRange(lesson.sentences, s.index, lesson.audioDuration);
          // FR-15：自动对齐给的低置信句标黄。选中态优先 —— 正在校对的那句得看得出来是哪句。
          const needsReview = pendingIndexes.has(s.index);
          return (
            <li
              key={s.index}
              data-index={s.index}
              onClick={() => !s.excluded && setSelected(s.index)}
              className={`flex cursor-pointer gap-3 border-b border-neutral-100 p-2 text-sm ${
                s.index === selected ? 'bg-sky-50' : needsReview ? 'bg-amber-50' : ''
              } ${s.excluded ? 'cursor-default text-neutral-300' : ''}`}
            >
              <span className="w-8 shrink-0 text-right text-xs text-neutral-400">
                {numbers.get(s.index) ?? '—'}
              </span>
              <span className="min-w-0 flex-1 leading-relaxed">{s.text}</span>
              <span className="w-32 shrink-0 text-right font-mono text-xs">
                {range ? (
                  <>
                    <span
                      // FR-4.4：显式终点画实线，推断出来的画虚线 —— 一眼看出哪些是自己定的
                      className={`border-b ${range.explicitEnd ? 'border-solid border-neutral-500' : 'border-dashed border-neutral-400'}`}
                      title={range.explicitEnd ? '显式标记的终点' : '推断的终点（下一个已标注句的起点）'}
                    >
                      {formatTime(range.start)}–{formatTime(range.end)}
                    </span>
                    {/* FR-15：这个 ~ 表示「机器给的，还没人看过」。它和上面的实线/虚线是
                        两个不同维度 —— 自动对齐的终点是显式的（实线），但一点也不等于确认过。 */}
                    {s.timingSource === 'auto' && (
                      <span
                        className={`ml-1 ${needsReview ? 'text-amber-600' : 'text-neutral-400'}`}
                        title={`自动对齐，置信度 ${s.timingConfidence?.toFixed(2) ?? '—'}${
                          needsReview ? '（偏低，建议听一遍）' : ''
                        }`}
                      >
                        ~
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-neutral-300">未标注</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      <AudioBar audio={audio} rate={settings.playbackRate} onRateChange={(r) => void update({ playbackRate: r })}>
        <Button variant="primary" disabled={audio.status !== 'ready'} onClick={mark}>
          标记起点 (Enter)
        </Button>
        <Button disabled={audio.status !== 'ready'} onClick={markEnd}>
          标记终点
        </Button>
        <Button
          disabled={!currentRange || audio.status !== 'ready'}
          onClick={() => currentRange && void audioPlayer.playRange(currentRange.start, currentRange.end)}
        >
          试听本句
        </Button>
        <Button variant="ghost" disabled={!current?.startTime} onClick={() => void clear(selected)}>
          清除本句时间戳
        </Button>

        <span className="ml-2 text-xs text-neutral-500">微调起点</span>
        {NUDGE_STEPS.map((d) => (
          <Button key={`s${d}`} disabled={current?.startTime === undefined} onClick={() => void nudge('startTime', d)}>
            {d > 0 ? `+${d}` : d}
          </Button>
        ))}
        <span className="ml-2 text-xs text-neutral-500">微调终点</span>
        {NUDGE_STEPS.map((d) => (
          <Button
            key={`e${d}`}
            disabled={current?.endTime === undefined && !currentRange}
            onClick={() => void nudge('endTime', d)}
          >
            {d > 0 ? `+${d}` : d}
          </Button>
        ))}
        <span className="ml-2 font-mono text-xs text-neutral-500">现在 {formatTime(time)}</span>
      </AudioBar>

      {current && current.startTime !== undefined && current.blanks.length > 0 && (
        <Hint tone="warn">这一句上有 {current.blanks.length} 处挖空，清除时间戳后听写会不可用（FR-4.6）。</Hint>
      )}
    </div>
  );
}
