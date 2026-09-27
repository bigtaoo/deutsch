// 2026-09-27：标签页在后台时 Chrome 推迟加载 <audio>，loadedmetadata 永远不来 —— 整本导入卡在「正在导入 0/N」。
// jsdom 里的 <audio> 本来就什么都不加载，正好就是那个「永远不来」。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAudioDuration } from './player';

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const decodeAudioData = vi.fn(async (_buf: ArrayBuffer) => ({ duration: 12.5 }));
class FakeOfflineAudioContext {
  decodeAudioData(buf: ArrayBuffer) {
    return decodeAudioData(buf);
  }
}

afterEach(() => {
  visibility = 'visible';
  decodeAudioData.mockClear();
  vi.unstubAllGlobals();
});

describe('readAudioDuration', () => {
  it('一开始就在后台：不等元素，解码拿时长', async () => {
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
    visibility = 'hidden';
    await expect(readAudioDuration(new Blob([new Uint8Array(4)]))).resolves.toBe(12.5);
  });

  it('等着等着切到后台：那一刻开始解码', async () => {
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
    const p = readAudioDuration(new Blob([new Uint8Array(4)]));
    expect(decodeAudioData).not.toHaveBeenCalled();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await expect(p).resolves.toBe(12.5);
  });

  it('前台：照旧只读元数据，不白解码一遍', async () => {
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
    void readAudioDuration(new Blob([new Uint8Array(4)]));
    await new Promise((r) => setTimeout(r, 10));
    expect(decodeAudioData).not.toHaveBeenCalled();
  });
});
