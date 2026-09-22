// 启动时序（boot.ts）。
//
// 这一组守的是一类**不报错、不留日志**的坏法：启动链上有一个 Promise 永远不 settle，
// 于是挂在它后面的所有事都不发生。`Promise.allSettled` 接得住 reject，接不住这个。
//
// 代价在原生壳上最重：关启动图、取消热更回滚倒计时、查更新，三件事都排在那个 then 里。
// 一张表卡住 = 对着启动图干等 + 20 秒后 bundle 被判定起不来而回滚 + 连更新都不查一次。
// 也就是「这台设备退回旧版并且再也更新不动」—— 2026-09-22 刚在更新器自己身上
// 踩过一模一样的坑（变更 50），那次的代价是发一次 TestFlight 才解得开。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleBoot } from './boot';

describe('scheduleBoot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('一切顺利时两档都调用，各一次', async () => {
    const onAlive = vi.fn();
    const onStoresReady = vi.fn();
    scheduleBoot({ loads: [Promise.resolve(1), Promise.resolve(2)], onAlive, onStoresReady });

    await vi.advanceTimersByTimeAsync(0);
    expect(onAlive).toHaveBeenCalledTimes(1);
    expect(onStoresReady).toHaveBeenCalledTimes(1);
  });

  it('某张表 reject 也照常往下走 —— 读挂了的应用仍然要能用', async () => {
    const onAlive = vi.fn();
    const onStoresReady = vi.fn();
    scheduleBoot({
      loads: [Promise.resolve(1), Promise.reject(new Error('IndexedDB 打不开'))],
      onAlive,
      onStoresReady,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onAlive).toHaveBeenCalledTimes(1);
    expect(onStoresReady).toHaveBeenCalledTimes(1);
  });

  // ── 核心：永不 settle 的那一张 ─────────────────────────────────────

  it('**有一张表永远不 settle 时，onAlive 照样要到** —— 否则启动图不关、热更回滚', async () => {
    const onAlive = vi.fn();
    const onStoresReady = vi.fn();
    scheduleBoot({
      loads: [Promise.resolve(1), new Promise(() => {})],
      onAlive,
      onStoresReady,
      timeoutMs: 8000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onAlive).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(8000);
    // 修之前：这里永远等不到，于是 notifyAppReady() 一次都不会调，
    // 插件 20 秒后判定这个 bundle 起不来并回滚。
    expect(onAlive).toHaveBeenCalledTimes(1);
  });

  it('但 onStoresReady **不能**被超时提前触发 —— 同步有真实的顺序约束', async () => {
    // 拉取会往库里写，写完让 store 重读；初次 load() 晚于那次重读的话，
    // 界面就退回到拉取之前的旧值了。所以这一档宁可不跑，也不能抢在读完之前跑。
    const onStoresReady = vi.fn();
    scheduleBoot({
      loads: [new Promise(() => {})],
      onAlive: vi.fn(),
      onStoresReady,
      timeoutMs: 8000,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStoresReady).not.toHaveBeenCalled();
  });

  it('超时说过「活着」之后，表后来读完了也不再说第二遍', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onAlive = vi.fn();
    const onStoresReady = vi.fn();
    scheduleBoot({ loads: [slow], onAlive, onStoresReady, timeoutMs: 8000 });

    await vi.advanceTimersByTimeAsync(8000);
    expect(onAlive).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    // 关两次启动图、取消两次回滚倒计时、查两次更新都是错的。
    expect(onAlive).toHaveBeenCalledTimes(1);
    // 而这一档到这时候才该发生：表真的读完了。
    expect(onStoresReady).toHaveBeenCalledTimes(1);
  });

  it('读得快的时候不等满超时 —— 正常冷启动不该被这个数拖慢', async () => {
    const onAlive = vi.fn();
    scheduleBoot({
      loads: [Promise.resolve(1)],
      onAlive,
      onStoresReady: vi.fn(),
      timeoutMs: 8000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onAlive).toHaveBeenCalledTimes(1);
  });

  it('默认超时明显小于热更 20 秒的回滚倒计时', async () => {
    // 不传 timeoutMs 时用的那个默认值必须留够余量：onAlive 里还要跑
    // notifyAppReady() 自己那一趟过桥调用。
    const onAlive = vi.fn();
    scheduleBoot({ loads: [new Promise(() => {})], onAlive, onStoresReady: vi.fn() });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onAlive).toHaveBeenCalledTimes(1);
  });
});
