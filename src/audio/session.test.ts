// iOS 静音开关：Web Audio 要声明 playback 会话，录音期间切 play-and-record（session.ts）。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { enterRecordingSession, leaveRecordingSession, preferPlaybackSession } from './session';
import { playSfx, preloadSfx, resetSfxForTests } from './sfx';
import { MicEcho } from './echo';

let fake: { type: string };

beforeEach(() => {
  fake = { type: 'auto' };
  Object.defineProperty(navigator, 'audioSession', { value: fake, configurable: true });
});

afterEach(() => {
  delete (navigator as unknown as { audioSession?: unknown }).audioSession;
  vi.unstubAllGlobals();
  resetSfxForTests();
});

describe('audio session', () => {
  it('preferPlaybackSession 把 auto 改成 playback', () => {
    preferPlaybackSession();
    expect(fake.type).toBe('playback');
  });

  it('录音中不去抢会话 —— playback 开不了麦克风', () => {
    enterRecordingSession();
    preferPlaybackSession();
    expect(fake.type).toBe('play-and-record');
    leaveRecordingSession();
    expect(fake.type).toBe('playback');
  });

  // 变更 80：同一个类别再写一遍，WebKit 可能当成一次会话变更、把在跑的上下文打断。
  it('已经是 playback 时不再写', () => {
    let writes = 0;
    let value = 'playback';
    Object.defineProperty(navigator, 'audioSession', {
      value: {
        get type() {
          return value;
        },
        set type(v: string) {
          writes += 1;
          value = v;
        },
      },
      configurable: true,
    });
    preferPlaybackSession();
    preferPlaybackSession();
    expect(writes).toBe(0);
  });

  it('没有 Audio Session API 的环境什么都不做、不抛', () => {
    delete (navigator as unknown as { audioSession?: unknown }).audioSession;
    expect(() => preferPlaybackSession()).not.toThrow();
    expect(() => enterRecordingSession()).not.toThrow();
  });

  it('音效响之前会话已是 playback', async () => {
    // 变更 87：音效改走 <audio> 了，所以探针也跟着落到 play() 上 ——
    // 上一版这条是从 AudioContext 的 createBufferSource().start 里取的，
    // 那条路现在整个不存在，探针会一直空着（而断言照样"通过"地红）。
    const seen: string[] = [];
    class FakeAudio {
      preload = '';
      volume = 1;
      loop = true;
      muted = false;
      paused = true;
      currentTime = 0;
      readyState = 0;
      error: unknown = null;
      addEventListener(): void {}
      load(): void {}
      pause(): void {}
      play(): Promise<void> {
        seen.push(fake.type);
        return Promise.resolve();
      }
    }
    vi.stubGlobal('Audio', FakeAudio);
    await preloadSfx();
    fake.type = 'auto'; // 比如被别处改回去了
    playSfx('tap');
    expect(seen).toEqual(['playback']);
  });

  it('麦克风打不开时会话退回 playback，不留在录音档', async () => {
    vi.stubGlobal('AudioContext', class { async resume() {} });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => { throw new DOMException('no', 'NotAllowedError'); }) },
      configurable: true,
    });
    await expect(new MicEcho().open()).rejects.toThrow();
    expect(fake.type).toBe('playback');
  });

  it('开麦时切 play-and-record，close 后切回 playback', async () => {
    vi.stubGlobal('AudioContext', class { async resume() {} });
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(async () => {
          expect(fake.type).toBe('play-and-record');
          return { getTracks: () => [{ stop }] };
        }),
      },
      configurable: true,
    });
    const echo = new MicEcho();
    await echo.open();
    expect(fake.type).toBe('play-and-record');
    echo.close();
    expect(fake.type).toBe('playback');
    expect(stop).toHaveBeenCalled();
  });
});
