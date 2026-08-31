// 底部播放条。所有 tab 共用，操作的都是那个单例 <audio>（§3.2）。
//
// §3.3 R3：无音频时按钮是禁用态 + 写清原因，绝不出现「点了没声音」的死角。

import { audioPlayer } from '@/audio/player';
import { useAudioPlaying, useAudioTime, type LessonAudioState } from '@/audio/useLessonAudio';
import { Button, formatTime } from './ui';

export const PLAYBACK_RATES = [0.7, 0.85, 1.0, 1.2] as const;

interface Props {
  audio: LessonAudioState;
  rate: number;
  onRateChange: (rate: number) => void;
  /** 额外的控制按钮（如跟读的「重播本句」） */
  children?: React.ReactNode;
}

export function AudioBar({ audio, rate, onRateChange, children }: Props) {
  const time = useAudioTime();
  const playing = useAudioPlaying();
  const disabled = audio.status !== 'ready';
  const duration = audio.duration || audioPlayer.duration;

  const reason =
    audio.status === 'missing'
      ? '本机没有这一课的音频（素材未下载）'
      : audio.status === 'error'
        ? audio.error ?? '音频加载失败'
        : audio.status === 'loading'
          ? '音频加载中…'
          : undefined;

  return (
    <div className="sticky bottom-0 z-10 space-y-2 border-t border-neutral-200 bg-white/95 p-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          disabled={disabled}
          title={reason}
          onClick={() => (playing ? audioPlayer.pause() : void audioPlayer.play())}
        >
          {playing ? '暂停' : '播放'}
        </Button>

        <span className="w-24 shrink-0 font-mono text-xs text-neutral-500">
          {formatTime(time)} / {formatTime(duration, 0)}
        </span>

        <input
          type="range"
          className="min-w-0 flex-1"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(time, duration)}
          disabled={disabled}
          onChange={(e) => audioPlayer.seek(Number(e.target.value))}
        />

        <div className="flex shrink-0 gap-1">
          {PLAYBACK_RATES.map((r) => (
            <button
              key={r}
              disabled={disabled}
              // FR-6.3：切换即时生效，不重启当前句 —— 所以只改 playbackRate，不碰 currentTime。
              onClick={() => { audioPlayer.setRate(r); onRateChange(r); }}
              className={`rounded px-2 py-1 text-xs ${
                r === rate ? 'bg-neutral-800 text-white' : 'border border-neutral-300 hover:bg-neutral-50'
              } disabled:opacity-40`}
            >
              {r.toFixed(2).replace(/0$/, '')}×
            </button>
          ))}
        </div>
      </div>

      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      {reason && <p className="text-xs text-amber-700">{reason}</p>}
    </div>
  );
}
