import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { playSfx, preloadSfx, resetSfxForTests, sfxEvents, sfxStatus, wakeSfx } from './sfx';

/**
 * 变更 87：音效从 Web Audio 改成 <audio>。
 *
 * 这一份守的是**真机上那个三次没修对的 bug**：旧实现里 `preloadSfx` 幂等且失败不重试，
 * 开头那一次 fetch/decode 失败就把音效永久关掉，之后每一声都从「还没取到，跳过」
 * 这个出口走掉 —— 连设置页的试听也救不回来。所以下面最要紧的两条是「失败之后会重试」
 * 和「不再有跳过这个出口」。
 */

type Listener = () => void;

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  preload = '';
  volume = 1;
  loop = true;
  muted = false;
  paused = true;
  currentTime = 7;
  readyState = 0;
  error: { code: number } | null = null;
  plays = 0;
  pauses = 0;
  loads = 0;
  /** ok = 播得出来；reject = iOS 那种「不在手势里」被拒。 */
  behavior: 'ok' | 'reject' = 'ok';
  /** 播放落地要多久。回归测试要的是真实延迟，零延迟会让竞态自己收敛。 */
  playDelayMs = 1;
  private listeners = new Map<string, Listener[]>();

  constructor(src?: string) {
    this.src = src ?? '';
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** 让测试能模拟「这个文件加载失败了」。 */
  failLoading(code = 4): void {
    this.error = { code };
    this.readyState = 0;
    for (const fn of this.listeners.get('error') ?? []) fn();
  }

  load(): void {
    this.loads += 1;
    this.error = null;
  }

  play(): Promise<void> {
    this.plays += 1;
    this.paused = false;
    if (this.behavior === 'reject') {
      return Promise.reject(new Error('NotAllowedError: play() failed'));
    }
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        this.readyState = 4;
        resolve();
      }, this.playDelayMs);
    });
  }

  pause(): void {
    this.pauses += 1;
    this.paused = true;
  }
}

function byName(name: string): FakeAudio | undefined {
  return FakeAudio.instances.find((a) => a.src.includes(name));
}

/** 等到最近这一批 play() 的 promise 都落地。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  resetSfxForTests();
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSfxForTests();
});

describe('预热', () => {
  it('建三个元素，各自指向自己的文件，音量压过一道', async () => {
    await preloadSfx();
    expect(FakeAudio.instances).toHaveLength(3);
    for (const name of ['tap.wav', 'right.wav', 'wrong.wav']) {
      const el = byName(name);
      expect(el, name).toBeDefined();
      expect(el?.preload).toBe('auto');
      expect(el?.volume).toBeCloseTo(0.55);
      // 音效是一声就完的东西 —— 开着 loop 会被当成一段媒体接管。
      expect(el?.loop).toBe(false);
    }
  });

  it('反复调不会把元素建成第二份', async () => {
    await preloadSfx();
    await preloadSfx();
    await preloadSfx();
    expect(FakeAudio.instances).toHaveLength(3);
  });

  it('**加载失败之后再调会重新 load** —— 旧实现在这里把音效永久关掉了', async () => {
    await preloadSfx();
    const el = byName('right.wav');
    const before = el?.loads ?? 0;
    el?.failLoading();
    expect(sfxEvents().join('\n')).toContain('right：加载失败');

    await preloadSfx();
    expect(el?.loads, '失败过的元素应该被重新 load').toBe(before + 1);
  });

  it('正在播的那一个不会被 load() 打断', async () => {
    await preloadSfx();
    const el = byName('tap.wav');
    if (!el) throw new Error('没建出 tap');
    el.readyState = 0;
    el.paused = false; // 正在播
    const before = el.loads;
    await preloadSfx();
    expect(el.loads).toBe(before);
  });
});

describe('响一下', () => {
  it('**还没加载完也照样下播放指令** —— 不再有「还没取到，跳过」这个出口', () => {
    // 刻意不 preload：元素此刻 readyState=0。
    playSfx('right');
    const el = byName('right.wav');
    expect(el, '该当场把元素建出来').toBeDefined();
    expect(el?.plays).toBe(1);
    expect(sfxEvents().join('\n')).not.toContain('还没取到');
  });

  it('连着答两题：从头开始，而不是排队', async () => {
    await preloadSfx();
    const el = byName('right.wav');
    if (!el) throw new Error('没建出 right');
    el.currentTime = 0.4;
    playSfx('right');
    expect(el.currentTime).toBe(0);
    await settle();
  });

  it('三个音效各有各的元素 —— 点选项的声音不会把「答对」顶掉', async () => {
    await preloadSfx();
    playSfx('tap');
    playSfx('right');
    await settle();
    expect(byName('tap.wav')?.plays).toBeGreaterThanOrEqual(1);
    expect(byName('right.wav')?.plays).toBeGreaterThanOrEqual(1);
    expect(byName('tap.wav')).not.toBe(byName('right.wav'));
  });

  it('播成功留一笔，带上加载状态', async () => {
    await preloadSfx();
    playSfx('right');
    await settle();
    expect(sfxEvents().join('\n')).toMatch(/right：响 readyState=\d/);
  });

  it('被拒也留一笔 —— 静默失败正是前三次没人说得清卡在哪的原因', async () => {
    await preloadSfx();
    const el = byName('wrong.wav');
    if (!el) throw new Error('没建出 wrong');
    el.behavior = 'reject';
    playSfx('wrong');
    await settle();
    expect(sfxEvents().join('\n')).toContain('wrong：被拒');
  });

  it('没有 Audio 的环境里不抛，只留一笔', () => {
    vi.stubGlobal('Audio', undefined);
    expect(() => playSfx('tap')).not.toThrow();
    expect(sfxEvents().join('\n')).toContain('这个环境没有 Audio');
  });
});

describe('iOS 解锁', () => {
  it('第一次点击把三个元素静音播一下再停住 —— 之后 setTimeout 里的「答对」才放得出来', async () => {
    await preloadSfx();
    document.dispatchEvent(new MouseEvent('click'));
    await settle();

    for (const name of ['tap.wav', 'right.wav', 'wrong.wav']) {
      const el = byName(name);
      expect(el?.plays, `${name} 该被解锁播一次`).toBeGreaterThanOrEqual(1);
      expect(el?.pauses, `${name} 该被停住`).toBeGreaterThanOrEqual(1);
      // 解锁不该发出声音，而且事后要把静音还回去。
      expect(el?.muted, `${name} 解锁后要恢复不静音`).toBe(false);
    }
    expect(sfxEvents().join('\n')).toContain('已趁手势解锁');
  });

  it('只解锁一次 —— 后面每次点击不再重播', async () => {
    await preloadSfx();
    document.dispatchEvent(new MouseEvent('click'));
    await settle();
    const names = ['tap.wav', 'right.wav', 'wrong.wav'];
    const counts = names.map((n) => byName(n)?.plays);
    document.dispatchEvent(new MouseEvent('click'));
    document.dispatchEvent(new MouseEvent('click'));
    await settle();
    expect(names.map((n) => byName(n)?.plays)).toEqual(counts);
  });

  it('wakeSfx 当场解锁 —— 设置页的试听按钮靠它趁手势', async () => {
    wakeSfx();
    await settle();
    expect(FakeAudio.instances).toHaveLength(3);
    expect(byName('tap.wav')?.plays).toBeGreaterThanOrEqual(1);
  });

  it('解锁被拒也留一笔', async () => {
    await preloadSfx();
    for (const n of ['tap.wav', 'right.wav', 'wrong.wav']) {
      const el = byName(n);
      if (el) el.behavior = 'reject';
    }
    wakeSfx();
    await settle();
    expect(sfxEvents().join('\n')).toContain('解锁被拒');
  });
});

describe('会话类别', () => {
  it('播之前声明一次 playback —— 否则 WebKit 归成环境音，跟着静音开关走', async () => {
    const audioSession = { type: 'ambient' };
    vi.stubGlobal('navigator', { ...navigator, audioSession });
    await preloadSfx();
    playSfx('tap');
    expect(audioSession.type).toBe('playback');
    await settle();
  });

  it('录音期间不改类别 —— play-and-record 被改掉就收不了麦', async () => {
    const audioSession = { type: 'play-and-record' };
    vi.stubGlobal('navigator', { ...navigator, audioSession });
    await preloadSfx();
    playSfx('tap');
    expect(audioSession.type).toBe('play-and-record');
    await settle();
  });
});

describe('诊断', () => {
  it('每个元素的加载状态都报出来，解锁与否也报', async () => {
    await preloadSfx();
    const right = byName('right.wav');
    if (right) right.readyState = 4;
    const s = sfxStatus();
    expect(s.hasAudioContext).toBe(true);
    expect(s.state).toContain('未解锁');
    expect(s.state).toContain('tap=readyState=0');
    expect(s.state).toContain('right=readyState=4');
    expect(s.loaded).toEqual(['right']);
  });

  it('解锁之后 state 会说已解锁', async () => {
    await preloadSfx();
    wakeSfx();
    await settle();
    expect(sfxStatus().state).toContain('已解锁');
  });

  it('加载失败的那个不算进 loaded', async () => {
    await preloadSfx();
    const el = byName('right.wav');
    if (!el) throw new Error('没建出 right');
    el.readyState = 4;
    el.failLoading();
    expect(sfxStatus().loaded).not.toContain('right');
  });

  it('记录有上限，不会无限涨', async () => {
    await preloadSfx();
    for (let i = 0; i < 60; i += 1) playSfx('tap');
    await settle();
    expect(sfxEvents().length).toBeLessThanOrEqual(24);
  });
});
