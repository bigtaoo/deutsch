// FR-6 跟读循环的状态机（§7.3 明确要求：状态机，不要嵌套 setTimeout）。
//
//   IDLE → PLAYING → GAP → (repeat--) → PLAYING | NEXT
//
// FR-6.8 录音回放开着时（`echo`），每一遍的 GAP 换成录音，人点「读完了」之后多一段 ECHO：
//
//   PLAYING → GAP(录音，等 finishTake()) → ECHO(放自己那一遍) → (repeat--) → PLAYING | REPRISE → NEXT
//
// REPRISE：最后一遍放完自己之后，把原句再放一遍再进下一句 —— 系统读、我读、听自己、再听系统，
// 刚听完自己马上对照原句，差别才听得出来。只在最后一遍加：还有下一遍时，下一遍的 PLAYING
// 本来就是「再听系统」，再插一次就连着放两遍原句了。没录到/没回放的那一遍也不加。
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

/**
 * FR-6.8：录下「我跟读的那一遍」再放出来。真实实现在 `audio/echo.ts`（麦克风 + MediaRecorder），
 * 注入进来是为了单测里不碰麦克风。
 *
 * `start` 失败（没授权、没麦克风）不是错误：那一遍退化成普通的静默间隔，`stop` 回 null 即可。
 */
export interface EchoRecorder {
  start(): Promise<void>;
  /** 结束录音、交出这一遍；什么都没录到就是 null。 */
  stop(): Promise<Blob | null>;
  play(clip: Blob, opts: { onEnded: () => void }): Promise<void>;
  /** 换句 / 停止时掐断正在录或正在放的那一段，录到一半的丢掉。 */
  halt(): void;
}

export type ShadowingPhase = 'idle' | 'playing' | 'gap' | 'echo' | 'reprise';

export interface ShadowingState {
  phase: ShadowingPhase;
  /** 在 queue 里的位置；queue 为空时是 -1 */
  position: number;
  /** 本句还要重复几次（含正在播的这次）。Infinity = 手动推进模式 */
  repeatsLeft: number;
  gapStartedAt: number;
  gapMs: number;
  /** 本句第几遍（从 1 起）。重播不加一 —— 和 `repeatsLeft` 同一个口径。 */
  pass: number;
  /** 这次静默间隔在录音（FR-6.8） */
  recording: boolean;
}

export interface ShadowingConfig {
  /** 静默间隔 = 句子时长 × ratio（FR-6.1，默认 1.2） */
  gapRatio: number;
  /** 每句重复次数（FR-6.2）。0 = 无限，手动推进 */
  repeat: number;
  /**
   * FR-6.8：每一遍都录音并回放。不设「第几遍才录」—— 起初是只录第 2 遍、第 1 遍留作普通间隔，
   * 用下来那一遍是多余的：听原句、跟读、听自己，一遍就是完整的一轮。
   */
  echo?: boolean;
}

export interface MachineDeps {
  player: RangePlayer;
  now?: () => number;
  /** 返回取消函数。注入是为了测试里不真的等 1.2 秒。 */
  setTimer?: (ms: number, cb: () => void) => () => void;
  echo?: EchoRecorder;
}

/** FR-6.8 录音保底上限：句长 × 5，但不少于 20 秒。 */
const RECORD_CAP_RATIO = 5;
const RECORD_CAP_MIN_MS = 20_000;

const IDLE: ShadowingState = { phase: 'idle', position: -1, repeatsLeft: 0, gapStartedAt: 0, gapMs: 0, pass: 0, recording: false };

export class ShadowingMachine {
  private queue: PlayRange[] = [];
  private config: ShadowingConfig = { gapRatio: 1.2, repeat: 2 };
  private state: ShadowingState = IDLE;
  private cancelTimer: (() => void) | null = null;
  private listeners = new Set<(state: ShadowingState) => void>();
  private readonly player: RangePlayer;
  private readonly echo: EchoRecorder | undefined;
  private readonly now: () => number;
  private readonly setTimer: (ms: number, cb: () => void) => () => void;
  /** 每次转移自增：异步回来的 onEnded 拿着旧号码就说明它已经过期，直接丢弃。 */
  private epoch = 0;
  /** 正在录音的那一遍的收尾函数；`finishTake()` 调它。换句/停止时随 epoch 一起作废。 */
  private finishCurrentTake: (() => void) | null = null;

  constructor(deps: MachineDeps) {
    this.player = deps.player;
    this.echo = deps.echo;
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
    this.finishCurrentTake = null;
    this.epoch++;
    this.player.pause();
    this.echo?.halt();
    this.set(IDLE);
  }

  /** FR-6.5：Space 重播当前句 —— 重播不消耗剩余次数，它是「再听一遍」不是「再来一轮」。 */
  replay(): void {
    if (this.state.position < 0) return;
    this.playAt(this.state.position, this.state.repeatsLeft, this.state.pass);
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

  private playAt(position: number, repeatsLeft?: number, pass = 1): void {
    this.clearTimer();
    this.finishCurrentTake = null;
    this.echo?.halt();
    const epoch = ++this.epoch;
    const range = this.queue[position];
    if (!range) return this.stop();

    const remaining = repeatsLeft ?? (this.config.repeat <= 0 ? Infinity : this.config.repeat);
    this.set({ phase: 'playing', position, repeatsLeft: remaining, gapStartedAt: 0, gapMs: 0, pass, recording: false });

    void this.player
      .playRange(range.start, range.end, {
        onEnded: () => {
          if (epoch !== this.epoch) return; // 已经被跳句/停止取代
          this.enterGap(position, remaining, pass, range);
        },
      })
      .catch(() => {
        // 播放被浏览器拒绝（iOS 手势链断了）：停下来而不是空转，UI 上按钮会回到「开始」。
        if (epoch === this.epoch) this.stop();
      });
  }

  private enterGap(position: number, repeatsLeft: number, pass: number, range: PlayRange): void {
    const sentenceMs = (range.end - range.start) * 1000;
    const gapMs = Math.max(300, sentenceMs * this.config.gapRatio);
    const epoch = this.epoch;
    const echo = this.echo;
    const recording = !!echo && !!this.config.echo;

    if (!echo || !recording) {
      this.set({ phase: 'gap', position, repeatsLeft, gapStartedAt: this.now(), gapMs, pass, recording: false });
      this.cancelTimer = this.setTimer(gapMs, () => {
        if (epoch === this.epoch) this.afterPass(position, repeatsLeft, pass);
      });
      return;
    }

    // 录音那一遍**没有倒计时**：读完了由人点「读完了」（或按 Enter，`finishTake()`）。
    // 固定间隔的毛病是句子一长就读不完、后半截录不上；自动判「停了没有」又会被
    // 外放的原句和环境噪音骗 —— 只有人自己知道什么时候念完。
    // `capMs` 只是一道保底：忘了点、人走开了，循环不能永远停在录音上。
    const capMs = Math.max(RECORD_CAP_MIN_MS, sentenceMs * RECORD_CAP_RATIO);
    this.set({ phase: 'gap', position, repeatsLeft, gapStartedAt: this.now(), gapMs: capMs, pass, recording: true });

    let settled = false;
    const finish = () => {
      if (settled || epoch !== this.epoch) return;
      settled = true;
      this.finishCurrentTake = null;
      this.clearTimer();
      void echo
        .stop()
        .catch(() => null)
        .then((clip) => {
          if (epoch !== this.epoch) return;
          if (!clip) return this.afterPass(position, repeatsLeft, pass);
          this.set({ ...this.state, phase: 'echo', recording: false });
          return echo.play(clip, {
            onEnded: () => {
              if (epoch === this.epoch) this.afterEcho(position, repeatsLeft, pass, range);
            },
          });
        })
        .catch(() => {
          // 回放被拒（解码失败之类）：跳过这一段，循环照常往下走，不能停在 ECHO 里。
          if (epoch === this.epoch) this.afterPass(position, repeatsLeft, pass);
        });
    };
    this.finishCurrentTake = finish;
    this.cancelTimer = this.setTimer(capMs, finish);

    void echo.start().catch(() => {
      // 麦克风起不来：这一遍退回成原来的固定间隔 —— 界面上不能还挂着一个没在录的「读完了」。
      if (settled || epoch !== this.epoch) return;
      settled = true;
      this.finishCurrentTake = null;
      this.clearTimer();
      this.set({ ...this.state, gapStartedAt: this.now(), gapMs, recording: false });
      this.cancelTimer = this.setTimer(gapMs, () => {
        if (epoch === this.epoch) this.afterPass(position, repeatsLeft, pass);
      });
    });
  }

  /** FR-6.8：「读完了」—— 结束这一遍的录音、开始回放。不在录音时什么都不做。 */
  finishTake(): void {
    this.finishCurrentTake?.();
  }

  /** 放完自己那一遍：还有下一遍就照常进入（它本身就从原句开始），最后一遍则先 REPRISE。 */
  private afterEcho(position: number, repeatsLeft: number, pass: number, range: PlayRange): void {
    if (repeatsLeft - 1 > 0) return this.afterPass(position, repeatsLeft, pass);
    const epoch = this.epoch;
    this.set({ ...this.state, phase: 'reprise', gapStartedAt: 0, gapMs: 0, recording: false });
    void this.player
      .playRange(range.start, range.end, {
        onEnded: () => {
          if (epoch === this.epoch) this.advance(position);
        },
      })
      .catch(() => {
        if (epoch === this.epoch) this.stop();
      });
  }

  private afterPass(position: number, repeatsLeft: number, pass: number): void {
    // Infinity - 1 仍是 Infinity，所以手动推进模式天然落在第一个分支里，永远不自动前进。
    const left = repeatsLeft - 1;
    if (left > 0) this.playAt(position, left, pass + 1);
    else this.advance(position);
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
