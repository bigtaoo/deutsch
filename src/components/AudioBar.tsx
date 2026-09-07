// 底部播放条。所有 tab 共用，操作的都是那个单例 <audio>（§3.2）。
//
// §3.3 R3：无音频时按钮是禁用态 + 写清原因，绝不出现「点了没声音」的死角。
//
// 它是底部单浮层契约里的**基座**（SPEC §12.2）：`fixed` 而不再是 `sticky`，
// 并把实测高度报进 bottomLayer —— 对齐进度条据此上移，页面内容据此留白。
// sticky 那个版本的问题不只是被对齐条盖住：它的高度谁也不知道，所以页面底部的
// 留白只能靠容器上写死的 `pb-24` 去猜，而跟读那一排额外按钮一挂上就猜错了。

import { useState } from 'react';
import { audioPlayer } from '@/audio/player';
import { useAudioPlaying, useAudioTime, type LessonAudioState } from '@/audio/useLessonAudio';
import { useBottomLayer } from './bottomLayer';
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
  const [el, setEl] = useState<HTMLElement | null>(null);
  useBottomLayer('audio', el);

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
    <div
      ref={setEl}
      className="app-bottom-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-raised/95 backdrop-blur"
    >
      <div className="mx-auto max-w-4xl space-y-2 px-4 py-2">
        {/* 进度条自己占一整行。以前它和播放键、时间码、四个变速键挤在一行里，
            375px 宽的手机上最右边那个 1.2× 直接被切掉 —— 而这一整条的存在理由
            就是「手机上够得着」。占一行同时把拖拽目标变宽了。 */}
        <input
          type="range"
          aria-label="进度"
          className="block w-full accent-accent"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(time, duration)}
          disabled={disabled}
          onChange={(e) => audioPlayer.seek(Number(e.target.value))}
        />

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={disabled}
            title={reason}
            className="min-w-16"
            onClick={() => (playing ? audioPlayer.pause() : void audioPlayer.play())}
          >
            {playing ? '暂停' : '播放'}
          </Button>

          <span className="tnum shrink-0 text-note text-muted">
            {formatTime(time)} / {formatTime(duration, 0)}
          </span>

          <RateSwitch className="ml-auto" rate={rate} disabled={disabled} onChange={onRateChange} />
        </div>

        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
        {reason && <p className="text-note text-warn">{reason}</p>}
      </div>
    </div>
  );
}

/** 变速。跟读页也用同一套外观，所以单独导出 —— 以前那里是复制了一份。 */
export function RateSwitch({
  rate,
  disabled = false,
  className = '',
  onChange,
}: {
  rate: number;
  disabled?: boolean;
  className?: string;
  onChange: (rate: number) => void;
}) {
  return (
    <div className={`flex shrink-0 overflow-hidden rounded-ctl border border-line-strong ${className}`}>
      {PLAYBACK_RATES.map((r) => (
        <button
          key={r}
          disabled={disabled}
          // FR-6.3：切换即时生效，不重启当前句 —— 所以只改 playbackRate，不碰 currentTime。
          onClick={() => {
            audioPlayer.setRate(r);
            onChange(r);
          }}
          className={`tnum px-2 text-note disabled:opacity-40 ${
            r === rate ? 'bg-accent text-accent-ink' : 'bg-raised text-muted hover:bg-sunken'
          }`}
        >
          {r.toFixed(2).replace(/0$/, '')}×
        </button>
      ))}
    </div>
  );
}
