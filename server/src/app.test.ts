import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApp } from './app.ts';
import { Store } from './db.ts';
import { GoogleTokenError, type GoogleVerifier } from './googleToken.ts';
import type { Config } from './config.ts';
import { signSession } from './session.ts';
import type { AiExplainer } from './ai.ts';

const SECRET = new TextEncoder().encode('0123456789abcdef0123456789abcdef');

const config: Config = {
  port: 0,
  dataDir: ':memory:',
  googleClientIds: ['client-id'],
  allowedEmails: ['tao@example.com'],
  sessionSecret: SECRET,
  sessionTtlDays: 90,
  allowedOrigins: ['https://d.gamestao.com'],
  maxDocBytes: 1000,
  revisionsPerDoc: 3,
  align: {
    enabled: true,
    modelDir: ':memory:',
    idleMs: 0,
    serveWeights: false,
    dtype: 'q4',
    threads: 1,
    maxAudioBytes: 1024,
    maxSeconds: 60,
    maxQueued: 2,
    resultTtlMs: 60_000,
  },
  ai: {
    model: 'claude-haiku-4-5-20251001',
  },
};

/** 假校验器：token 就是邮箱本身，前缀 bad- 表示一张伪造的票。 */
const verifyGoogleIdToken: GoogleVerifier = async (idToken) => {
  if (idToken.startsWith('bad-')) throw new GoogleTokenError('签名对不上');
  return { sub: 'sub-' + idToken, email: idToken, name: 'Tao', picture: null };
};

/** 内存版收件箱 —— 路由测试不该碰真盘（文件那一份自己在 diag.test.ts 里测）。 */
function memoryDiag() {
  const saved = new Map<string, string>();
  return {
    sink: {
      save(userId: string, report: unknown) {
        const id = `${Date.now()}-abc123`;
        saved.set(`${userId}/${id}`, JSON.stringify(report));
        return { id, at: Date.now(), bytes: 1 };
      },
      list: (userId: string) =>
        [...saved.keys()]
          .filter((k) => k.startsWith(userId + '/'))
          .map((k) => ({ id: k.split('/')[1], at: 1, bytes: 1 })),
      get: (userId: string, id: string) => saved.get(`${userId}/${id}`) ?? null,
    },
    saved,
  };
}

function setup(overrides: { ai?: AiExplainer; diag?: ReturnType<typeof memoryDiag>['sink'] } = {}) {
  const store = new Store(':memory:');
  const app = createApp({ store, config, verifyGoogleIdToken, ai: overrides.ai, diag: overrides.diag });
  return { store, app };
}

async function login(app: ReturnType<typeof setup>['app'], email = 'tao@example.com') {
  const res = await app.request('/v1/auth/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: email }),
  });
  const json = (await res.json()) as { token: string };
  return { res, token: json.token };
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  };
}

describe('登录', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('白名单里的账号拿得到会话令牌', async () => {
    const { res, token } = await login(ctx.app);
    expect(res.status).toBe(200);
    expect(token).toBeTruthy();
    expect(ctx.store.stats().users).toBe(1);
  });

  it('伪造的 ID token → 401，且不建用户', async () => {
    const res = await ctx.app.request('/v1/auth/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'bad-token' }),
    });
    expect(res.status).toBe(401);
    expect(ctx.store.stats().users).toBe(0);
  });

  it('Google 认了但不在白名单 → 403', async () => {
    const { res } = await login(ctx.app, 'stranger@example.com');
    expect(res.status).toBe(403);
    expect(ctx.store.stats().users).toBe(0);
  });

  it('缺 idToken → 400', async () => {
    const res = await ctx.app.request('/v1/auth/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('鉴权', () => {
  it('没有 Authorization 头一律 401', async () => {
    const { app } = setup();
    for (const path of ['/v1/me', '/v1/docs', '/v1/docs/vocab']) {
      expect((await app.request(path)).status).toBe(401);
    }
  });

  it('/v1/healthz 不需要登录', async () => {
    const { app } = setup();
    const res = await app.request('/v1/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('签名对但用户已被移出白名单 → 401 revoked', async () => {
    const { app, store } = setup();
    store.upsertUser({ id: 'ghost', email: 'gone@example.com', name: null, picture: null });
    const { token } = await signSession(SECRET, 'ghost', 1);
    const res = await app.request('/v1/me', authed(token));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'revoked' });
  });

  it('别的密钥签出来的令牌不认', async () => {
    const { app } = setup();
    const other = new TextEncoder().encode('ffffffffffffffffffffffffffffffff');
    const { token } = await signSession(other, 'sub-tao@example.com', 1);
    expect((await app.request('/v1/me', authed(token))).status).toBe(401);
  });
});

describe('文档读写', () => {
  let ctx: ReturnType<typeof setup>;
  let token: string;

  beforeEach(async () => {
    ctx = setup();
    ({ token } = await login(ctx.app));
  });

  const put = (id: string, baseVersion: number | null, body: unknown) =>
    ctx.app.request('/v1/docs/' + id, authed(token, { method: 'PUT', body: JSON.stringify({ baseVersion, body }) }));

  it('新建 → 读回 → 覆盖', async () => {
    expect((await put('vocab', null, [{ id: 'w1' }])).status).toBe(200);

    const read = await ctx.app.request('/v1/docs/vocab', authed(token));
    expect(await read.json()).toMatchObject({ version: 1, body: [{ id: 'w1' }] });

    const second = await put('vocab', 1, [{ id: 'w2' }]);
    expect(await second.json()).toMatchObject({ version: 2 });
  });

  it('版本对不上 → 409，并带回远端现值供合并', async () => {
    await put('vocab', null, ['远端']);
    const res = await put('vocab', null, ['本地']);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'conflict', version: 1, body: ['远端'] });
  });

  it('列表列出全部文档', async () => {
    await put('vocab', null, []);
    await put('lesson:abc', null, { id: 'abc' });
    const res = await ctx.app.request('/v1/docs', authed(token));
    const { docs } = (await res.json()) as { docs: { id: string }[] };
    expect(docs.map((d) => d.id).sort()).toEqual(['lesson:abc', 'vocab']);
  });

  it('不存在的文档 → 404', async () => {
    expect((await ctx.app.request('/v1/docs/nope', authed(token))).status).toBe(404);
  });

  it('非法 id → 400（路径穿越、超长都挡在这里）', async () => {
    const res = await ctx.app.request('/v1/docs/' + encodeURIComponent('../etc/passwd'), authed(token));
    expect(res.status).toBe(400);
  });

  it('超过体积上限 → 413', async () => {
    const res = await put('vocab', null, ['x'.repeat(2000)]);
    expect(res.status).toBe(413);
  });

  it('删除后读不到，但历史还在', async () => {
    await put('lesson:abc', null, { id: 'abc' });
    const del = await ctx.app.request('/v1/docs/lesson:abc', authed(token, { method: 'DELETE' }));
    expect(await del.json()).toEqual({ deleted: true });
    expect((await ctx.app.request('/v1/docs/lesson:abc', authed(token))).status).toBe(404);
    const rev = await ctx.app.request('/v1/docs/lesson:abc/revisions/1', authed(token));
    expect(await rev.json()).toMatchObject({ body: { id: 'abc' } });
  });

  it('历史版本按配置修剪', async () => {
    await put('vocab', null, [0]);
    for (let v = 1; v <= 6; v += 1) await put('vocab', v, [v]);
    const res = await ctx.app.request('/v1/docs/vocab/revisions', authed(token));
    const { revisions } = (await res.json()) as { revisions: { version: number }[] };
    expect(revisions.map((r) => r.version)).toEqual([6, 5, 4]);
  });

  it('看不到别人的文档', async () => {
    await put('vocab', null, ['我的']);
    const otherConfig = { ...config, allowedEmails: [...config.allowedEmails, 'b@example.com'] };
    const app2 = createApp({ store: ctx.store, config: otherConfig, verifyGoogleIdToken });
    const { token: token2 } = await login(app2, 'b@example.com');
    expect((await app2.request('/v1/docs/vocab', authed(token2))).status).toBe(404);
  });
});

describe('AI 补充解释', () => {
  it('没配 ANTHROPIC_API_KEY（deps.ai 缺席）→ 503 code=ai_off', async () => {
    const { app } = setup();
    const { token } = await login(app);
    const res = await app.request('/v1/ai/explain', authed(token, { method: 'POST', body: JSON.stringify({ word: 'Zug' }) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'ai_off' });
  });

  it('要登录 —— 和别的 /v1 接口同一道中间件', async () => {
    const { app } = setup({ ai: { explain: async () => '解释' } });
    const res = await app.request('/v1/ai/explain', { method: 'POST', body: JSON.stringify({ word: 'Zug' }) });
    expect(res.status).toBe(401);
  });

  it('缺 word → 400，不去问模型', async () => {
    const explain = vi.fn();
    const { app } = setup({ ai: { explain } });
    const { token } = await login(app);
    const res = await app.request('/v1/ai/explain', authed(token, { method: 'POST', body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
    expect(explain).not.toHaveBeenCalled();
  });

  it('word 原样传给 explainer，context/existing 有给就传、没给就是 undefined', async () => {
    const explain = vi.fn().mockResolvedValue('这是解释');
    const { app } = setup({ ai: { explain } });
    const { token } = await login(app);

    const res = await app.request(
      '/v1/ai/explain',
      authed(token, { method: 'POST', body: JSON.stringify({ word: ' Zug ', context: '原句', existing: '词典释义' }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ note: '这是解释' });
    expect(explain).toHaveBeenCalledWith({ word: 'Zug', context: '原句', existing: '词典释义' });

    await app.request('/v1/ai/explain', authed(token, { method: 'POST', body: JSON.stringify({ word: 'nur' }) }));
    expect(explain).toHaveBeenLastCalledWith({ word: 'nur', context: undefined, existing: undefined });
  });

  it('上游调用失败 → 502 code=ai_failed，把 explainer 抛出的话原样带回去', async () => {
    const { app } = setup({ ai: { explain: async () => { throw new Error('AI 接口返回 HTTP 429'); } } });
    const { token } = await login(app);
    const res = await app.request('/v1/ai/explain', authed(token, { method: 'POST', body: JSON.stringify({ word: 'Zug' }) }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'ai_failed', error: 'AI 接口返回 HTTP 429' });
  });
});

describe('CORS', () => {
  it('白名单里的 origin 拿得到放行头，别的拿不到', async () => {
    const { app } = setup();
    const ok = await app.request('/v1/healthz', { headers: { origin: 'https://d.gamestao.com' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://d.gamestao.com');

    const bad = await app.request('/v1/healthz', { headers: { origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// ── 设备诊断（变更 56）─────────────────────────────────────────────────
// 存在的理由：iPhone 上热更停摆，而开发机是 Windows——没有 Mac、没有 Xcode 控制台，
// 手机内部发生了什么一个字都看不到。这一组守的是「点一下就能发过来」这条路本身。
describe('/v1/diag', () => {
  it('登录之后能把报告发进来，回一个 id', async () => {
    const diag = memoryDiag();
    const { app } = setup({ diag: diag.sink });
    const { token } = await login(app);
    const res = await app.request(
      '/v1/diag',
      authed(token, { method: 'POST', body: JSON.stringify({ schema: 1, platform: 'ios' }) }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { id: string }).toHaveProperty('id');
    expect([...diag.saved.values()][0]).toContain('"platform":"ios"');
  });

  it('没登录就发不进来 —— 这是一个往盘上写文件的接口', async () => {
    const { app } = setup({ diag: memoryDiag().sink });
    const res = await app.request('/v1/diag', {
      method: 'POST',
      body: JSON.stringify({ schema: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it('太大的报告拒掉 —— 几百 KB 已经很多了，再大就是客户端出了 bug', async () => {
    const { app } = setup({ diag: memoryDiag().sink });
    const { token } = await login(app);
    const res = await app.request(
      '/v1/diag',
      authed(token, { method: 'POST', body: JSON.stringify({ blob: 'x'.repeat(2_100_000) }) }),
    );
    expect(res.status).toBe(413);
  });

  it('不是合法 JSON 就回 400，不往盘上落半个文件', async () => {
    const diag = memoryDiag();
    const { app } = setup({ diag: diag.sink });
    const { token } = await login(app);
    const res = await app.request('/v1/diag', authed(token, { method: 'POST', body: '{not json' }));
    expect(res.status).toBe(400);
    expect(diag.saved.size).toBe(0);
  });

  it('列表与取回只看得到自己的那些', async () => {
    const diag = memoryDiag();
    const { app } = setup({ diag: diag.sink });
    const { token } = await login(app);
    const posted = await app.request(
      '/v1/diag',
      authed(token, { method: 'POST', body: JSON.stringify({ schema: 1 }) }),
    );
    const { id } = (await posted.json()) as { id: string };
    const list = (await (await app.request('/v1/diag', authed(token))).json()) as {
      reports: { id: string }[];
    };
    expect(list.reports.map((r) => r.id)).toContain(id);
    const one = await app.request('/v1/diag/' + id, authed(token));
    expect(one.status).toBe(200);
    expect((await one.json()) as { schema: number }).toEqual({ schema: 1 });
  });

  // 整块可缺席：没给收件箱时说清楚，手机上退回「复制诊断」那条路。
  it('这台服务器没开收件箱时回 503，不是 404', async () => {
    const { app } = setup();
    const { token } = await login(app);
    const res = await app.request('/v1/diag', authed(token, { method: 'POST', body: '{}' }));
    expect(res.status).toBe(503);
  });
});
