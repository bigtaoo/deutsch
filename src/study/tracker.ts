// FR-18.1：计时。**只在练习界面、且页面可见、且最近有动静时才走表。**
//
// 口径是这个功能里唯一真正要小心的东西 —— 这个数字会被截图发出去，所以宁可少算
// 也不能虚涨。三个条件同时成立才累加：
//
//   1. 人在练习界面上（通听/跟读/学词/听写/复习）。看设置页、翻生词本不算学习。
//   2. 页面可见（`visibilityState`）。切到别的 App、锁屏，表立刻停。
//   3. 最近 IDLE_MS 内有过动静：点过、按过键，**或者音频正在放**。
//
// 第 3 条里的「音频正在放」不是可有可无的补丁，它恰恰是主场景：通听一课十分钟，
// 期间一次都不会碰屏幕。反过来，「暂停着放在桌上去泡咖啡」两个条件都不满足，
// 一秒都不会记 —— 这正是「只要应用在前台就计时」那种口径做不到的事。
//
// ── 为什么按 tick 累加而不是记「进入/离开」的时刻差 ──
// 时刻差要在每一个中断点（切后台、锁屏、息屏、路由变化、系统杀进程）都正确地
// 收一次尾，漏掉任何一个都会把几小时算进去。按 5 秒一跳累加的话，最坏的错误
// 就是 5 秒，而且不需要任何一次收尾是可靠的。

import { audioPlayer } from '@/audio/player';
import { localDateKey, recordStudySeconds } from './log';

/** 跳一次表的间隔。也是单次计时误差的上界。 */
const TICK_MS = 5_000;
/** 多久没动静就算停了。一句德语句子播完到人按下一句，中间隔一分钟很正常。 */
const IDLE_MS = 60_000;
/** 攒够这么多秒就落一次库。手机在练习途中被系统杀掉，最多丢这些。 */
const FLUSH_SECONDS = 30;

export interface StudyClockHooks {
  /** 刚往库里写了一笔 —— 记录页据此刷新。 */
  onFlushed?: (secondsWritten: number) => void;
}

interface Deps {
  now: () => number;
  isVisible: () => boolean;
  isAudioPlaying: () => boolean;
  record: (seconds: number, now: number) => Promise<unknown>;
}

const defaultDeps: Deps = {
  now: () => Date.now(),
  isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  isAudioPlaying: () => !audioPlayer.paused,
  record: (seconds, now) => recordStudySeconds(seconds, now),
};

export class StudyClock {
  private deps: Deps;
  private hooks: StudyClockHooks = {};
  private active = false;
  private lastActivityAt = 0;
  private pendingSeconds = 0;
  /** 攒着的这些秒属于哪一天 —— 跨过午夜要先把昨天的那笔落库，不能记到今天头上。 */
  private pendingDate: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: Partial<Deps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  setHooks(hooks: StudyClockHooks): void {
    this.hooks = hooks;
  }

  /** 进入/离开练习界面。离开时把攒着的秒数立刻落库。 */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.noteActivity();
      this.start();
    } else {
      this.stop();
      void this.flush();
    }
  }

  /** 有动静了。点击、按键、以及别处显式报上来的「人在练」。 */
  noteActivity(): void {
    this.lastActivityAt = this.deps.now();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 供测试直接驱动，正常由 interval 调。 */
  tick(): void {
    if (!this.active) return;
    const now = this.deps.now();
    if (!this.deps.isVisible()) return;

    const playing = this.deps.isAudioPlaying();
    // 音频在放本身就是动静：通听一课十分钟不会碰屏幕，没有这一行那十分钟全丢。
    if (playing) this.lastActivityAt = now;
    else if (now - this.lastActivityAt > IDLE_MS) return;

    const date = localDateKey(now);
    if (this.pendingDate && this.pendingDate !== date) void this.flush();
    this.pendingDate = date;
    this.pendingSeconds += TICK_MS / 1000;

    if (this.pendingSeconds >= FLUSH_SECONDS) void this.flush();
  }

  /** 把攒着的秒数写进库。切后台、离开练习界面、关页面时都要调。 */
  async flush(): Promise<void> {
    const seconds = this.pendingSeconds;
    const date = this.pendingDate;
    if (seconds <= 0 || !date) return;
    this.pendingSeconds = 0;
    this.pendingDate = null;

    // 用那一天的**正午**而不是此刻：跨午夜 flush 时，`Date.now()` 已经是新的一天了，
    // 而这些秒数属于 date 那一天。正午离两头的边界都最远，夏令时也踩不到。
    const [y, m, d] = date.split('-').map(Number);
    await this.deps.record(seconds, new Date(y, m - 1, d, 12).getTime());
    this.hooks.onFlushed?.(seconds);
  }

  /** 测试用。 */
  get debugPendingSeconds(): number {
    return this.pendingSeconds;
  }
}

/** 全局一块表。计时是「这台设备此刻在不在学」，天然是单例。 */
export const studyClock = new StudyClock();

/**
 * 挂上浏览器那一侧的监听。App 启动时调一次，返回取消函数。
 *
 * `pointerdown`/`keydown` 挂在 window 上用捕获阶段：练习页里到处都是
 * `stopPropagation`，冒泡阶段会漏掉一部分点击，而漏掉的后果是明明在练却停表。
 */
export function attachStudyClockListeners(clock: StudyClock = studyClock): () => void {
  const onActivity = () => clock.noteActivity();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') clock.noteActivity();
    else void clock.flush();
  };

  window.addEventListener('pointerdown', onActivity, { capture: true, passive: true });
  window.addEventListener('keydown', onActivity, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  // pagehide 而不是 unload：iOS Safari 上 unload 基本不触发，而 pagehide 会。
  window.addEventListener('pagehide', () => void clock.flush());

  return () => {
    window.removeEventListener('pointerdown', onActivity, { capture: true });
    window.removeEventListener('keydown', onActivity, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
