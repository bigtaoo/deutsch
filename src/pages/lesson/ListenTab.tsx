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
import { hasTranslations } from '@/lesson/translation';
import { AudioBar } from '@/components/AudioBar';
import { LessonNotes } from './LessonNotes';
import { Button, Hint } from '@/components/ui';
import { useSettingsStore } from '@/state/useSettingsStore';
import type { Lesson, LessonCache } from '@/types/models';

// 手动滚动之后多久自动回到当前句。短到不用等，长到够看完上面那一两句。
const RESUME_MS = 5000;

export function ListenTab({ lesson }: { lesson: Lesson; cache: LessonCache | undefined }) {
  const audio = useLessonAudio(lesson.id);
  const time = useAudioTime();
  const [expanded, setExpanded] = useState(false);
  const [follow, setFollow] = useState(true);
  // 手动滚动只是**暂时**接管（往回看一眼上文），不是关掉跟随 —— 停手几秒就自己回到当前句。
  // 旧行为是滚一下就永久变成「不跟随」，而这件事每次展开文本时几乎必然发生一次：
  // 于是默认值写着 true，用户看到的却总是「不跟随」，文本从此一动不动。
  const [paused, setPaused] = useState(false);
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
  // FR-19.4：有译文才有这个开关 —— 没贴过译文的课上摆一个永远没反应的按钮，
  // 只会让人以为功能坏了。
  const translated = useMemo(() => hasTranslations(lesson.sentences), [lesson.sentences]);
  const showTranslation = translated && settings.showTranslation;

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

  // 当前行停在框高的三分之一处，不是正中间：往下要留出还没读到的那几句（眼睛往前扫着走），
  // 往上只需要留得下刚读过的一两句。滚的是这个框自己（offsetTop 相对它，因为它是 relative），
  // 不用 scrollIntoView —— 那个会把整页也一起带着跳。
  const scrolled = useRef<number | null>(null);
  useEffect(() => {
    if (!follow || paused || activeLine === null || scrolled.current === activeLine) return;
    scrolled.current = activeLine;
    const box = boxRef.current;
    const row = rows.current.get(activeLine);
    if (!box || !row) return;
    box.scrollTo({ top: row.offsetTop - box.clientHeight / 3 + row.clientHeight / 2, behavior: 'smooth' });
  }, [follow, paused, activeLine]);

  // 展开、或者重新打开跟随时，忘掉「已经滚过哪一行」—— 否则当前行正好等于上次滚到的那行时
  // 会一动不动，用户点了「跟随播放」却看不见任何反应。
  const resume = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restart = useCallback(() => {
    scrolled.current = null;
    if (resume.current) clearTimeout(resume.current);
    resume.current = null;
    setPaused(false);
  }, []);

  // 自己滚了一下：暂停跟随，停手 RESUME_MS 之后再把当前句拉回来。
  const pause = useCallback(() => {
    setPaused(true);
    if (resume.current) clearTimeout(resume.current);
    resume.current = setTimeout(() => {
      resume.current = null;
      scrolled.current = null; // 这几秒里可能还是同一句，不清掉就不会滚回去
      setPaused(false);
    }, RESUME_MS);
  }, []);
  useEffect(() => () => void (resume.current && clearTimeout(resume.current)), []);

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
            {translated && (
              <Button
                variant={settings.showTranslation ? 'primary' : 'ghost'}
                onClick={() => void update({ showTranslation: !settings.showTranslation })}
              >
                {settings.showTranslation ? '显示中文' : '不显示中文'}
              </Button>
            )}
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
          onWheel={pause}
          onTouchMove={pause}
          className="relative max-h-[60vh] space-y-1 overflow-y-auto rounded-box border border-line bg-raised p-3"
        >
          {lines.map((line) => (
            <Line
              key={line.index}
              line={line}
              number={numbers.get(line.index)}
              translation={showTranslation ? lesson.sentences[line.index]?.translation : undefined}
              lowConfidence={lowConfidence.has(line.index)}
              state={line.index === activeLine ? (active!.inside ? 'current' : 'just-read') : 'idle'}
              activeToken={line.index === activeLine ? active!.token : null}
              onSeek={seek}
              register={register}
            />
          ))}
        </ol>
      )}

      {/* FR-20：笔记在通听页底部 —— 写和读是同一件事的两半，不该分到两个地方去。 */}
      <LessonNotes lesson={lesson} />

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
  current: 'bg-warn-soft text-ink',
  // 刚读完（落在两句之间的空档）：留一道左边线，别整块亮着 —— 否则看不出高亮已经走过去了
  'just-read': 'border-l-2 border-warn/40 text-ink',
  idle: 'text-muted',
};

const Line = memo(function Line({
  line,
  number,
  translation,
  lowConfidence,
  state,
  activeToken,
  onSeek,
  register,
}: {
  line: KaraokeLine;
  number: number | undefined;
  /** FR-19：中文。开关关着时传 undefined —— memo 因此在关着的时候完全不受译文影响。 */
  translation: string | undefined;
  lowConfidence: boolean;
  state: LineState;
  activeToken: number | null;
  onSeek: (to: number) => void;
  register: (index: number, el: HTMLLIElement | null) => void;
}) {
  return (
    <li
      ref={(el) => register(line.index, el)}
      className={`rounded-ctl px-2 py-1 text-de ${
        line.excluded ? 'text-faint' : LINE_STATE[state]
      }`}
    >
      <span
        className={`mr-2 text-note ${lowConfidence ? 'text-warn' : 'text-faint'}`}
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
            className={`cursor-pointer rounded-ctl hover:bg-sunken ${
              i === activeToken ? 'bg-warn-soft font-medium' : ''
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
      {/* 中文比德语小一级、颜色更淡：德语是主角，这一行只是垫在下面的拐杖（§12.4）。 */}
      {translation && (
        <span className="mt-0.5 block whitespace-pre-line pl-6 text-ui text-muted">
          {translation}
        </span>
      )}
    </li>
  );
});
