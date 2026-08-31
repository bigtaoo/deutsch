/**
 * 按 key 去抖：同一个 key 在 delayMs 内多次调用只在最后一次落地执行一次。
 * 用于 FR-11.7（标注变更后 30s 去抖再推送）。不同 key 互不影响。
 */
export function debounceByKey<Key, Args extends unknown[]>(
  fn: (key: Key, ...args: Args) => void | Promise<void>,
  delayMs: number,
): { schedule: (key: Key, ...args: Args) => void; cancelAll: () => void } {
  const timers = new Map<Key, ReturnType<typeof setTimeout>>();

  function schedule(key: Key, ...args: Args): void {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(key);
      void fn(key, ...args);
    }, delayMs);
    timers.set(key, timer);
  }

  function cancelAll(): void {
    // 卸载/测试清理用；正常流程让去抖计时器自然到期执行。
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { schedule, cancelAll };
}
