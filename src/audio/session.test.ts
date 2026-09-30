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

  it('没有 Audio Session API 的环境什么都不做、不抛', () => {
    delete (navigator as unknown as { audioSession?: unknown }).audioSession;
    expect(() => preferPlaybackSession()).not.toThrow();
    expect(() => enterRecordingSession()).not.toThrow();
  });

  it('音效响之前会话已是 playback', async () => {
    const seen: string[] = [];
    class Ctx {
      state = 'running';
      destination = {};
      createGain() {
        return { gain: { value: 0 }, connect() {} };
      }
      createBufferSource() {
        return { connect() {}, start: () => seen.push(fake.type) };
      }
      async decodeAudioData() {
        return {};
      }
    }
    vi.stubGlobal('AudioContext', Ctx);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
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
