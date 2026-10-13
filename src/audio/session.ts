// iOS 静音开关与 Web Audio。
//
// 原生壳在 AppDelegate 里把 AVAudioSession 设成了 `.playback`（§7.10），课文、练习走的
// `<audio>` 因此不受静音开关影响。但 WebKit 会自己接管音频会话的类别：页面里**只有 Web Audio
// 在响**、没有媒体元素在放的时候，它把会话归成「环境音」—— 这一档跟着静音开关走，
// 把壳里那一行盖掉。症状就是「静音时课文有声、点按钮的音效没声」。
//
// 解法是 WebKit 的 Audio Session API（iOS 16.4+）：`navigator.audioSession.type`
// 由页面声明自己是哪一类。没有这个 API 的环境（Chrome、老系统、jsdom）一律跳过，
// 那里本来也没有静音开关这件事。
//
// 跟读录音要的是另一档：`playback` 不能开麦克风，所以录音期间切到 `play-and-record`，
// 收麦之后切回来。

type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';

function session(): { type: AudioSessionType } | null {
  if (typeof navigator === 'undefined') return null;
  const s = (navigator as unknown as { audioSession?: { type: AudioSessionType } }).audioSession;
  return s ?? null;
}

function setType(type: AudioSessionType): void {
  const s = session();
  if (!s) return;
  try {
    s.type = type;
  } catch {
    // 设不上就是保持原样 —— 最坏也只是静音时音效没声，和改之前一样。
  }
}

/** 建 AudioContext 之前调：静音开关不再掐掉 Web Audio。录音中不动它。 */
export function preferPlaybackSession(): void {
  const current = session()?.type;
  // 录音中不动它；已经是 playback 也不再写 —— 同一个类别再写一遍，WebKit 那边
  // 可能当成一次会话变更，把正在跑的 AudioContext 打成 interrupted（变更 80）。
  if (current === 'play-and-record' || current === 'playback') return;
  setType('playback');
}

/** 给诊断用：此刻声明的会话类别；没有这个 API 时是 null。 */
export function currentSessionType(): string | null {
  return session()?.type ?? null;
}

/** 开麦克风之前调。 */
export function enterRecordingSession(): void {
  setType('play-and-record');
}

/** 收麦之后调。 */
export function leaveRecordingSession(): void {
  setType('playback');
}
