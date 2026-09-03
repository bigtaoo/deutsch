// 远端 provider 的两件事：**线缆格式**和**任务生命周期**。
//
// 线缆格式为什么要在客户端也钉一遍：服务端那份（server/src/align/wire.ts）有自己的单测，
// 但两份测试各自对着自己的实现，都过了也可能对不上。所以这里的 `frame()` 是**照文档
// 手写的第三份编码器** —— 它和服务端那份必须同时通过，格式才算真的定下来了。
//
// 任务生命周期里最要紧的是**「还在算」和「任务没了」不能混**：前者继续等，
// 后者要重新上传 7MB。混了的症状是手机上一个转圈永远不停。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_SYNC_API_BASE', 'https://sync.example.test');
vi.stubEnv('VITE_GOOGLE_WEB_CLIENT_ID', 'client-id');

const getSessionToken = vi.fn<() => Promise<string | undefined>>();
vi.mock('@/sync/session', () => ({
  getSessionToken: () => getSessionToken(),
}));

const { MMS_FA } = await import('./config');
const {
  computeRemoteEmissions,
  decodeMatrix,
  remoteEmissionsAvailable,
  resetRemoteEmissionsAvailability,
} = await import('./remoteEmissions');

const BASE = 'https://sync.example.test';

/** 照 server/src/align/wire.ts 的文档手写一份编码器。 */
function frame(header: Record<string, unknown>, values: number[]): ArrayBuffer {
  let text = JSON.stringify(header);
  while ((4 + text.length) % 4 !== 0) text += ' ';
  const json = new TextEncoder().encode(text);
  const payload = new Float32Array(values);
  const out = new Uint8Array(4 + json.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength, true);
  out.set(json, 4);
  out.set(new Uint8Array(payload.buffer), 4 + json.byteLength);
  return out.buffer;
}

function matrixResponse(header: Record<string, unknown>, values: number[]): Response {
  return new Response(frame(header, values), {
    status: 200,
    headers: { 'content-type': 'application/x-emission-matrix' },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 按「方法 + 路径」路由的 fetch 假件，并记下每一次调用。 */
function routeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.slice(BASE.length)}`;
    calls.push(key);
    const handler = routes[key] ?? routes[key.replace(/[0-9a-f-]{36}/, ':id')];
    if (!handler) throw new Error(`测试里没有为 ${key} 准备响应`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

const AUDIO = new Blob([new Uint8Array(64)], { type: 'audio/mpeg' });

beforeEach(() => {
  getSessionToken.mockResolvedValue('tok');
  resetRemoteEmissionsAvailability();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('能不能用', () => {
  it('登录了就能用 —— 这是个不发请求的判断（它挂在自动对齐的闸门上）', async () => {
    const { fetchMock } = routeFetch({});
    expect(await remoteEmissionsAvailable()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('没登录就不能用', async () => {
    getSessionToken.mockResolvedValue(undefined);
    expect(await remoteEmissionsAvailable()).toBe(false);
  });

  it('服务器说了「我不做对齐」之后就不再试 —— 否则每次导入都白跑一轮', async () => {
    routeFetch({
      'POST /v1/align/jobs': () => json(503, { code: 'align_off', error: '没开对齐' }),
    });
    await expect(computeRemoteEmissions(AUDIO, MMS_FA)).rejects.toThrow('没开对齐');
    expect(await remoteEmissionsAvailable()).toBe(false);
  });
});

describe('一次完整的对齐', () => {
  it('提交 → 轮询 → 取结果 → 得到矩阵（source 记着 origin）', async () => {
    const { calls } = routeFetch({
      'POST /v1/align/jobs': () => json(202, { id: 'job-1', status: 'running' }),
      'GET /v1/align/jobs/job-1': () => json(200, { id: 'job-1', status: 'done' }),
      'GET /v1/align/jobs/job-1/result': () =>
        matrixResponse(
          { frames: 2, vocabSize: MMS_FA.vocabSize, duration: 0.04 },
          new Array(2 * MMS_FA.vocabSize).fill(-1.25),
        ),
    });

    const matrix = await computeRemoteEmissions(AUDIO, MMS_FA);
    expect(matrix.frames).toBe(2);
    expect(matrix.vocabSize).toBe(MMS_FA.vocabSize);
    expect(matrix.duration).toBeCloseTo(0.04);
    expect(matrix.logProbs[0]).toBeCloseTo(-1.25, 6);
    expect(matrix.source).toEqual({ kind: 'remote', origin: BASE });
    expect(calls).toEqual([
      'POST /v1/align/jobs',
      'GET /v1/align/jobs/job-1',
      'GET /v1/align/jobs/job-1/result',
    ]);
  });

  it('上传时带上音频的 Content-Type 与 Bearer', async () => {
    const { fetchMock } = routeFetch({
      'POST /v1/align/jobs': () => json(202, { id: 'j', status: 'running' }),
      'GET /v1/align/jobs/j': () => json(200, { id: 'j', status: 'done' }),
      'GET /v1/align/jobs/j/result': () =>
        matrixResponse({ frames: 1, vocabSize: MMS_FA.vocabSize, duration: 0.02 }, new Array(MMS_FA.vocabSize).fill(0)),
    });
    await computeRemoteEmissions(AUDIO, MMS_FA);
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('audio/mpeg');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.body).toBe(AUDIO);
  });

  it('排队和识别中的进度都报出来，且带 where=remote 之前的原始阶段', async () => {
    vi.useFakeTimers();
    let polls = 0;
    routeFetch({
      'POST /v1/align/jobs': () => json(202, { id: 'j', status: 'queued' }),
      'GET /v1/align/jobs/j': () => {
        polls++;
        if (polls === 1) return json(200, { id: 'j', status: 'queued', queuePosition: 1 });
        if (polls === 2) return json(200, { id: 'j', status: 'running', stage: 'infer', chunk: 9, chunks: 27 });
        return json(200, { id: 'j', status: 'done' });
      },
      'GET /v1/align/jobs/j/result': () =>
        matrixResponse({ frames: 1, vocabSize: MMS_FA.vocabSize, duration: 0.02 }, new Array(MMS_FA.vocabSize).fill(0)),
    });

    const seen: string[] = [];
    const promise = computeRemoteEmissions(AUDIO, MMS_FA, {
      onProgress: (p) => seen.push(`${p.stage}:${p.chunk ?? '-'}/${p.chunks ?? '-'}`),
    });
    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    // 上传那一下报 decode（界面上说「上传音频到服务器」），排队报 model，
    // 之后是服务器上的 infer + 块号。
    expect(seen[0]).toBe('decode:-/-');
    expect(seen).toContain('model:-/-');
    expect(seen).toContain('infer:9/27');
  });
});

describe('出错与取消', () => {
  it('轮询到 404 = 任务没了：报错要说清「要重新提交」，不能让人一直等', async () => {
    routeFetch({
      'POST /v1/align/jobs': () => json(202, { id: 'j', status: 'running' }),
      'GET /v1/align/jobs/j': () => json(404, { error: '没有这个对齐任务' }),
      'DELETE /v1/align/jobs/j': () => json(200, { cancelled: true }),
    });
    await expect(computeRemoteEmissions(AUDIO, MMS_FA)).rejects.toThrow('重新提交');
  });

  it('服务器算挂了：把它的原因原样抛出来', async () => {
    routeFetch({
      'POST /v1/align/jobs': () => json(202, { id: 'j', status: 'running' }),
      'GET /v1/align/jobs/j': () => json(200, { id: 'j', status: 'error', error: 'ffmpeg 退出码 1' }),
      'DELETE /v1/align/jobs/j': () => json(200, { cancelled: true }),
    });
    await expect(computeRemoteEmissions(AUDIO, MMS_FA)).rejects.toThrow('ffmpeg 退出码 1');
  });

  it('出错时顺手 DELETE 掉服务器上那个任务 —— 别让它白算完', async () => {
    const { calls } = routeFetch({
      'POST /v1/align/jobs': () => json(202, { id: 'j', status: 'running' }),
      'GET /v1/align/jobs/j': () => json(200, { id: 'j', status: 'error', error: '炸了' }),
      'DELETE /v1/align/jobs/j': () => json(200, { cancelled: true }),
    });
    await expect(computeRemoteEmissions(AUDIO, MMS_FA)).rejects.toThrow();
    await Promise.resolve();
    expect(calls).toContain('DELETE /v1/align/jobs/j');
  });

  it('没登录时压根不发请求', async () => {
    getSessionToken.mockResolvedValue(undefined);
    const { fetchMock } = routeFetch({});
    await expect(computeRemoteEmissions(AUDIO, MMS_FA)).rejects.toThrow('尚未登录');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('decodeMatrix（线缆格式）', () => {
  it('照文档手写的编码器编出来的东西能解开 —— 两边格式对得上', () => {
    const values = [-0.5, -1.5, -2.5, -3.5];
    const buffer = frame({ frames: 2, vocabSize: 2, duration: 0.04 }, values);
    const matrix = decodeMatrix(buffer, { ...MMS_FA, vocabSize: 2 });
    expect(Array.from(matrix.logProbs)).toEqual(values);
    expect(matrix.frames).toBe(2);
  });

  it('词表大小对不上就当场炸 —— 按错的列数读会得到「看起来正常」的错时间戳', () => {
    const buffer = frame({ frames: 1, vocabSize: 7, duration: 0.02 }, [0, 0, 0, 0, 0, 0, 0]);
    expect(() => decodeMatrix(buffer, MMS_FA)).toThrow('词表大小');
  });

  it('负载被截断就当场炸 —— 短了的矩阵会让后半课的时间戳静默落在均匀分布上', () => {
    const buffer = frame({ frames: 10, vocabSize: 2, duration: 0.2 }, [0, 0]);
    expect(() => decodeMatrix(buffer, { ...MMS_FA, vocabSize: 2 })).toThrow('长度对不上');
  });

  it('头部长度不是 4 的倍数（对不上补齐约定）也当场炸，而不是抛一个看不懂的 RangeError', () => {
    const bad = new Uint8Array(16);
    new DataView(bad.buffer).setUint32(0, 5, true); // 4 + 5 = 9，不是 4 的倍数
    expect(() => decodeMatrix(bad.buffer, MMS_FA)).toThrow('格式对不上');
  });

  it('空响应也不会解出一个空矩阵', () => {
    expect(() => decodeMatrix(new ArrayBuffer(2), MMS_FA)).toThrow('空的');
  });
});
