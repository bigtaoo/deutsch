// FR-6.8 录音器（MicEcho）与「这台设备能不能录」（echoSupported）。
//
// 状态机那一侧由 shadowing.test.ts 守，真浏览器里那条链由 e2e/shadowing.spec.ts 守；
// 这里守的是夹在中间、两边都够不着的几件事：
// - **iOS 壳版本门槛**：写错了，热更一下去旧壳就是闪退（没有 NSMicrophoneUsageDescription
//   时调麦克风，系统直接杀进程）。所以「问不出版本」「版本不够」都必须回 false。
// - **作废的录音不许交出来**：halt() 之后才到的 stop 事件，拿到的必须是 null。
// - **回放的保底**：ended 永远不来时，循环不能停死在回放上。
//
// 假货都带真实的异步（stop 事件、ended 事件晚一拍才到）—— 真的 MediaRecorder 就是这样，
// 零延迟的同步假货会把「迟到的事件」这类竞态整个藏起来。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MicEcho, describeMicError, echoSupported, ECHO_MIN_IOS } from './echo';
import { nativePlatform } from '@/platform/native';
import { askBridgeVerbose } from '@/platform/nativeUpdate';

vi.mock('@/platform/native', () => ({ nativePlatform: vi.fn(async () => 'web') }));
vi.mock('@/platform/nativeUpdate', async (importActual) => ({
  ...(await importActual<typeof import('@/platform/nativeUpdate')>()),
  askBridgeVerbose: vi.fn(),
}));

class FakeRecorder {
  static last: FakeRecorder | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  private listeners: Record<string, Array<(e: { data: Blob }) => void>> = {};
  constructor(public stream: unknown) {
    FakeRecorder.last = this;
  }
  addEventListener(type: string, fn: (e: { data: Blob }) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    // 真的 MediaRecorder：dataavailable 与 stop 都是之后才派发的
    setTimeout(() => {
      this.emit('dataavailable', { data: new Blob(['take'], { type: this.mimeType }) });
      this.emit('stop', { data: new Blob() });
    }, 5);
  }
  private emit(type: string, e: { data: Blob }) {
    (this.listeners[type] ?? []).forEach((fn) => fn(e));
  }
}

class FakeSource {
  static all: FakeSource[] = [];
  buffer: { duration: number } | null = null;
  started = false;
  stopped = false;
  private onEnded: Array<() => void> = [];
  constructor() {
    FakeSource.all.push(this);
  }
  connect() {}
  addEventListener(_: 'ended', fn: () => void) {
    this.onEnded.push(fn);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
    // 真的 AudioBufferSourceNode 被 stop() 掐断时**也会**发 ended
    setTimeout(() => this.onEnded.forEach((fn) => fn()), 1);
  }
  /** 测试里模拟「自然放完」 */
  end() {
    this.onEnded.forEach((fn) => fn());
  }
}

class FakeAudioContext {
  destination = {};
  resume = vi.fn(async () => {});
  decodeAudioData = vi.fn(async () => ({ duration: 2 }));
  createBufferSource() {
    return new FakeSource();
  }
}

let track: { stop: ReturnType<typeof vi.fn> };
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeRecorder.last = null;
  FakeSource.all = [];
  track = { stop: vi.fn() };
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.mocked(nativePlatform).mockResolvedValue('web');
  vi.mocked(askBridgeVerbose).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('MicEcho', () => {
  it('录一段、交出来的 Blob 带着录音器的 mimeType', async () => {
    const echo = new MicEcho();
    await echo.open();
    await echo.start();
    const clip = await echo.stop();
    expect(clip?.type).toBe('audio/webm;codecs=opus');
    expect(await clip?.text()).toBe('take');
  });

  it('开麦克风时要回声消除：原句是外放的，不开的话录进去一半是原句本身', async () => {
    await new MicEcho().open();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ echoCancellation: true }),
    });
  });

  it('麦克风只要一次：跟读期间一直开着，每遍不再重新申请', async () => {
    const echo = new MicEcho();
    await echo.open();
    await echo.open();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('没 open 就 start：抛错（状态机据此退回固定间隔），而不是静默录个空', async () => {
    await expect(new MicEcho().start()).rejects.toThrow();
  });

  it('没在录的时候 stop 回 null', async () => {
    const echo = new MicEcho();
    await echo.open();
    expect(await echo.stop()).toBeNull();
  });

  it('halt() 之后才到的 stop 事件：这一段作废，交出来的是 null', async () => {
    const echo = new MicEcho();
    await echo.open();
    await echo.start();
    const pending = echo.stop(); // stop 事件还在路上
    echo.halt();
    expect(await pending).toBeNull();
  });

  it('close() 把音轨还回去，之后 isOpen 为 false', async () => {
    const echo = new MicEcho();
    await echo.open();
    echo.close();
    expect(track.stop).toHaveBeenCalled();
    expect(echo.isOpen).toBe(false);
  });

  it('回放自然放完 → onEnded 一次', async () => {
    const echo = new MicEcho();
    await echo.open();
    const onEnded = vi.fn();
    await echo.play(new Blob(['x']), { onEnded });
    FakeSource.all[0]!.end();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('回放被 halt() 掐断：随后到的 ended 不能当成「放完了」往下推', async () => {
    const echo = new MicEcho();
    await echo.open();
    const onEnded = vi.fn();
    await echo.play(new Blob(['x']), { onEnded });
    echo.halt();
    await settle();
    expect(FakeSource.all[0]!.stopped).toBe(true);
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('ended 永远不来（上下文被挂起）：时长 + 1 秒后保底当作放完', async () => {
    vi.useFakeTimers();
    const echo = new MicEcho();
    await echo.open();
    const onEnded = vi.fn();
    await echo.play(new Blob(['x']), { onEnded }); // duration 2 秒
    await vi.advanceTimersByTimeAsync(2900);
    expect(onEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('保底与 ended 撞车：只推进一次', async () => {
    vi.useFakeTimers();
    const echo = new MicEcho();
    await echo.open();
    const onEnded = vi.fn();
    await echo.play(new Blob(['x']), { onEnded });
    FakeSource.all[0]!.end();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});

describe('echoSupported', () => {
  it('浏览器：有 getUserMedia + MediaRecorder + AudioContext 就能录', async () => {
    expect(await echoSupported()).toBe(true);
  });

  it('没有 MediaRecorder（老 WebView）：不能录', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    expect(await echoSupported()).toBe(false);
  });

  it('没有 mediaDevices（非安全上下文）：不能录', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    expect(await echoSupported()).toBe(false);
  });

  it('Android 壳：先不开，连问都不问原生侧', async () => {
    vi.mocked(nativePlatform).mockResolvedValue('android');
    expect(await echoSupported()).toBe(false);
    expect(askBridgeVerbose).not.toHaveBeenCalled();
  });

  it(`iOS 壳 ≥ ${ECHO_MIN_IOS}：能录`, async () => {
    vi.mocked(nativePlatform).mockResolvedValue('ios');
    vi.mocked(askBridgeVerbose).mockResolvedValue({ ok: true, value: { version: ECHO_MIN_IOS } } as never);
    expect(await echoSupported()).toBe(true);
  });

  it('iOS 旧壳（没有 NSMicrophoneUsageDescription）：不能录 —— 调了就是闪退', async () => {
    vi.mocked(nativePlatform).mockResolvedValue('ios');
    vi.mocked(askBridgeVerbose).mockResolvedValue({ ok: true, value: { version: '0.6.6' } } as never);
    expect(await echoSupported()).toBe(false);
  });

  it('iOS 问不出壳版本（桥超时）：当作不能录，不赌', async () => {
    vi.mocked(nativePlatform).mockResolvedValue('ios');
    vi.mocked(askBridgeVerbose).mockResolvedValue({ ok: false, reason: 'timeout', ms: 4000 } as never);
    expect(await echoSupported()).toBe(false);
  });

  it('门槛常量和 Info.plist 那条注释说的是同一个版本', () => {
    // 改首个带麦克风声明的版本号时，这里会提醒你两边一起改
    expect(ECHO_MIN_IOS).toBe('0.7.0');
  });
});

describe('describeMicError', () => {
  it.each([
    ['NotAllowedError', '没有授权'],
    ['SecurityError', '没有授权'],
    ['NotFoundError', '没有找到麦克风'],
    ['NotReadableError', '被别的程序占着'],
  ])('%s → 说人话', (name, text) => {
    expect(describeMicError(new DOMException('x', name))).toContain(text);
  });

  it('认不出的错误：带上原始信息', () => {
    expect(describeMicError(new Error('奇怪的错'))).toContain('奇怪的错');
  });
});
