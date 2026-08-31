// FR-6 跟读循环的状态机（§7.3 明确要求：状态机，不要嵌套 setTimeout）。
//
//   IDLE → PLAYING → GAP → (repeat--) → PLAYING | NEXT
//
// 为什么不用嵌套 setTimeout：变速、跳句、暂停都会在半途发生，嵌套定时器的每一层
// 都得记得自己取消自己，漏一个就是「上一句的定时器把下一句打断」这种查不出来的 bug。
// 这里所有转移都经过 transition()，任何一次都会先把前一个定时器杀掉。
//
// 倒计时进度（FR-6.6）不在机器里算：状态里给出 gapStartedAt / gapMs，
// UI 自己用 rAF 画环 —— 让机器每帧发一次状态更新是纯粹的浪费。

export interface PlayRange {
  /** Sentence.index，用于回写 markedDifficult 等 */
  sentenceIndex: number;
  start: number;
  end: number;
}

export interface RangePlayer {
  playRange(start: number, end: number, opts: { onEnded: () => void }): Promise<void>;
  pause(): void;
}

export type ShadowingPhase = 'idle' | 'playing' | 'gap';

export interface ShadowingState {
  phase: ShadowingPhase;
  /** 在 queue 里的位置；queue 为空时是 -1 */
  position: number;
  /** 本句还要重复几次（含正在播的这次）。Infinity = 手动推进模式 */
  repeatsLeft: number;
  gapStartedAt: number;
  gapMs: number;
}

export interface ShadowingConfig {
  /** 静默间隔 = 句子时长 × ratio（FR-6.1，默认 1.2） */
  gapRatio: number;
  /** 每句重复次数（FR-6.2）。0 = 无限，手动推进 */
  repeat: number;
}

export interface MachineDeps {
  player: RangePlayer;
  now?: () => number;
  /** 返回取消函数。注入是为了测试里不真的等 1.2 秒。 */
  setTimer?: (ms: number, cb: () => void) => () => void;
}

const IDLE: ShadowingState = { phase: 'idle', position: -1, repeatsLeft: 0, gapStartedAt: 0, gapMs: 0 };

export class ShadowingMachine {
  private queue: PlayRange[] = [];
  private config: ShadowingConfig = { gapRatio: 1.2, repeat: 2 };
  private state: ShadowingState = IDLE;
  private cancelTimer: (() => void) | null = null;
  private listeners = new Set<(state: ShadowingState) => void>();
  private readonly player: RangePlayer;
  private readonly now: () => number;
  private readonly setTimer: (ms: number, cb: () => void) => () => void;
  /** 每次转移自增：异步回来的 onEnded 拿着旧号码就说明它已经过期，直接丢弃。 */
  private epoch = 0;

  constructor(deps: MachineDeps) {
    this.player = deps.player;
    this.now = deps.now ?? (() => Date.now());
    this.setTimer =
      deps.setTimer ??
      ((ms, cb) => {
        const id = setTimeout(cb, ms);
        return () => clearTimeout(id);
      });
  }

  getState(): ShadowingState {
    return this.state;
  }

  subscribe(listener: (state: ShadowingState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 队列或配置变了（例如切到「只练困难句」）就整体换掉。当前位置尽量保住。 */
  setQueue(queue: PlayRange[], config: ShadowingConfig): void {
    const currentSentence = this.current()?.sentenceIndex;
    this.queue = queue;
    this.config = config;
    if (this.state.phase !== 'idle') {
      const position = queue.findIndex((r) => r.sentenceIndex === currentSentence);
      if (position === -1) this.stop();
      else this.state = { ...this.state, position };
    }
  }

  current(): PlayRange | undefined {
    return this.queue[this.state.position];
  }

  start(position = 0): void {
    if (this.queue.length === 0) return;
    this.playAt(Math.min(Math.max(0, position), this.queue.length - 1));
  }

  stop(): void {
    this.clearTimer();
    this.epoch++;
    this.player.pause();
    this.set(IDLE);
  }

  /** FR-6.5：Space 重播当前句 —— 重播不消耗剩余次数，它是「再听一遍」不是「再来一轮」。 */
  replay(): void {
    if (this.state.position < 0) return;
    this.playAt(this.state.position, this.state.repeatsLeft);
  }

  next(): void {
    if (this.state.position < 0) return;
    if (this.state.position + 1 >= this.queue.length) return this.stop();
    this.playAt(this.state.position + 1);
  }

  previous(): void {
    if (this.state.position <= 0) return;
    this.playAt(this.state.position - 1);
  }

  private playAt(position: number, repeatsLeft?: number): void {
    this.clearTimer();
    const epoch = ++this.epoch;
    const range = this.queue[position];
    if (!range) return this.stop();

    const remaining = repeatsLeft ?? (this.config.repeat <= 0 ? Infinity : this.config.repeat);
    this.set({ phase: 'playing', position, repeatsLeft: remaining, gapStartedAt: 0, gapMs: 0 });

    void this.player
      .playRange(range.start, range.end, {
        onEnded: () => {
          if (epoch !== this.epoch) return; // 已经被跳句/停止取代
          this.enterGap(position, remaining, range);
        },
      })
      .catch(() => {
        // 播放被浏览器拒绝（iOS 手势链断了）：停下来而不是空转，UI 上按钮会回到「开始」。
        if (epoch === this.epoch) this.stop();
      });
  }

  private enterGap(position: number, repeatsLeft: number, range: PlayRange): void {
    const gapMs = Math.max(300, (range.end - range.start) * this.config.gapRatio * 1000);
    const epoch = this.epoch;
    this.set({ phase: 'gap', position, repeatsLeft, gapStartedAt: this.now(), gapMs });

    this.cancelTimer = this.setTimer(gapMs, () => {
      if (epoch !== this.epoch) return;
      // Infinity - 1 仍是 Infinity，所以手动推进模式天然落在第一个分支里，永远不自动前进。
      const left = repeatsLeft - 1;
      if (left > 0) this.playAt(position, left);
      else this.advance(position);
    });
  }

  private advance(position: number): void {
    if (position + 1 >= this.queue.length) return this.stop();
    this.playAt(position + 1);
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private set(state: ShadowingState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
