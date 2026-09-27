// 变更 69：手动导入的课的音频上服务器。要钉住的：
//   · 服务器上已经有就不传第二遍（HEAD 200 → 不 PUT）；
//   · 下载下来的字节必须和记着的哈希、字节数都对得上，对不上宁可报错也不存；
//   · 扫描的判据：手动课 + 本机有音频 + audioRef 对不上本机这份 —— DW 的课、没音频的、传过的都跳过；
//   · 登录过期 / 服务器没开时整趟停下，不对后面每一课都撞一次墙；同一时间只跑一趟。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson, LessonCache } from '@/types/models';

vi.stubEnv('VITE_SYNC_API_BASE', 'https://sync.example.test');
vi.stubEnv('VITE_GOOGLE_WEB_CLIENT_ID', 'client-id');

const getSessionToken = vi.fn<() => Promise<string | undefined>>();
vi.mock('@/sync/session', () => ({ getSessionToken: () => getSessionToken() }));

const lessons: Lesson[] = [];
const caches: LessonCache[] = [];
const blobs = new Map<string, Blob>();
vi.mock('@/db/lessons', () => ({ getAllLessons: async () => lessons }));
vi.mock('@/db/cache', () => ({
  getAllLessonCaches: async () => caches,
  getAudioBlob: async (id: string) => blobs.get(id),
}));

const audio = await import('./audio');
const { SyncAuthError } = await import('./client');

const BASE = 'https://sync.example.test';
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function lesson(id: string, patch: Partial<Lesson> = {}): Lesson {
  return {
    id,
    title: id,
    source: { type: 'manual', audioFileName: `${id}.mp3` },
    sentences: [],
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Lesson;
}
function cached(id: string, bytes: Uint8Array<ArrayBuffer>) {
  blobs.set(id, new Blob([bytes], { type: 'audio/mpeg' }));
  caches.push({ lessonId: id, hasAudio: true, audioBytes: bytes.length, fetchedAt: 0 });
}
const hashOf = async (bytes: Uint8Array<ArrayBuffer>) => audio.sha256Hex(new Blob([bytes]));

beforeEach(() => {
  lessons.length = 0;
  caches.length = 0;
  blobs.clear();
  audio.resetAudioSyncForTests();
  getSessionToken.mockResolvedValue('tok');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('sha256Hex', () => {
  it('与服务器那边 node:crypto 算的一致（空串的 SHA-256）', async () => {
    expect(await audio.sha256Hex(new Blob([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('uploadAudio', () => {
  it('服务器上没有：HEAD 404 → PUT 带上令牌和类型', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response('{}', { status: 201 }));
    const ref = await audio.uploadAudio(new Blob([bytes], { type: 'audio/mpeg' }));
    expect(ref).toEqual({ sha256: await hashOf(bytes), bytes: 3 });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/v1/audio/${ref.sha256}`);
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'audio/mpeg' });
  });

  it('服务器上已经有：只问一次，不传第二遍', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await audio.uploadAudio(new Blob([new Uint8Array([9])]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe('HEAD');
  });

  it('401 → SyncAuthError；PUT 被拒 → 带服务器的原话', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(audio.uploadAudio(new Blob([new Uint8Array([1])]))).rejects.toBeInstanceOf(SyncAuthError);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '音频总量超过上限' }), { status: 507 }));
    await expect(audio.uploadAudio(new Blob([new Uint8Array([1])]))).rejects.toThrow('音频总量超过上限');
  });

  it('HEAD 本身出错（不是 404）：报错，不去 PUT', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(audio.uploadAudio(new Blob([new Uint8Array([1])]))).rejects.toThrow('HTTP 500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('没有类型的 Blob：按 application/octet-stream 传，服务器自己认格式', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response('{}', { status: 201 }));
    await audio.uploadAudio(new Blob([new Uint8Array([1])]));
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ 'Content-Type': 'application/octet-stream' });
  });
});

describe('downloadAudio', () => {
  it('字节与哈希都对得上才返回', async () => {
    const bytes = new Uint8Array([5, 6, 7]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const blob = await audio.downloadAudio({ sha256: await hashOf(bytes), bytes: 3 });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it('下到的内容对不上（被截断 / 坏了）：报错，不返回', async () => {
    const bytes = new Uint8Array([5, 6, 7]);
    fetchMock.mockResolvedValueOnce(new Response(bytes.subarray(0, 2), { status: 200 }));
    await expect(audio.downloadAudio({ sha256: await hashOf(bytes), bytes: 3 })).rejects.toThrow('对不上');
  });

  it('字节数对得上、内容不一样：照样报错 —— 光比长度不够', async () => {
    const bytes = new Uint8Array([5, 6, 7]);
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([5, 6, 8]), { status: 200 }));
    await expect(audio.downloadAudio({ sha256: await hashOf(bytes), bytes: 3 })).rejects.toThrow('对不上');
  });

  it('下载也带令牌 —— 服务器上的音频只有本人读得到', async () => {
    const bytes = new Uint8Array([1]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const sha256 = await hashOf(bytes);
    await audio.downloadAudio({ sha256, bytes: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/audio/${sha256}`);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('没登录：不发请求，直接 SyncAuthError', async () => {
    getSessionToken.mockResolvedValue(undefined);
    await expect(audio.downloadAudio({ sha256: 'a'.repeat(64), bytes: 1 })).rejects.toBeInstanceOf(SyncAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('服务器上没有：404 报出来', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: '服务器上没有这份音频' }), { status: 404 }));
    await expect(audio.downloadAudio({ sha256: 'a'.repeat(64), bytes: 1 })).rejects.toThrow('服务器上没有这份音频');
  });
});

describe('uploadPendingAudio', () => {
  it('只传「手动课 + 本机有音频 + 没传过这一份」的；传完写回 audioRef', async () => {
    const saveAudioRef = vi.fn(async () => {});
    audio.registerAudioUploadDeps({ saveAudioRef });
    const a = new Uint8Array([1, 1]);
    const b = new Uint8Array([2, 2, 2]);
    lessons.push(
      lesson('todo'),
      lesson('done', { audioRef: { sha256: 'x'.repeat(64), bytes: 3 } }),
      lesson('changed', { audioRef: { sha256: 'y'.repeat(64), bytes: 99 } }), // 记着的不是本机这一份
      lesson('dw', { source: { type: 'dw', dwLessonId: '1', sourceUrl: '' } }),
      lesson('noaudio'),
    );
    cached('todo', a);
    cached('done', b);
    cached('changed', b);
    cached('dw', a);
    fetchMock.mockImplementation(async (_url, init) => new Response(null, { status: init?.method === 'HEAD' ? 404 : 201 }));

    expect(await audio.uploadPendingAudio()).toBe(2);
    expect(saveAudioRef.mock.calls).toEqual([
      ['todo', { sha256: await hashOf(a), bytes: 2 }],
      ['changed', { sha256: await hashOf(b), bytes: 3 }],
    ]);
  });

  it('登录过期：整趟停下，不对后面每一课都撞一次', async () => {
    audio.registerAudioUploadDeps({ saveAudioRef: vi.fn(async () => {}) });
    lessons.push(lesson('a'), lesson('b'));
    cached('a', new Uint8Array([1]));
    cached('b', new Uint8Array([2]));
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    expect(await audio.uploadPendingAudio()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('服务器没开音频存储（503）：这次停下，本次会话也不再试', async () => {
    audio.registerAudioUploadDeps({ saveAudioRef: vi.fn(async () => {}) });
    lessons.push(lesson('a'), lesson('b'));
    cached('a', new Uint8Array([1]));
    cached('b', new Uint8Array([2]));
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    await audio.uploadPendingAudio();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await audio.uploadPendingAudio();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('一课失败（别的错）只跳过它，后面的照传', async () => {
    const saveAudioRef = vi.fn(async () => {});
    audio.registerAudioUploadDeps({ saveAudioRef });
    lessons.push(lesson('a'), lesson('b'));
    cached('a', new Uint8Array([1]));
    cached('b', new Uint8Array([2]));
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '坏了' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await audio.uploadPendingAudio()).toBe(1);
    expect(saveAudioRef).toHaveBeenCalledWith('b', expect.anything());
  });

  it('没登录：什么都不做', async () => {
    audio.registerAudioUploadDeps({ saveAudioRef: vi.fn(async () => {}) });
    getSessionToken.mockResolvedValue(undefined);
    lessons.push(lesson('a'));
    cached('a', new Uint8Array([1]));
    expect(await audio.uploadPendingAudio()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('同一时间只跑一趟：并发调两次拿到的是同一个 promise', async () => {
    audio.registerAudioUploadDeps({ saveAudioRef: vi.fn(async () => {}) });
    const first = audio.uploadPendingAudio();
    expect(audio.uploadPendingAudio()).toBe(first);
    await first;
  });

  it('上一趟因登录过期停下之后，下一趟照常重扫 —— 单飞锁不能把自己锁死', async () => {
    const saveAudioRef = vi.fn(async () => {});
    audio.registerAudioUploadDeps({ saveAudioRef });
    lessons.push(lesson('a'));
    cached('a', new Uint8Array([1]));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await audio.uploadPendingAudio()).toBe(0);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await audio.uploadPendingAudio()).toBe(1);
    expect(saveAudioRef).toHaveBeenCalledWith('a', expect.anything());
  });

  it('写回 audioRef 失败：这一课算没传，下一趟还会扫到它', async () => {
    const saveAudioRef = vi.fn(async () => {}).mockRejectedValueOnce(new Error('写库失败'));
    audio.registerAudioUploadDeps({ saveAudioRef });
    lessons.push(lesson('a'));
    cached('a', new Uint8Array([1]));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await audio.uploadPendingAudio()).toBe(0);
    expect(await audio.uploadPendingAudio()).toBe(1);
  });

  it('缓存表说有音频、却读不出来：跳过这一课，不发请求也不报错', async () => {
    const saveAudioRef = vi.fn(async () => {});
    audio.registerAudioUploadDeps({ saveAudioRef });
    lessons.push(lesson('gone'), lesson('b'));
    caches.push({ lessonId: 'gone', hasAudio: true, audioBytes: 5, fetchedAt: 0 });
    cached('b', new Uint8Array([2]));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await audio.uploadPendingAudio()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saveAudioRef).toHaveBeenCalledWith('b', expect.anything());
  });

  it('没注入 saveAudioRef（store 还没加载）：什么都不做 —— 传了也写不回去', async () => {
    lessons.push(lesson('a'));
    cached('a', new Uint8Array([1]));
    expect(await audio.uploadPendingAudio()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('从服务器下回来的那份（audioRef 与本机字节数一致）不再传回去', async () => {
    audio.registerAudioUploadDeps({ saveAudioRef: vi.fn(async () => {}) });
    const bytes = new Uint8Array([3, 3]);
    lessons.push(lesson('a', { audioRef: { sha256: await hashOf(bytes), bytes: 2 } }));
    cached('a', bytes);
    expect(await audio.lessonsNeedingUpload()).toEqual([]);
    expect(await audio.uploadPendingAudio()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('scheduleAudioUpload', () => {
  afterEach(() => vi.useRealTimers());

  it('几秒内调好几次（一次导几十课）只扫一趟，而且要等到最后一次之后', async () => {
    vi.useFakeTimers();
    audio.registerAudioUploadDeps({ saveAudioRef: vi.fn(async () => {}) });
    lessons.push(lesson('a'));
    cached('a', new Uint8Array([1]));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    audio.scheduleAudioUpload(3000);
    await vi.advanceTimersByTimeAsync(2000);
    audio.scheduleAudioUpload(3000);
    await vi.advanceTimersByTimeAsync(2000);
    audio.scheduleAudioUpload(3000);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('reset 之后排着的那一趟不再跑（测试之间不串）', async () => {
    vi.useFakeTimers();
    audio.registerAudioUploadDeps({ saveAudioRef: vi.fn(async () => {}) });
    lessons.push(lesson('a'));
    cached('a', new Uint8Array([1]));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    audio.scheduleAudioUpload(1000);
    audio.resetAudioSyncForTests();
    audio.registerAudioUploadDeps({ saveAudioRef: vi.fn(async () => {}) }); // 只验「计时器被清掉」，不靠 deps 被清
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('hasServerAudio', () => {
  it('手动课且有 audioRef 才算；DW 的课走它自己那条路', () => {
    expect(audio.hasServerAudio(lesson('a'))).toBe(false);
    expect(audio.hasServerAudio(lesson('a', { audioRef: { sha256: 'a'.repeat(64), bytes: 1 } }))).toBe(true);
    expect(
      audio.hasServerAudio(
        lesson('d', { source: { type: 'dw', dwLessonId: '1', sourceUrl: '' }, audioRef: { sha256: 'a'.repeat(64), bytes: 1 } }),
      ),
    ).toBe(false);
  });
});
