// §3.2 / §7.3 / FR-3.3：全局单例 `<audio>` 元素。
//
// 为什么是单例：iOS 只允许「用户手势链」上的元素开始播放。每句 new Audio() 的话，
// 第二句起就会被静默拒绝。全程复用同一个元素，首次点击之后的 seek + play 都算同一条手势链。
//
// 为什么不用 timeupdate：它大约 4Hz，句子边界会冲过头小半秒。用 requestAnimationFrame
// 轮询 currentTime，越过 end 立刻 pause。

export interface PlayRangeOptions {
  /** 播到 end 时回调；被打断（换句、暂停）则不调用 */
  onEnded?: () => void;
}

type TimeListener = (currentTime: number) => void;

class SingletonAudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private loadedKey: string | null = null;
  private rafId: number | null = null;
  private stopAt: number | null = null;
  private onRangeEnded: (() => void) | null = null;
  private listeners = new Set<TimeListener>();

  /** 惰性创建：SSR / 单元测试里不碰 document，直到真的要播。 */
  element(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = document.createElement('audio');
      this.audio.preload = 'metadata';
      this.audio.addEventListener('pause', () => this.stopWatching());
      this.audio.addEventListener('ended', () => {
        this.stopWatching();
        this.emit();
      });
    }
    return this.audio;
  }

  /** 当前装载的是哪一课；用来避免重复 createObjectURL。 */
  get loadedLessonId(): string | null {
    return this.loadedKey;
  }

  get duration(): number {
    const d = this.audio?.duration ?? 0;
    return Number.isFinite(d) ? d : 0;
  }

  get currentTime(): number {
    return this.audio?.currentTime ?? 0;
  }

  get paused(): boolean {
    return this.audio?.paused ?? true;
  }

  /** 换课时旧的 objectURL 必须 revoke，否则整段音频留在内存里（FR-3.3）。 */
  async load(lessonId: string, blob: Blob): Promise<void> {
    if (this.loadedKey === lessonId) return;
    this.unload();
    const audio = this.element();
    this.objectUrl = URL.createObjectURL(blob);
    this.loadedKey = lessonId;
    audio.src = this.objectUrl;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        audio.removeEventListener('loadedmetadata', done);
        audio.removeEventListener('error', fail);
        resolve();
      };
      const fail = () => {
        audio.removeEventListener('loadedmetadata', done);
        audio.removeEventListener('error', fail);
        reject(new Error('音频解码失败'));
      };
      audio.addEventListener('loadedmetadata', done);
      audio.addEventListener('error', fail);
      audio.load();
    });
  }

  unload(): void {
    this.pause();
    if (this.audio) this.audio.removeAttribute('src');
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.loadedKey = null;
  }

  setRate(rate: number): void {
    // §3.2：移动 Safari 上过低的 playbackRate 会失真，范围锁死在 0.7–1.2。
    this.element().playbackRate = Math.min(1.2, Math.max(0.7, rate));
  }

  seek(time: number): void {
    this.element().currentTime = Math.max(0, time);
  }

  async play(from?: number): Promise<void> {
    const audio = this.element();
    if (from !== undefined) audio.currentTime = Math.max(0, from);
    this.stopAt = null;
    this.onRangeEnded = null;
    await audio.play();
    this.startWatching();
  }

  /** 播放 [start, end)；越过 end 就 pause 并回调。再次调用会取消上一次的区间。 */
  async playRange(start: number, end: number, opts: PlayRangeOptions = {}): Promise<void> {
    const audio = this.element();
    audio.currentTime = Math.max(0, start);
    this.stopAt = end;
    this.onRangeEnded = opts.onEnded ?? null;
    await audio.play();
    this.startWatching();
  }

  pause(): void {
    this.stopAt = null;
    this.onRangeEnded = null;
    this.audio?.pause();
    this.stopWatching();
  }

  /** 订阅播放位置。rAF 频率，够跟读高亮用。 */
  subscribe(listener: TimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.currentTime);
  }

  private startWatching(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.emit();
      if (this.stopAt !== null && this.currentTime >= this.stopAt) {
        const callback = this.onRangeEnded;
        this.stopAt = null;
        this.onRangeEnded = null;
        this.audio?.pause();
        this.stopWatching();
        callback?.();
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopWatching(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}

export const audioPlayer = new SingletonAudioPlayer();

/**
 * FR-1.3：读本地文件的时长。用一次性元素而不是单例 —— 只读 metadata、不播放，
 * 不涉及手势链；而借用单例会把用户正在听的那一课踢掉。
 */
export function readAudioDuration(file: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('audio');
    probe.preload = 'metadata';
    const cleanup = () => URL.revokeObjectURL(url);
    probe.addEventListener('loadedmetadata', () => {
      const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
      cleanup();
      resolve(duration);
    });
    probe.addEventListener('error', () => {
      cleanup();
      reject(new Error('无法读取音频时长，文件可能不是浏览器支持的格式'));
    });
    probe.src = url;
  });
}
