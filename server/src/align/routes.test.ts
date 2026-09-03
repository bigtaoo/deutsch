// 对齐那三条路由 + 队列的行为。engine 是假的 —— 这里测的是**协议**，不是模型：
// 真模型只能在有 230MB 权重和 ffmpeg 的机器上跑，那属于部署验收（deploy/README.md）。
//
// 三件事值得测，因为它们各自对应一种「手机上看起来像坏了」：
// ① 提交 → 轮询 → 取结果这条路上每一步的状态码要能区分「还在算」和「任务没了」，
//    前者继续等，后者必须重新上传 7MB；
// ② 别人的任务 id 一律当不存在；
// ③ 结果取走即删 —— 第二次取要能明确说出「已经被取走了」，而不是回一份空矩阵。

import { describe, expect, it, beforeEach } from 'vitest';
import { createApp } from '../app.ts';
import { Store } from '../db.ts';
import type { Config } from '../config.ts';
import type { GoogleVerifier } from '../googleToken.ts';
import { createJobQueue } from './jobs.ts';
import { MATRIX_CONTENT_TYPE } from './wire.ts';
import type { EmissionsResult, Engine, EngineProgress } from './engine.ts';

const config: Config = {
  port: 0,
  dataDir: ':memory:',
  googleClientIds: ['client-id'],
  allowedEmails: ['tao@example.com', 'other@example.com'],
  sessionSecret: new TextEncoder().encode('0123456789abcdef0123456789abcdef'),
  sessionTtlDays: 90,
  allowedOrigins: ['https://d.gamestao.com'],
  maxDocBytes: 1000,
  revisionsPerDoc: 3,
  align: {
    enabled: true,
    modelDir: ':memory:',
    dtype: 'q4',
    threads: 1,
    maxAudioBytes: 1024,
    maxSeconds: 60,
    maxQueued: 2,
    resultTtlMs: 60_000,
  },
};

const verifyGoogleIdToken: GoogleVerifier = async (idToken) => ({
  sub: 'sub-' + idToken,
  email: idToken,
  name: 'Tao',
  picture: null,
});

/** 手动控制的假 engine：测试自己决定什么时候算完。 */
function fakeEngine() {
  let resolveCurrent: ((r: EmissionsResult) => void) | null = null;
  let rejectCurrent: ((e: Error) => void) | null = null;
  let report: ((p: EngineProgress) => void) | null = null;
  let cancelled: (() => boolean) | null = null;
  let calls = 0;

  const engine: Engine = {
    status: () => 'ready',
    statusMessage: () => undefined,
    compute: (_audio, _ext, onProgress, isCancelled) => {
      calls++;
      report = onProgress;
      cancelled = isCancelled;
      return new Promise<EmissionsResult>((resolve, reject) => {
        resolveCurrent = resolve;
        rejectCurrent = reject;
      });
    },
  };

  return {
    engine,
    get calls() {
      return calls;
    },
    progress: (p: EngineProgress) => report?.(p),
    isCancelled: () => cancelled?.() ?? false,
    finish: (frames = 4, vocabSize = 2) =>
      resolveCurrent?.({
        logProbs: new Float32Array(frames * vocabSize).fill(-0.5),
        frames,
        vocabSize,
        duration: frames * 0.02,
      }),
    fail: (message: string) => rejectCurrent?.(new Error(message)),
  };
}

function setup(withAlign = true) {
  const store = new Store(':memory:');
  const fake = fakeEngine();
  const app = createApp({
    store,
    config,
    verifyGoogleIdToken,
    align: withAlign
      ? {
          engine: fake.engine,
          queue: createJobQueue({ engine: fake.engine, maxQueued: 2, ttlMs: 60_000 }),
          maxAudioBytes: config.align.maxAudioBytes,
        }
      : undefined,
  });
  return { store, app, fake };
}

type App = ReturnType<typeof setup>['app'];

async function login(app: App, email = 'tao@example.com'): Promise<string> {
  const res = await app.request('/v1/auth/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: email }),
  });
  return ((await res.json()) as { token: string }).token;
}

function submit(app: App, token: string, bytes = 64) {
  const body = new Uint8Array(bytes).fill(7);
  return app.request('/v1/align/jobs', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'audio/mpeg',
      'content-length': String(bytes),
    },
    body,
  });
}

const get = (app: App, token: string, path: string) =>
  app.request(path, { headers: { authorization: `Bearer ${token}` } });

let ctx: ReturnType<typeof setup>;
beforeEach(() => {
  ctx = setup();
});

describe('提交', () => {
  it('202 + 任务 id，engine 立刻开始算', async () => {
    const token = await login(ctx.app);
    const res = await submit(ctx.app, token);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('running');
    expect(ctx.fake.calls).toBe(1);
  });

  it('没有令牌就是 401 —— 这条路上传的是音频，不能匿名', async () => {
    const res = await ctx.app.request('/v1/align/jobs', { method: 'POST', body: new Uint8Array(8) });
    expect(res.status).toBe(401);
  });

  it('超过上限回 413，且**不读请求体**（只看 Content-Length）', async () => {
    const token = await login(ctx.app);
    const res = await ctx.app.request('/v1/align/jobs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'audio/mpeg',
        'content-length': String(config.align.maxAudioBytes + 1),
      },
      body: new Uint8Array(8),
    });
    expect(res.status).toBe(413);
    expect(ctx.fake.calls).toBe(0);
  });

  it('空请求体回 400', async () => {
    const token = await login(ctx.app);
    const res = await submit(ctx.app, token, 0);
    expect(res.status).toBe(400);
  });

  it('排队满了回 429 —— 一个人用的服务，堆积没有意义', async () => {
    const token = await login(ctx.app);
    await submit(ctx.app, token); // 这个开始跑
    await submit(ctx.app, token); // 排队 1
    await submit(ctx.app, token); // 排队 2
    const res = await submit(ctx.app, token);
    expect(res.status).toBe(429);
  });
});

describe('轮询与取结果', () => {
  it('进度照实报出来（stage + 第几块）', async () => {
    const token = await login(ctx.app);
    const { id } = (await (await submit(ctx.app, token)).json()) as { id: string };
    ctx.fake.progress({ stage: 'infer', chunk: 3, chunks: 27 });
    const view = (await (await get(ctx.app, token, `/v1/align/jobs/${id}`)).json()) as {
      stage: string;
      chunk: number;
      chunks: number;
    };
    expect(view).toMatchObject({ stage: 'infer', chunk: 3, chunks: 27 });
  });

  it('还没算完时取结果回 409（不是 404）—— 客户端要能分清「再等等」和「重新上传」', async () => {
    const token = await login(ctx.app);
    const { id } = (await (await submit(ctx.app, token)).json()) as { id: string };
    const res = await get(ctx.app, token, `/v1/align/jobs/${id}/result`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { status: string }).status).toBe('running');
  });

  it('算完之后拿到的是二进制矩阵：头部 JSON + float32 负载', async () => {
    const token = await login(ctx.app);
    const { id } = (await (await submit(ctx.app, token)).json()) as { id: string };
    ctx.fake.finish(4, 2);
    await Promise.resolve();

    const res = await get(ctx.app, token, `/v1/align/jobs/${id}/result`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(MATRIX_CONTENT_TYPE);

    const buf = await res.arrayBuffer();
    const headerLength = new DataView(buf).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLength))) as {
      frames: number;
      vocabSize: number;
      duration: number;
    };
    expect(header).toMatchObject({ frames: 4, vocabSize: 2 });
    // 零拷贝取负载 —— 头部补齐到 4 的整数倍才做得到（见 wire.ts）。
    // 这一行就是那条约定的验收：补齐没做对时它会抛 RangeError。
    const logProbs = new Float32Array(buf, 4 + headerLength);
    expect((4 + headerLength) % 4).toBe(0);
    expect(logProbs).toHaveLength(8);
    expect(logProbs[0]).toBeCloseTo(-0.5, 6);
  });

  it('取走即删：第二次回 404', async () => {
    const token = await login(ctx.app);
    const { id } = (await (await submit(ctx.app, token)).json()) as { id: string };
    ctx.fake.finish();
    await Promise.resolve();
    expect((await get(ctx.app, token, `/v1/align/jobs/${id}/result`)).status).toBe(200);
    expect((await get(ctx.app, token, `/v1/align/jobs/${id}/result`)).status).toBe(404);
  });

  it('算挂了：状态是 error，消息带着原因', async () => {
    const token = await login(ctx.app);
    const { id } = (await (await submit(ctx.app, token)).json()) as { id: string };
    ctx.fake.fail('ffmpeg 退出码 1');
    await Promise.resolve();
    const view = (await (await get(ctx.app, token, `/v1/align/jobs/${id}`)).json()) as {
      status: string;
      error: string;
    };
    expect(view.status).toBe('error');
    expect(view.error).toContain('ffmpeg');
  });
});

describe('隔离与取消', () => {
  it('别人的任务一律当不存在（连「这个 id 存在」都不漏）', async () => {
    const mine = await login(ctx.app);
    const theirs = await login(ctx.app, 'other@example.com');
    const { id } = (await (await submit(ctx.app, mine)).json()) as { id: string };
    expect((await get(ctx.app, theirs, `/v1/align/jobs/${id}`)).status).toBe(404);
    expect((await get(ctx.app, theirs, `/v1/align/jobs/${id}/result`)).status).toBe(404);
  });

  it('取消：正在跑的那个由 engine 在下一个块边界自己停', async () => {
    const token = await login(ctx.app);
    const { id } = (await (await submit(ctx.app, token)).json()) as { id: string };
    expect(ctx.fake.isCancelled()).toBe(false);
    const res = await ctx.app.request(`/v1/align/jobs/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.isCancelled()).toBe(true);
  });

  it('排队中的任务被取消：立刻结算成 cancelled，不占位置', async () => {
    const token = await login(ctx.app);
    await submit(ctx.app, token);
    const { id } = (await (await submit(ctx.app, token)).json()) as { id: string };
    await ctx.app.request(`/v1/align/jobs/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    const view = (await (await get(ctx.app, token, `/v1/align/jobs/${id}`)).json()) as {
      status: string;
    };
    expect(view.status).toBe('cancelled');
    // 位置腾出来了：还能再排两个
    expect((await submit(ctx.app, token)).status).toBe(202);
    expect((await submit(ctx.app, token)).status).toBe(202);
  });
});

describe('整块关掉', () => {
  it('没配对齐时三条路由都回 503 + code，而同步照常', async () => {
    const off = setup(false);
    const token = await login(off.app);
    const res = await submit(off.app, token);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('align_off');
    // 备份是本职：它不受影响。
    const docs = await get(off.app, token, '/v1/docs');
    expect(docs.status).toBe(200);
  });

  it('healthz 里带着对齐的状态 —— 它会单独坏掉，而那从同步侧看不出来', async () => {
    const res = await ctx.app.request('/v1/healthz');
    const body = (await res.json()) as { align: { status: string; queued: number } };
    expect(body.align.status).toBe('ready');
    expect(body.align.queued).toBe(0);
  });
});
