import { describe, it, expect, beforeEach } from 'vitest';
import { ShadowingMachine, type PlayRange, type RangePlayer } from './shadowing';

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
