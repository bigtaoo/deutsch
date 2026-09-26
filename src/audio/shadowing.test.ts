import { describe, it, expect, beforeEach } from 'vitest';
import { ShadowingMachine, type EchoRecorder, type PlayRange, type RangePlayer } from './shadowing';

/** 假播放器：记录调用，并把「播完了」的时机交给测试掌控。 */
class FakePlayer implements RangePlayer {
  calls: Array<[number, number]> = [];
  pauses = 0;
  private ended: (() => void) | null = null;

  async playRange(start: number, end: number, opts: { onEnded: () => void }): Promise<void> {
    this.calls.push([start, end]);
    this.ended = opts.onEnded;
  }
  pause(): void {
    this.pauses++;
  }
  finish(): void {
    const cb = this.ended;
    this.ended = null;
    cb?.();
  }
}

/** 假定时器：只记下待触发的回调，测试里手动 fire。 */
class FakeTimers {
  private pending: Array<{ ms: number; cb: () => void; cancelled: boolean }> = [];
  readonly setTimer = (ms: number, cb: () => void) => {
    const entry = { ms, cb, cancelled: false };
    this.pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  get lastDelay(): number | undefined {
    return this.pending[this.pending.length - 1]?.ms;
  }
  fireLast(): void {
    const entry = this.pending[this.pending.length - 1];
    if (entry && !entry.cancelled) entry.cb();
  }
  get cancelledCount(): number {
    return this.pending.filter((p) => p.cancelled).length;
  }
}

const QUEUE: PlayRange[] = [
  { sentenceIndex: 0, start: 0, end: 2 },
  { sentenceIndex: 3, start: 10, end: 11 },
  { sentenceIndex: 7, start: 20, end: 24 },
];

let player: FakePlayer;
let timers: FakeTimers;
let machine: ShadowingMachine;

beforeEach(() => {
  player = new FakePlayer();
  timers = new FakeTimers();
  machine = new ShadowingMachine({ player, now: () => 1000, setTimer: timers.setTimer });
  machine.setQueue(QUEUE, { gapRatio: 1.2, repeat: 2 });
});

describe('ShadowingMachine', () => {
  it('PLAYING → GAP → 重复第二遍 → 下一句', () => {
    machine.start();
    expect(player.calls).toEqual([[0, 2]]);
    expect(machine.getState().phase).toBe('playing');
    expect(machine.getState().repeatsLeft).toBe(2);

    player.finish();
    expect(machine.getState().phase).toBe('gap');
    // FR-6.1：gap = 句子时长 × ratio = 2s × 1.2
    expect(timers.lastDelay).toBe(2400);

    timers.fireLast();
    expect(player.calls).toEqual([[0, 2], [0, 2]]); // 第二遍
    expect(machine.getState().repeatsLeft).toBe(1);

    player.finish();
    timers.fireLast();
    expect(player.calls[2]).toEqual([10, 11]); // 进入下一句
    expect(machine.getState().position).toBe(1);
  });

  it('repeat = 0 时无限重复，绝不自动前进（FR-6.2）', () => {
    machine.setQueue(QUEUE, { gapRatio: 1, repeat: 0 });
    machine.start();
    for (let i = 0; i < 5; i++) {
      player.finish();
      timers.fireLast();
    }
    expect(player.calls.every(([start]) => start === 0)).toBe(true);
    expect(machine.getState().position).toBe(0);
  });

  it('跳句会取消在飞的 gap 定时器，旧回调不再生效', () => {
    machine.start();
    player.finish(); // 进入 gap
    machine.next();
    expect(timers.cancelledCount).toBe(1);
    timers.fireLast(); // 已取消，什么都不该发生
    expect(machine.getState().position).toBe(1);
    expect(player.calls).toEqual([[0, 2], [10, 11]]);
  });

  it('上一句播完的 onEnded 迟到时被丢弃，不会把新句踢进 gap', () => {
    machine.start();
    machine.next(); // 第一句还没 finish 就跳走了
    player.finish(); // 这是第二句的 onEnded（假播放器只记最后一个），正常进 gap
    expect(machine.getState().phase).toBe('gap');
    expect(machine.getState().position).toBe(1);
  });

  it('replay 不消耗剩余次数', () => {
    machine.start();
    player.finish();
    timers.fireLast(); // 剩 1 次
    expect(machine.getState().repeatsLeft).toBe(1);
    machine.replay();
    expect(machine.getState().repeatsLeft).toBe(1);
    expect(player.calls).toHaveLength(3);
  });

  it('走到队尾自动停止', () => {
    machine.start(2);
    player.finish();
    timers.fireLast();
    player.finish();
    timers.fireLast();
    expect(machine.getState().phase).toBe('idle');
    expect(player.pauses).toBeGreaterThan(0);
  });

  it('切换队列（只练困难句）时保住当前句的位置', () => {
    machine.start(1);
    machine.setQueue([QUEUE[1], QUEUE[2]], { gapRatio: 1.2, repeat: 2 });
    expect(machine.getState().position).toBe(0);
    expect(machine.current()?.sentenceIndex).toBe(3);
  });

  it('当前句不在新队列里就停下来，而不是跳到一个没人要求的句子', () => {
    machine.start(0);
    machine.setQueue([QUEUE[2]], { gapRatio: 1.2, repeat: 2 });
    expect(machine.getState().phase).toBe('idle');
  });

  it('空队列时 start 什么都不做', () => {
    machine.setQueue([], { gapRatio: 1.2, repeat: 2 });
    machine.start();
    expect(player.calls).toHaveLength(0);
    expect(machine.getState().phase).toBe('idle');
  });

  it('gap 有下限，极短的句子也留得出开口的时间', () => {
    machine.setQueue([{ sentenceIndex: 0, start: 0, end: 0.05 }], { gapRatio: 1.2, repeat: 2 });
    machine.start();
    player.finish();
    expect(timers.lastDelay).toBe(300);
  });
});

/** 假录音机：stop() 与 play() 都是真的异步 —— 零延迟的同步假货会把「迟到的回调」这类竞态藏起来。 */
class FakeEcho implements EchoRecorder {
  starts = 0;
  halts = 0;
  played: Blob[] = [];
  failStart = false;
  clip: Blob | null = new Blob(['me'], { type: 'audio/webm' });
  private ended: (() => void) | null = null;

  async start(): Promise<void> {
    this.starts++;
    if (this.failStart) throw new Error('NotAllowedError');
  }
  stop(): Promise<Blob | null> {
    return new Promise((resolve) => setTimeout(() => resolve(this.clip), 5));
  }
  async play(clip: Blob, opts: { onEnded: () => void }): Promise<void> {
    await new Promise((r) => setTimeout(r, 5));
    this.played.push(clip);
    this.ended = opts.onEnded;
  }
  halt(): void {
    this.halts++;
    this.ended = null;
  }
  finish(): void {
    const cb = this.ended;
    this.ended = null;
    cb?.();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 80));

describe('ShadowingMachine · FR-6.8 录音回放', () => {
  let echo: FakeEcho;

  beforeEach(() => {
    echo = new FakeEcho();
    machine = new ShadowingMachine({ player, now: () => 1000, setTimer: timers.setTimer, echo });
    machine.setQueue(QUEUE, { gapRatio: 1.2, repeat: 1, echo: true });
  });

  it('原句 → 录音一直录到点「读完了」→ 回放 → 原句再放一遍 → 才进下一句', async () => {
    machine.start();
    player.finish();
    expect(machine.getState()).toMatchObject({ phase: 'gap', pass: 1, recording: true });
    expect(echo.starts).toBe(1);
    // 没有固定间隔：只挂了一道保底上限（2 秒的句子 → 不少于 20 秒）
    expect(timers.lastDelay).toBe(20_000);

    machine.finishTake();
    await settle();
    expect(machine.getState().phase).toBe('echo');
    expect(echo.played).toHaveLength(1);
    expect(player.calls).toHaveLength(1); // 录音还在放，下一句没开始

    echo.finish();
    expect(machine.getState()).toMatchObject({ phase: 'reprise', position: 0, recording: false });
    expect(player.calls[1]).toEqual([0, 2]); // 同一句原句
    expect(echo.starts).toBe(1); // 再听那一遍不录

    player.finish();
    expect(player.calls[2]).toEqual([10, 11]);
    expect(machine.getState()).toMatchObject({ phase: 'playing', position: 1, pass: 1 });
  });

  it('再听原句中跳句 / 停止：迟到的 onEnded 不推进', async () => {
    machine.start();
    player.finish();
    machine.finishTake();
    await settle();
    echo.finish();
    expect(machine.getState().phase).toBe('reprise');
    machine.stop();
    player.finish();
    expect(machine.getState().phase).toBe('idle');
    expect(player.calls).toHaveLength(2);
  });

  it('最后一句的再听放完：整段结束', async () => {
    machine.start(2);
    player.finish();
    machine.finishTake();
    await settle();
    echo.finish();
    player.finish();
    expect(machine.getState().phase).toBe('idle');
  });

  it('长句的保底上限是句长 × 5；到了上限自动当作读完', async () => {
    machine.start(2); // 4 秒的句子
    player.finish();
    expect(timers.lastDelay).toBe(20_000);
    machine.setQueue([{ sentenceIndex: 9, start: 0, end: 10 }], { gapRatio: 1.2, repeat: 1, echo: true });
    machine.start();
    player.finish();
    expect(timers.lastDelay).toBe(50_000);
    timers.fireLast();
    await settle();
    expect(machine.getState().phase).toBe('echo');
  });

  it('点两次「读完了」、或上限和按钮撞在一起：只回放一次', async () => {
    machine.start();
    player.finish();
    machine.finishTake();
    machine.finishTake();
    timers.fireLast(); // 已被取消
    await settle();
    expect(echo.played).toHaveLength(1);
  });

  it('不在录音时 finishTake 什么都不做', () => {
    machine.finishTake();
    machine.start();
    machine.finishTake(); // 原句还在放
    expect(machine.getState().phase).toBe('playing');
  });

  it('重复 2 遍：两遍都录、都回放', async () => {
    machine.setQueue(QUEUE, { gapRatio: 1.2, repeat: 2, echo: true });
    machine.start();
    for (let i = 0; i < 2; i++) {
      player.finish();
      expect(machine.getState().recording).toBe(true);
      machine.finishTake();
      await settle();
      echo.finish();
    }
    expect(echo.played).toHaveLength(2);
    // 第 1 遍放完自己直接进第 2 遍（它本身就从原句开始），只有最后一遍后面多一次再听
    expect(player.calls).toEqual([[0, 2], [0, 2], [0, 2]]);
    expect(machine.getState().phase).toBe('reprise');
    player.finish();
    expect(player.calls[3]).toEqual([10, 11]);
  });

  it('echo 关着时和原来完全一样：固定间隔，finishTake 无效', () => {
    machine.setQueue(QUEUE, { gapRatio: 1.2, repeat: 1, echo: false });
    machine.start();
    player.finish();
    expect(machine.getState().recording).toBe(false);
    expect(timers.lastDelay).toBe(2400);
    machine.finishTake();
    expect(machine.getState().phase).toBe('gap');
    timers.fireLast();
    expect(player.calls[1]).toEqual([10, 11]);
    expect(echo.starts).toBe(0);
  });

  it('麦克风起不来：这一遍退回固定间隔，不再挂着「读完了」', async () => {
    echo.failStart = true;
    machine.start();
    player.finish();
    await settle();
    expect(machine.getState()).toMatchObject({ phase: 'gap', recording: false, gapMs: 2400 });
    expect(timers.lastDelay).toBe(2400);
    timers.fireLast();
    expect(echo.played).toHaveLength(0);
    expect(player.calls[1]).toEqual([10, 11]);
  });

  it('什么都没录到：不回放，直接往下走', async () => {
    echo.clip = null;
    machine.start();
    player.finish();
    machine.finishTake();
    await settle();
    expect(echo.played).toHaveLength(0);
    expect(player.calls[1]).toEqual([10, 11]); // 没录到就没有再听，直接下一句
  });

  it('点了「读完了」、录音还没交出来就跳句：迟到的录音不会被放出来', async () => {
    machine.start();
    player.finish();
    machine.finishTake(); // stop() 还在飞
    machine.next();
    await settle();
    expect(echo.played).toHaveLength(0);
    expect(machine.getState()).toMatchObject({ phase: 'playing', position: 1 });
    expect(echo.halts).toBeGreaterThan(0);
  });

  it('录音中跳句：上一句的「读完了」作废，不会结束新句', () => {
    machine.start();
    player.finish();
    machine.next();
    machine.finishTake();
    expect(machine.getState()).toMatchObject({ phase: 'playing', position: 1 });
  });

  it('回放中按停止：掐断回放，之后的 onEnded 不再推进', async () => {
    machine.start();
    player.finish();
    machine.finishTake();
    await settle();
    expect(machine.getState().phase).toBe('echo');
    machine.stop();
    echo.finish();
    expect(machine.getState().phase).toBe('idle');
    expect(player.calls).toHaveLength(1);
  });

  it('回放中按重播：重来这一遍，照样录', async () => {
    machine.start();
    player.finish();
    machine.finishTake();
    await settle();
    machine.replay();
    expect(machine.getState()).toMatchObject({ phase: 'playing', pass: 1, position: 0 });
    player.finish();
    expect(machine.getState().recording).toBe(true);
  });
});
