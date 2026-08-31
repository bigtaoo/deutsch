// FR-5 通听：全篇连续播放，文本默认折叠。
//
// FR-5.2 的关键是**不做假装的伪同步**：只有已标注的句子会随进度高亮，
// 未标注的句子保持中性。按字数估算位置的「伪同步」会让人误以为标注已经做过了。

import { useMemo, useState } from 'react';
import { useLessonAudio, useAudioTime } from '@/audio/useLessonAudio';
import { audioPlayer } from '@/audio/player';
import { sentenceIndexAt } from '@/lesson/timing';
import { displayNumbers } from '@/lesson/sentences';
import { AudioBar } from '@/components/AudioBar';
import { Button, Hint } from '@/components/ui';
import { useSettingsStore } from '@/state/useSettingsStore';
import type { Lesson, LessonCache } from '@/types/models';

export function ListenTab({ lesson }: { lesson: Lesson; cache: LessonCache | undefined }) {
  const audio = useLessonAudio(lesson.id);
  const time = useAudioTime();
  const [expanded, setExpanded] = useState(false);
  const { settings, update } = useSettingsStore();

  const numbers = useMemo(() => displayNumbers(lesson.sentences), [lesson.sentences]);
  const currentIndex = expanded ? sentenceIndexAt(lesson.sentences, time, lesson.audioDuration) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button onClick={() => setExpanded((v) => !v)}>{expanded ? '折叠文本' : '展开文本'}</Button>
        <Hint>先不看文本听一遍。文本默认折叠不是为了省地方，是为了逼自己先用耳朵。</Hint>
      </div>

      {expanded && (
        <ol className="space-y-1 rounded-lg border border-neutral-200 p-3">
          {lesson.sentences.map((s) => (
            <li
              key={s.index}
              onClick={() => s.startTime !== undefined && audioPlayer.seek(s.startTime)}
              className={`rounded px-2 py-1 text-sm leading-relaxed ${
                s.excluded ? 'text-neutral-300' : ''
              } ${s.index === currentIndex ? 'bg-amber-100' : ''} ${
                s.startTime !== undefined ? 'cursor-pointer hover:bg-neutral-50' : ''
              }`}
            >
              <span className="mr-2 text-xs text-neutral-400">{numbers.get(s.index) ?? '—'}</span>
              {s.text}
            </li>
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
