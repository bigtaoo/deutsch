// FR-5 通听：全篇连续播放，文本默认折叠。
//
// FR-5.2 的关键是**不做假装的伪同步**：只有真的有时间戳的句子会随进度高亮，
// 其余保持中性。按字数估算位置的「伪同步」会让人误以为对齐已经做过了。
//
// 展开之后是逐词高亮（卡拉OK / Spotify 那种）：句级高亮告诉你「读到第几句」，
// 词级高亮才告诉你「读到句子里的哪儿」—— 而这个应用的全部目的是听觉识别，
// 「听到的这一串音是屏幕上的哪个词」正是要练的那一步。数据是自动对齐顺带算出来的
// 词级时间戳（Sentence.words），没有额外代价。
//
// 逐词高亮时这个组件每帧都会重渲染（useAudioTime 走 rAF），所以每一行都是 memo 的：
// 一帧里真正变的只有「上一行」和「当前行」两行。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLessonAudio, useAudioTime } from '@/audio/useLessonAudio';
import { audioPlayer } from '@/audio/player';
import { reviewQueue } from '@/align/apply';
import { activeAt, buildKaraoke, type KaraokeLine } from '@/lesson/karaoke';
import { displayNumbers } from '@/lesson/sentences';
import { AudioBar } from '@/components/AudioBar';
import { Button, Hint } from '@/components/ui';
import { useSettingsStore } from '@/state/useSettingsStore';
import type { Lesson, LessonCache } from '@/types/models';

export function ListenTab({ lesson }: { lesson: Lesson; cache: LessonCache | undefined }) {
  const audio = useLessonAudio(lesson.id);
  const time = useAudioTime();
  const [expanded, setExpanded] = useState(false);
  const [follow, setFollow] = useState(true);
  const { settings, update } = useSettingsStore();

  const numbers = useMemo(() => displayNumbers(lesson.sentences), [lesson.sentences]);
  const lines = useMemo(
    () => buildKaraoke(lesson.sentences, lesson.audioDuration),
    [lesson.sentences, lesson.audioDuration],
  );
  const lowConfidence = useMemo(
    () => new Set(reviewQueue(lesson.sentences).map((s) => s.index)),
    [lesson.sentences],
  );

  const active = expanded ? activeAt(lines, time) : null;
  const activeLine = active?.line ?? null;
  const timedLines = lines.filter((l) => l.range !== null).length;
  const wordLines = lines.filter((l) => l.hasWords).length;

  const boxRef = useRef<HTMLOListElement>(null);
  const rows = useRef(new Map<number, HTMLLIElement>());
  const register = useCallback((index: number, el: HTMLLIElement | null) => {
    if (el) rows.current.set(index, el);
    else rows.current.delete(index);
  }, []);

  // 当前行滚到视野中间。滚的是这个框自己（offsetTop 相对它，因为它是 relative），
  // 不用 scrollIntoView —— 那个会把整页也一起带着跳。
  const scrolled = useRef<number | null>(null);
  useEffect(() => {
    if (!follow || activeLine === null || scrolled.current === activeLine) return;
    scrolled.current = activeLine;
    const box = boxRef.current;
    const row = rows.current.get(activeLine);
    if (!box || !row) return;
    box.scrollTo({ top: row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2, behavior: 'smooth' });
  }, [follow, activeLine]);

  // 展开、或者重新打开跟随时，忘掉「已经滚过哪一行」—— 否则当前行正好等于上次滚到的那行时
  // 会一动不动，用户点了「跟随播放」却看不见任何反应。
  const restart = () => {
    scrolled.current = null;
  };

  const seek = useCallback((to: number) => {
    // 点了词就是要听它，所以直接播。这是一次用户手势，iOS 上也放得出来（§3.2）。
    void audioPlayer.play(to);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => {
            restart();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? '折叠文本' : '展开文本'}
        </Button>
        {expanded ? (
          <>
            <Button
              variant={follow ? 'primary' : 'ghost'}
              onClick={() => {
                restart();
                setFollow((v) => !v);
              }}
            >
              {follow ? '跟随播放' : '不跟随'}
            </Button>
            <Hint>点任意一个词从那里开始播。</Hint>
          </>
        ) : (
          <Hint>先不看文本听一遍。文本默认折叠不是为了省地方，是为了逼自己先用耳朵。</Hint>
        )}
      </div>

      {expanded && timedLines === 0 && (
        <Hint tone="warn">
          这一课还没有时间戳，展开只是一份文本，不会有任何高亮。去页头点「自动对齐」。
        </Hint>
      )}
      {expanded && timedLines > 0 && wordLines === 0 && (
        <Hint tone="warn">
          只有句级时间戳，所以只能整句高亮 —— 这一课多半是在词级时间戳搬进标注层之前对齐的。
          在跑得动对齐的设备上重新对齐一次就有了，之后它会跟着同步到别的设备。
        </Hint>
      )}

      {expanded && (
        <ol
          ref={boxRef}
          onWheel={() => setFollow(false)}
          onTouchMove={() => setFollow(false)}
          className="relative max-h-[60vh] space-y-1 overflow-y-auto rounded-lg border border-neutral-200 p-3"
        >
          {lines.map((line) => (
            <Line
              key={line.index}
              line={line}
              number={numbers.get(line.index)}
              lowConfidence={lowConfidence.has(line.index)}
              state={line.index === activeLine ? (active!.inside ? 'current' : 'just-read') : 'idle'}
              activeToken={line.index === activeLine ? active!.token : null}
              onSeek={seek}
              register={register}
            />
          ))}
        </ol>
      )}

      <AudioBar
        audio={audio}
        rate={settings.playbackRate}
        onRateChange={(rate) => void update({ playbackRate: rate })}
      />
    </div>
  );
}

type LineState = 'current' | 'just-read' | 'idle';

const LINE_STATE: Record<LineState, string> = {
  current: 'bg-amber-50 text-neutral-900',
  // 刚读完（落在两句之间的空档）：留一道左边线，别整块亮着 —— 否则看不出高亮已经走过去了
  'just-read': 'border-l-2 border-amber-300 text-neutral-900',
  idle: 'text-neutral-600',
};

const Line = memo(function Line({
  line,
  number,
  lowConfidence,
  state,
  activeToken,
  onSeek,
  register,
}: {
  line: KaraokeLine;
  number: number | undefined;
  lowConfidence: boolean;
  state: LineState;
  activeToken: number | null;
  onSeek: (to: number) => void;
  register: (index: number, el: HTMLLIElement | null) => void;
}) {
  return (
    <li
      ref={(el) => register(line.index, el)}
      className={`rounded px-2 py-1 text-sm leading-relaxed ${
        line.excluded ? 'text-neutral-300' : LINE_STATE[state]
      }`}
    >
      <span
        className={`mr-2 text-xs ${lowConfidence ? 'text-amber-600' : 'text-neutral-400'}`}
        title={lowConfidence ? '这一句的对齐置信度明显低于本课水平，值得亲耳确认' : undefined}
      >
        {number ?? '—'}
        {lowConfidence && '?'}
      </span>
      {line.tokens.map((token, i) =>
        token.time ? (
          <span
            key={token.start}
            onClick={() => onSeek(token.time!.start)}
            className={`cursor-pointer rounded hover:bg-neutral-100 ${
              i === activeToken ? 'bg-amber-200 font-medium' : ''
            }`}
          >
            {token.text}
          </span>
        ) : (
          // 时间戳追不到的部分（标点、空白、没有句级时间戳的整句）不可点也不高亮。
          // 整句没有时间戳时点句号也没意义 —— 不知道该跳到哪儿。
          <span
            key={token.start}
            onClick={line.range ? () => onSeek(line.range!.start) : undefined}
            className={line.range ? 'cursor-pointer' : undefined}
          >
            {token.text}
          </span>
        ),
      )}
    </li>
  );
});
