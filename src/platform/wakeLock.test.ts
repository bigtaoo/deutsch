import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  attachWakeLockListener,
  resetWakeLockForTests,
  setKeepAwake,
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
  it('进练习界面申请一次，离开就还回去', async () => {
    setKeepAwake(true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    setKeepAwake(false);
    expect(requests[0].released).toBe(true);
  });

  it('重复设成同一个值不会重复申请', async () => {
    setKeepAwake(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    setKeepAwake(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('申请还在路上就离开了练习界面 —— 回来的那把锁要立刻还掉，不能留着', async () => {
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

  it('回到前台但已经不在练习界面上了 —— 不申请', async () => {
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
