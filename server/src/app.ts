// HTTP 层。所有依赖（存储、配置、Google 校验器）都从外面注入，
// 于是测试可以拿一个内存库 + 假校验器把整套路由跑完，不需要网络、不需要端口。

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Store } from './db.ts';
import type { Config } from './config.ts';
import { type GoogleVerifier, GoogleTokenError } from './googleToken.ts';
import { signSession, verifySession } from './session.ts';

/** 文档 id 直接进 URL 路径，字符集收紧到「课程 id 用得到的那些」。 */
const DOC_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 登录接口的粗粒度限流：同一 IP 每小时最多试这么多次。 */
const AUTH_ATTEMPTS_PER_HOUR = 30;

export interface AppDeps {
  store: Store;
  config: Config;
  verifyGoogleIdToken: GoogleVerifier;
  /** 测试里可以拨快时钟。 */
  now?: () => number;
}

interface Variables {
  userId: string;
}

function createRateLimiter(limit: number, windowMs: number, now: () => number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

export function createApp(deps: AppDeps): Hono<{ Variables: Variables }> {
  const { store, config, verifyGoogleIdToken } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono<{ Variables: Variables }>();
  const allowAuthAttempt = createRateLimiter(AUTH_ATTEMPTS_PER_HOUR, 3_600_000, now);

  app.use(
    '/v1/*',
    cors({
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86_400,
    }),
  );

  app.get('/v1/healthz', (c) => c.json({ ok: true, ...store.stats() }));

  // ── 登录 ──────────────────────────────────────────────────────────────
  app.post('/v1/auth/google', async (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!allowAuthAttempt(ip)) return c.json({ error: '登录尝试过于频繁，稍后再试' }, 429);

    const payload = await c.req.json().catch(() => null);
    const idToken =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>).idToken : null;
    if (typeof idToken !== 'string' || !idToken) return c.json({ error: '缺少 idToken' }, 400);

    let identity;
    try {
      identity = await verifyGoogleIdToken(idToken);
    } catch (err) {
      if (err instanceof GoogleTokenError) return c.json({ error: err.message }, 401);
      throw err;
    }

    if (!config.allowedEmails.includes(identity.email)) {
      // 明确说清楚是白名单挡的 —— 否则会以为是自己 Google 账号有问题，去查一小时。
      return c.json({ error: identity.email + ' 不在这台服务器的白名单里' }, 403);
    }

    store.upsertUser({
      id: identity.sub,
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
    });
    const { token, expiresAt } = await signSession(
      config.sessionSecret,
      identity.sub,
      config.sessionTtlDays,
    );
    return c.json({
      token,
      expiresAt,
      account: { email: identity.email, name: identity.name, picture: identity.picture },
    });
  });

  // ── 之后所有 /v1 接口都要会话令牌 ──────────────────────────────────────
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/healthz' || c.req.path === '/v1/auth/google') return next();

    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return c.json({ error: '缺少 Authorization: Bearer' }, 401);

    let userId: string;
    try {
      userId = await verifySession(config.sessionSecret, token);
    } catch {
      return c.json({ error: '会话已过期，请重新登录' }, 401);
    }

    // 令牌有效但用户已被移出白名单 / 从库里删掉：一样拒绝。
    const user = store.getUser(userId);
    if (!user || !config.allowedEmails.includes(user.email)) {
      return c.json({ error: '这个账号已不再被允许访问', code: 'revoked' }, 401);
    }

    c.set('userId', userId);
    return next();
  });

  app.get('/v1/me', (c) => {
    const user = store.getUser(c.get('userId'))!;
    return c.json({ account: { email: user.email, name: user.name, picture: user.picture } });
  });

  // ── 文档 ──────────────────────────────────────────────────────────────
  app.get('/v1/docs', (c) => c.json({ docs: store.listDocs(c.get('userId')) }));

  app.get('/v1/docs/:id', (c) => {
    const docId = c.req.param('id');
    if (!DOC_ID_RE.test(docId)) return c.json({ error: '非法的文档 id' }, 400);
    const doc = store.getDoc(c.get('userId'), docId);
    if (!doc) return c.json({ error: '文档不存在' }, 404);
    return c.json({
      id: doc.id,
      version: doc.version,
      updatedAt: doc.updatedAt,
      body: JSON.parse(doc.body),
    });
  });

  app.put('/v1/docs/:id', async (c) => {
    const docId = c.req.param('id');
    if (!DOC_ID_RE.test(docId)) return c.json({ error: '非法的文档 id' }, 400);

    const payload = await c.req.json().catch(() => null);
    if (!payload || typeof payload !== 'object') return c.json({ error: '请求体必须是 JSON 对象' }, 400);
    const { baseVersion, body } = payload as { baseVersion?: unknown; body?: unknown };
    if (baseVersion !== null && typeof baseVersion !== 'number') {
      return c.json({ error: 'baseVersion 必须是数字或 null' }, 400);
    }
    if (body === undefined) return c.json({ error: '缺少 body' }, 400);

    const serialized = JSON.stringify(body);
    if (serialized.length > config.maxDocBytes) {
      return c.json({ error: '文档超过 ' + config.maxDocBytes + ' 字节上限' }, 413);
    }

    const userId = c.get('userId');
    const result = store.putDoc(userId, docId, baseVersion ?? null, serialized);
    if (!result.ok) {
      // 409 里直接把远端现值带回去，客户端拿它跑 §2.4 合并再重推，省一次往返。
      return c.json(
        {
          error: '版本冲突',
          code: 'conflict',
          version: result.conflict.version,
          updatedAt: result.conflict.updatedAt,
          body: JSON.parse(result.conflict.body),
        },
        409,
      );
    }
    store.pruneRevisions(userId, docId, config.revisionsPerDoc);
    return c.json({ id: docId, version: result.version, updatedAt: result.updatedAt });
  });

  app.delete('/v1/docs/:id', (c) => {
    const docId = c.req.param('id');
    if (!DOC_ID_RE.test(docId)) return c.json({ error: '非法的文档 id' }, 400);
    const deleted = store.deleteDoc(c.get('userId'), docId);
    return c.json({ deleted });
  });

  // ── 历史版本（GitHub 方案里「git 历史可回滚」的替代物）────────────────
  app.get('/v1/docs/:id/revisions', (c) => {
    const docId = c.req.param('id');
    if (!DOC_ID_RE.test(docId)) return c.json({ error: '非法的文档 id' }, 400);
    return c.json({ revisions: store.listRevisions(c.get('userId'), docId) });
  });

  app.get('/v1/docs/:id/revisions/:version', (c) => {
    const docId = c.req.param('id');
    const version = Number(c.req.param('version'));
    if (!DOC_ID_RE.test(docId)) return c.json({ error: '非法的文档 id' }, 400);
    if (!Number.isInteger(version)) return c.json({ error: '非法的版本号' }, 400);
    const rev = store.getRevision(c.get('userId'), docId, version);
    if (!rev) return c.json({ error: '没有这个历史版本' }, 404);
    return c.json({ id: rev.id, version: rev.version, updatedAt: rev.updatedAt, body: JSON.parse(rev.body) });
  });

  return app;
}
