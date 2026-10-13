import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { playSfx, preloadSfx, resetSfxForTests, sfxStatus, wakeSfx } from './sfx';

interface FakeSource {
  buffer: unknown;
  connect: (target: unknown) => void;
  start: () => void;
}

class FakeContext {
  static instances: FakeContext[] = [];
  // 'interrupted' 是 WebKit 在 iOS 上的非标准状态，类型里没有。
  state: AudioContextState | 'interrupted' = 'suspended';
  /** resume 要等多久才落地；null = 永不 settle（iOS 上被打断时见过的那种）。 */
  resumeDelayMs: number | null = 0;
  resumed = 0;
  sources: FakeSource[] = [];
  gain = { gain: { value: 0 }, connect: vi.fn() };
  destination = {};
  decoded: ArrayBuffer[] = [];

  constructor() {
    FakeContext.instances.push(this);
  }
  createGain() {
    return this.gain as unknown as GainNode;
  }
  createBufferSource() {
    const source: FakeSource = { buffer: null, connect: vi.fn(), start: vi.fn() };
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
  async decodeAudioData(data: ArrayBuffer) {
    this.decoded.push(data);
    return { duration: 0.1 } as AudioBuffer;
  }
  resume() {
    this.resumed += 1;
    const delay = this.resumeDelayMs;
    if (delay === null) return new Promise<void>(() => {});
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        this.state = 'running';
        resolve();
      }, delay);
    });
  }
}

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
}

beforeEach(() => {
  resetSfxForTests();
  FakeContext.instances = [];
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('fetch', okFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSfxForTests();
});

describe('preloadSfx', () => {
  it('三个文件一次取完', async () => {
    await preloadSfx();
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith('sfx/tap.wav'))).toBe(true);
    expect(urls.some((u) => u.endsWith('sfx/right.wav'))).toBe(true);
    expect(urls.some((u) => u.endsWith('sfx/wrong.wav'))).toBe(true);
  });

  it('幂等：进两次复习页只取一轮', async () => {
    await preloadSfx();
    await preloadSfx();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('一个文件取不到，另外两个照常 —— 不能因为一声没有就整块哑掉', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error('offline');
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }),
    );
    await expect(preloadSfx()).resolves.toBeUndefined();
    expect(FakeContext.instances[0].decoded).toHaveLength(2);
  });

  it('没有 AudioContext（老 WebView / jsdom）时安安静静地什么都不做', async () => {
    vi.unstubAllGlobals();
    resetSfxForTests();
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    vi.stubGlobal('fetch', okFetch());
    await expect(preloadSfx()).resolves.toBeUndefined();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('playSfx', () => {
  it('预取完之后点一下就响，并且 resume 了上下文（iOS 手势链）', async () => {
    await preloadSfx();
    const ctx = FakeContext.instances[0];
    playSfx('tap');
    expect(ctx.resumed).toBe(1);
    // start() 要等 resume() 的 promise 真的 resolve 才发生——WKWebView 上，
    // suspended 时排的音在 resume 之后并不会响，所以这里不能提前断言。
    expect(ctx.sources).toHaveLength(0);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
    expect(ctx.sources[0].start).toHaveBeenCalled();
  });

  it('还没预取完就点 —— 这一下没声音，但不抛、也不排队补一声迟到的', () => {
    expect(() => playSfx('right')).not.toThrow();
    expect(FakeContext.instances[0]?.sources ?? []).toHaveLength(0);
  });

  it('接到 destination 之前先过统一衰减 —— 提示音不能盖住正在听的那一句', async () => {
    await preloadSfx();
    const ctx = FakeContext.instances[0];
    expect(ctx.gain.gain.value).toBeGreaterThan(0);
    expect(ctx.gain.gain.value).toBeLessThan(1);
    playSfx('wrong');
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
    expect(ctx.sources[0].connect).toHaveBeenCalledWith(ctx.gain);
  });

  it('上下文已经在跑时不重复 resume', async () => {
    await preloadSfx();
    const ctx = FakeContext.instances[0];
    ctx.state = 'running';
    playSfx('tap');
    expect(ctx.resumed).toBe(0);
  });

  // 变更 80：iOS 上「刚放完一句德语 → 马上点选项」时上下文停在 interrupted。
  // 旧代码只认 suspended，看到别的状态就直接 start()，排进不在跑的上下文里静默丢掉。
  it('interrupted 也要先 resume，等真的在跑了才 start', async () => {
    await preloadSfx();
    const ctx = FakeContext.instances[0];
    ctx.state = 'interrupted';
    ctx.resumeDelayMs = 30;
    playSfx('tap');
    expect(ctx.resumed).toBe(1);
    expect(ctx.sources).toHaveLength(0);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
    expect(ctx.state).toBe('running');
  });

  it('resume 永不 settle 时这一声放弃，不在一秒半以后迟到地响，并记下原因', async () => {
    vi.useFakeTimers();
    try {
      await preloadSfx();
      const ctx = FakeContext.instances[0];
      ctx.resumeDelayMs = null;
      playSfx('right');
      await vi.advanceTimersByTimeAsync(2000);
      expect(ctx.sources).toHaveLength(0);
      const log = sfxStatus().events.join(' | ');
      expect(log).toMatch(/resume 超时/);
      expect(log).toMatch(/这一声没了/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同时点两下只发一趟 resume，两声都在它落地之后响', async () => {
    await preloadSfx();
    const ctx = FakeContext.instances[0];
    ctx.resumeDelayMs = 30;
    playSfx('tap');
    playSfx('right');
    expect(ctx.resumed).toBe(1);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(2));
  });

  it('上下文被系统 close 了就重建一个，解码好的三声照用', async () => {
    await preloadSfx();
    const first = FakeContext.instances[0];
    first.state = 'closed';
    playSfx('wrong');
    expect(FakeContext.instances).toHaveLength(2);
    const second = FakeContext.instances[1];
    await vi.waitFor(() => expect(second.sources).toHaveLength(1));
    expect(first.sources).toHaveLength(0);
  });

  it('还没取到文件时，这次手势照样把上下文叫醒 —— 后面那声「答对」才有得响', () => {
    wakeSfx();
    const ctx = FakeContext.instances[0];
    playSfx('tap');
    expect(ctx.resumed).toBe(1);
    expect(sfxStatus().events.join(' | ')).toMatch(/tap：还没取到/);
  });
});

describe('sfxStatus', () => {
  it('响过一次之后，状态里有上下文状态、取到的文件和那一笔记录', async () => {
    await preloadSfx();
    FakeContext.instances[0].state = 'running';
    playSfx('tap');
    const status = sfxStatus();
    expect(status.hasAudioContext).toBe(true);
    expect(status.state).toBe('running');
    expect(status.loaded.sort()).toEqual(['right', 'tap', 'wrong']);
    expect(status.session).toMatch(/无/);
    expect(status.events.at(-1)).toMatch(/tap：响/);
  });
});
