import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { playSfx, preloadSfx, resetSfxForTests } from './sfx';

interface FakeSource {
  buffer: unknown;
  connect: (target: unknown) => void;
  start: () => void;
}

class FakeContext {
  static instances: FakeContext[] = [];
  state: AudioContextState = 'suspended';
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
  async resume() {
    this.resumed += 1;
    this.state = 'running';
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
    await Promise.resolve();
    expect(ctx.sources).toHaveLength(1);
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
    await Promise.resolve();
    expect(ctx.sources[0].connect).toHaveBeenCalledWith(ctx.gain);
  });

  it('上下文已经在跑时不重复 resume', async () => {
    await preloadSfx();
    const ctx = FakeContext.instances[0];
    ctx.state = 'running';
    playSfx('tap');
    expect(ctx.resumed).toBe(0);
  });
});
