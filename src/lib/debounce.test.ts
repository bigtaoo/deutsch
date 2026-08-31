import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounceByKey } from './debounce';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('debounceByKey (FR-11.7: 30s 去抖)', () => {
  it('only fires once after the last call within the delay window', () => {
    const fn = vi.fn();
    const { schedule } = debounceByKey(fn, 30_000);

    schedule('lesson-1');
    vi.advanceTimersByTime(20_000);
    schedule('lesson-1'); // 重新计时
    vi.advanceTimersByTime(20_000);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('tracks separate keys independently', () => {
    const fn = vi.fn();
    const { schedule } = debounceByKey(fn, 30_000);

    schedule('lesson-1');
    schedule('lesson-2');
    vi.advanceTimersByTime(30_000);

    expect(fn).toHaveBeenCalledWith('lesson-1');
    expect(fn).toHaveBeenCalledWith('lesson-2');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancelAll stops pending calls from firing', () => {
    const fn = vi.fn();
    const { schedule, cancelAll } = debounceByKey(fn, 30_000);
    schedule('lesson-1');
    cancelAll();
    vi.advanceTimersByTime(30_000);
    expect(fn).not.toHaveBeenCalled();
  });
});
