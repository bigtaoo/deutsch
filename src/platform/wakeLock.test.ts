import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  attachWakeLockListener,
  resetWakeLockForTests,
  setKeepAwake,
  wakeLockState,
  wakeLockSupported,
} from './wakeLock';

interface FakeSentinel {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
  fireRelease: () => void;
}

function fakeSentinel(): FakeSentinel {
  const listeners: Array<() => void> = [];
  const s: FakeSentinel = {
    released: false,
    release: async () => {
      s.released = true;
      s.fireRelease();
    },
    addEventListener: (_type, listener) => listeners.push(listener),
    fireRelease: () => listeners.forEach((l) => l()),
  };
  return s;
}

let requests: FakeSentinel[];
let request: ReturnType<typeof vi.fn>;

function install(): void {
  requests = [];
  request = vi.fn(async () => {
    const s = fakeSentinel();
    requests.push(s);
    return s;
  });
  Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  resetWakeLockForTests();
  install();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
  resetWakeLockForTests();
  Reflect.deleteProperty(navigator, 'wakeLock');
});

describe('setKeepAwake', () => {
  it('应用挂载时申请一次，卸载就还回去', async () => {
    setKeepAwake(true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    setKeepAwake(false);
    expect(requests[0].released).toBe(true);
  });

  it('已经拿着锁时重复调不会再申请一把', async () => {
    setKeepAwake(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    setKeepAwake(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('第一次申请失败之后还要有第二次机会 —— 否则那台设备上它永远是坏的', async () => {
    request.mockRejectedValueOnce(new Error('NotAllowedError'));
    setKeepAwake(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    // **必须等那次失败真的落地**（`requesting` 在 finally 里才复位）。
    // 少了这一步，重试会撞上还没复位的 `requesting` 而被挡掉，
    // 于是这条用例时绿时红 —— 而会随机变绿的门禁比没有门禁更糟。
    await new Promise((r) => setTimeout(r, 0));

    // 再调一次（真实世界里来自 visibilitychange 那条路）。
    setKeepAwake(false);
    setKeepAwake(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(requests).toHaveLength(1);
  });

  it('申请还在路上应用就关了 —— 回来的那把锁要立刻还掉，不能留着', async () => {
    setKeepAwake(true);
    setKeepAwake(false);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].released).toBe(true);
  });

  it('页面不可见时不申请 —— 规范规定那时一定会被拒', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    setKeepAwake(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('request 抛出时不炸出去 —— 屏幕照旧会灭，仅此而已', async () => {
    request.mockRejectedValue(new Error('NotAllowedError'));
    expect(() => setKeepAwake(true)).not.toThrow();
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
  });
});

describe('回到前台要把锁要回来', () => {
  it('切出去（浏览器自动释放）再回来 —— 重新申请一次', async () => {
    const stop = attachWakeLockListener();
    setKeepAwake(true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    // 浏览器在页面隐藏时自动释放：sentinel 触发 release 事件，但我们没有主动还。
    requests[0].fireRelease();
    setVisibility('hidden');
    setVisibility('visible');

    // 少了这一步的表现是「切出去回来一次之后，常亮就永远失效了」。
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    stop();
  });

  it('回到前台但应用已经卸载了 —— 不申请', async () => {
    const stop = attachWakeLockListener();
    setKeepAwake(true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    setKeepAwake(false);
    setVisibility('hidden');
    setVisibility('visible');
    await new Promise((r) => setTimeout(r, 0));
    expect(requests).toHaveLength(1);
    stop();
  });

  it('卸载之后不再响应 visibilitychange', async () => {
    const stop = attachWakeLockListener();
    setKeepAwake(true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0].fireRelease();
    stop();
    setVisibility('hidden');
    setVisibility('visible');
    await new Promise((r) => setTimeout(r, 0));
    expect(requests).toHaveLength(1);
  });
});

describe('这台设备不支持的时候', () => {
  it('wakeLockSupported 如实说不支持，setKeepAwake 是空操作', () => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    expect(wakeLockSupported()).toBe(false);
    expect(() => setKeepAwake(true)).not.toThrow();
  });
});

describe('wakeLockState', () => {
  it('各字段分别对应一种成因、一个不同的下一步', async () => {
    expect(wakeLockState()).toMatchObject({ supported: true, wanted: false, held: false, lastResult: null });
    setKeepAwake(true);
    await vi.waitFor(() => expect(wakeLockState().held).toBe(true));
    expect(wakeLockState()).toMatchObject({ supported: true, wanted: true, held: true, lastResult: 'ok' });
  });

  it('申请被拒时是 wanted 而不 held —— 这一档要和「不支持」分得开', async () => {
    request.mockRejectedValue(new Error('NotAllowedError'));
    setKeepAwake(true);
    await vi.waitFor(() => expect(wakeLockState().lastResult).toBe('rejected'));
    expect(wakeLockState()).toMatchObject({ supported: true, wanted: true, held: false });
  });

  it('这台设备没有这个 API 时 supported 是 false', () => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    expect(wakeLockState().supported).toBe(false);
  });

  // 这一条守的是诊断行**唯一**的用法：人只能站在设置页读它，而那时锁早还回去了。
  // 只报「此刻有没有拿着」的话，那一行永远写「现在不需要」，等于什么都没说。
  it('锁还回去之后仍然说得出上一次申请的结果 —— 诊断行就靠这一条才有用', async () => {
    setKeepAwake(true);
    await vi.waitFor(() => expect(wakeLockState().held).toBe(true));
    setKeepAwake(false); // 切后台 / 卸载
    const state = wakeLockState();
    expect(state.held).toBe(false);
    expect(state.wanted).toBe(false);
    expect(state.lastResult).toBe('ok');
    expect(state.lastAgoMs).toBeGreaterThanOrEqual(0);
  });

  it('一次都还没申请过时 lastResult 是 null，不能报成「被拒」', () => {
    expect(wakeLockState().lastResult).toBeNull();
    expect(wakeLockState().lastAgoMs).toBe(0);
  });
});
