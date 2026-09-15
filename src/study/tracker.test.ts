import { describe, expect, it } from 'vitest';
import { StudyClock } from './tracker';

/** 造一块受控的表：时间、可见性、音频状态全由测试说了算。 */
function makeClock(options: { visible?: boolean; playing?: boolean } = {}) {
  let now = new Date(2026, 8, 15, 20, 0).getTime();
  let visible = options.visible ?? true;
  let playing = options.playing ?? false;
  const written: Array<{ seconds: number; at: number }> = [];

  const clock = new StudyClock({
    now: () => now,
    isVisible: () => visible,
    isAudioPlaying: () => playing,
    record: async (seconds, at) => {
      written.push({ seconds, at });
    },
  });

  return {
    clock,
    written,
    advance: (ms: number) => {
      now += ms;
    },
    setVisible: (v: boolean) => {
      visible = v;
    },
    setPlaying: (p: boolean) => {
      playing = p;
    },
    /** 走 n 个 5 秒的 tick，每个 tick 之间把时钟往前推 5 秒。 */
    ticks: (n: number) => {
      for (let i = 0; i < n; i++) {
        now += 5_000;
        clock.tick();
      }
    },
  };
}

describe('StudyClock', () => {
  it('不在练习界面上时一秒都不记', () => {
    const t = makeClock();
    t.ticks(10);
    expect(t.clock.debugPendingSeconds).toBe(0);
  });

  it('在练习界面上、刚有过动静：每 tick 记 5 秒', () => {
    const t = makeClock();
    t.clock.setActive(true);
    t.ticks(3);
    expect(t.clock.debugPendingSeconds).toBe(15);
  });

  it('页面不可见时停表', () => {
    const t = makeClock();
    t.clock.setActive(true);
    t.setVisible(false);
    t.ticks(5);
    expect(t.clock.debugPendingSeconds).toBe(0);
  });

  it('超过一分钟没动静就停表', () => {
    const t = makeClock();
    t.clock.setActive(true);
    t.advance(70_000);
    t.ticks(5);
    expect(t.clock.debugPendingSeconds).toBe(0);
  });

  it('音频在放就算动静 —— 通听十分钟不碰屏幕也要计时', () => {
    const t = makeClock();
    t.clock.setActive(true);
    t.advance(120_000); // 两分钟没碰过
    t.setPlaying(true);
    t.ticks(4);
    expect(t.clock.debugPendingSeconds).toBe(20);
  });

  it('暂停着放在一边：既没动静也没在放，不计时', () => {
    const t = makeClock();
    t.clock.setActive(true);
    t.setPlaying(true);
    t.ticks(2);
    t.setPlaying(false);
    t.advance(120_000);
    t.ticks(10);
    expect(t.clock.debugPendingSeconds).toBe(10);
  });

  it('重新有动静之后接着走表', () => {
    const t = makeClock();
    t.clock.setActive(true);
    t.advance(120_000);
    t.ticks(2); // 停表期
    t.clock.noteActivity();
    t.ticks(2);
    expect(t.clock.debugPendingSeconds).toBe(10);
  });

  it('攒够 30 秒自动落库', async () => {
    const t = makeClock();
    t.clock.setActive(true);
    t.ticks(6);
    await Promise.resolve();
    expect(t.written).toEqual([expect.objectContaining({ seconds: 30 })]);
    expect(t.clock.debugPendingSeconds).toBe(0);
  });

  it('离开练习界面时把零头落库', async () => {
    const t = makeClock();
    t.clock.setActive(true);
    t.ticks(2);
    t.clock.setActive(false);
    await Promise.resolve();
    expect(t.written).toEqual([expect.objectContaining({ seconds: 10 })]);
  });

  it('零头为 0 时不写库', async () => {
    const t = makeClock();
    t.clock.setActive(true);
    t.clock.setActive(false);
    await t.clock.flush();
    expect(t.written).toEqual([]);
  });

  it('跨过午夜：先把昨天的落库，新的秒数记到今天', async () => {
    const t = makeClock();
    t.clock.setActive(true);
    t.ticks(2); // 20:00 出头，算 9-15
    t.advance(4 * 3600_000); // 跨到 9-16 的 00:00 之后
    t.clock.noteActivity();
    t.ticks(2);
    await Promise.resolve();

    expect(t.written).toHaveLength(1);
    expect(t.written[0].seconds).toBe(10);
    // 写的是 9-15 那天的正午，不是「此刻」
    expect(new Date(t.written[0].at).getDate()).toBe(15);

    await t.clock.flush();
    expect(new Date(t.written[1].at).getDate()).toBe(16);
  });
});
