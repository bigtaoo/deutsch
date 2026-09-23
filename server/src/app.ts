// HTTP 层。所有依赖（存储、配置、Google 校验器）都从外面注入，
// 于是测试可以拿一个内存库 + 假校验器把整套路由跑完，不需要网络、不需要端口。

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Store } from './db.ts';
import type { Config } from './config.ts';
import { type GoogleVerifier, GoogleTokenError } from './googleToken.ts';
import { signSession, verifySession } from './session.ts';
import { extensionOf, type Engine } from './align/engine.ts';
import type { JobQueue } from './align/jobs.ts';
import { MATRIX_CONTENT_TYPE, encodeMatrix } from './align/wire.ts';
import { serveWeights } from './align/weights.ts';
import type { AiExplainer } from './ai.ts';
import type { DiagSink } from './diag.ts';

/** 文档 id 直接进 URL 路径，字符集收紧到「课程 id 用得到的那些」。 */
const DOC_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 一份设备诊断最多这么大。几百 KB 已经很多了 —— 见 POST /v1/diag。 */
const MAX_DIAG_BYTES = 2_000_000;

/** 登录接口的粗粒度限流：同一 IP 每小时最多试这么多次。 */
const AUTH_ATTEMPTS_PER_HOUR = 30;

export interface AppDeps {
  store: Store;
  config: Config;
  verifyGoogleIdToken: GoogleVerifier;
  /**
   * 对齐那一半（FR-15.17）。**可以整块缺席** —— 它是搭在备份服务上的第二个用途，
   * `onnxruntime-node` 装不上、或 `ALIGN_ENABLED=false` 时这里是 undefined，
   * 路由回 503 并说清原因，而同步照常工作。备份是本职，不能被它拖下水。
   */
  align?: { engine: Engine; queue: JobQueue; maxAudioBytes: number };
  /**
   * 权重站的根目录（`${DATA_DIR}/models`）。给了就开 `GET /v1/align/weights/**`。
   *
   * **它和 `align` 是分开的两件事**：关掉对齐（ALIGN_ENABLED=false）之后，
   * 这台服务器仍然可以只当权重站 —— 桌面浏览器那条路要靠它才拿得到权重。
   */
  weightsDir?: string;
  /**
   * AI 补充解释（FR-9.11 / FR-9.12）。**同样可以整块缺席**：`ANTHROPIC_API_KEY`
   * 没配时是 undefined，路由回 503，客户端退回「AI 服务暂时不可用」。
   */
  ai?: AiExplainer;
  /**
   * 设备诊断的收件箱（变更 56）。**同样可以整块缺席** —— 没给就回 503，
   * 手机上退回「复制诊断」那条路（它不依赖服务器，见 src/platform/bridgeDiag.ts）。
   */
  diag?: DiagSink;
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

  app.get('/v1/healthz', (c) =>
    c.json({
      ok: true,
      ...store.stats(),
      // 对齐那一半的状态也摆在这里：它会因为「权重下不下来」「ORT 装不上」而单独坏掉，
      // 而那种坏法从同步这一侧完全看不出来。
      align: deps.align
        ? {
            status: deps.align.engine.status(),
            message: deps.align.engine.statusMessage(),
            ...deps.align.queue.stats(),
          }
        : { status: 'off' },
    }),
  );

  // ── 登录 ──────────────────────────────────────────────────────────────
  // ── 权重站（不要求登录，见 align/weights.ts 顶部）──────────────────────
  // **必须注册在下面那道会话中间件之前**：Hono 按注册顺序组合处理器，
  // 这个处理器直接返回、不调 next()，鉴权那一层就不会跑到。
  if (deps.weightsDir) {
    const prefix = '/v1/align/weights/';
    app.get('/v1/align/weights/*', (c) =>
      serveWeights(deps.weightsDir!, c.req.path.slice(prefix.length), c.req.header('range')),
    );
  }

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

  // ── 对齐（FR-15.17：emissions 那一半挪到服务器上）────────────────────
  //
  // 上行 mp3、下行 log-prob 矩阵，**文稿一个字都不上来** —— 那道缝
  // （src/align/emissionMatrix.ts）就是为这一刻切的，CTC 前向压根不看文本。
  // 所以 §3.1 里关于德语正文的那一整套约束不受影响，要认的只有「音频经手」一条。
  const align = deps.align;
  /** 对齐整块缺席时的回复。`code` 让客户端能一次判定「这台服务器不提供对齐」并退回本地。 */
  const ALIGN_OFF = {
    error: '这台服务器没有开对齐（ALIGN_ENABLED=false，或 onnxruntime-node 没装上）',
    code: 'align_off',
  } as const;

  app.post('/v1/align/jobs', async (c) => {
    if (!align) return c.json(ALIGN_OFF, 503);
    // 先看 Content-Length：不看的话一次误传能让进程把整个请求体读进内存。
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > align.maxAudioBytes) {
      return c.json({ error: `音频超过 ${align.maxAudioBytes} 字节上限` }, 413);
    }
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) return c.json({ error: '请求体是空的' }, 400);
    if (body.byteLength > align.maxAudioBytes) {
      return c.json({ error: `音频超过 ${align.maxAudioBytes} 字节上限` }, 413);
    }

    const extension = extensionOf(c.req.header('content-type'));
    const submitted = align.queue.submit(c.get('userId'), body, extension);
    if ('error' in submitted) return c.json({ error: submitted.error }, 429);
    return c.json(align.queue.view(c.get('userId'), submitted.id), 202);
  });

  app.get('/v1/align/jobs/:id', (c) => {
    if (!align) return c.json(ALIGN_OFF, 503);
    const view = align.queue.view(c.get('userId'), c.req.param('id'));
    if (!view) return c.json({ error: '没有这个对齐任务（可能已过期）' }, 404);
    return c.json(view);
  });

  app.get('/v1/align/jobs/:id/result', (c) => {
    if (!align) return c.json(ALIGN_OFF, 503);
    const id = c.req.param('id');
    const view = align.queue.view(c.get('userId'), id);
    if (!view) return c.json({ error: '没有这个对齐任务（可能已过期）' }, 404);
    // 还没跑完时**不要**回 404：客户端要能分清「还在算」和「任务没了」，
    // 前者继续轮询，后者必须重新提交（而重新提交要再上传 7MB）。
    if (view.status !== 'done') return c.json(view, 409);

    const result = align.queue.takeResult(c.get('userId'), id);
    if (!result) return c.json({ error: '结果已经被取走了' }, 410);
    const bytes = encodeMatrix(
      { frames: result.frames, vocabSize: result.vocabSize, duration: result.duration },
      result.logProbs,
    );
    // `bytes.buffer` 而不是 `bytes`：Hono 的 body() 收 ArrayBuffer。
    // encodeMatrix 给的是一个刚好这么大的新数组，所以整份 buffer 就是它本身。
    return c.body(bytes.buffer as ArrayBuffer, 200, {
      'content-type': MATRIX_CONTENT_TYPE,
      'content-length': String(bytes.byteLength),
    });
  });

  app.delete('/v1/align/jobs/:id', (c) => {
    if (!align) return c.json(ALIGN_OFF, 503);
    const cancelled = align.queue.cancel(c.get('userId'), c.req.param('id'));
    if (!cancelled) return c.json({ error: '没有这个对齐任务' }, 404);
    return c.json({ cancelled: true });
  });

  // ── AI 补充解释（FR-9.11 / FR-9.12）──────────────────────────────────
  //
  // 查词面板与生词本页的「问 AI」共用这一个接口：两者要的都是「给一个词/句一段
  // 中文解释」，区别只在有没有 context / existing，交给调用方决定传不传。
  app.post('/v1/ai/explain', async (c) => {
    if (!deps.ai) {
      return c.json({ error: '这台服务器没有开 AI 解释（缺 ANTHROPIC_API_KEY）', code: 'ai_off' }, 503);
    }
    const payload = await c.req.json().catch(() => null);
    const word = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).word : undefined;
    if (typeof word !== 'string' || !word.trim()) return c.json({ error: '缺少 word' }, 400);

    const raw = payload as Record<string, unknown>;
    const context = typeof raw.context === 'string' ? raw.context.trim().slice(0, 1000) : undefined;
    const existing = typeof raw.existing === 'string' ? raw.existing.trim().slice(0, 500) : undefined;

    try {
      const note = await deps.ai.explain({ word: word.trim().slice(0, 200), context, existing });
      return c.json({ note });
    } catch (err) {
      // 上游是网络问题还是账单问题，客户端不需要知道 —— 一律「暂时不可用」，
      // 让用户过一会儿再试，而不是把一段可能带敏感信息的报错原样展示出去。
      return c.json({ error: err instanceof Error ? err.message : 'AI 调用失败', code: 'ai_failed' }, 502);
    }
  });

  // ── 设备诊断（变更 56）────────────────────────────────────────────────
  // 起因：iPhone 上热更停摆，而开发机是 Windows —— 没有 Mac、没有 Xcode 控制台，
  // 手机内部发生了什么**一个字都看不到**。手机上点一下把报告发到这儿，
  // 我在这台机器上 `cat` 一下就行。存的是原样 JSON，形状由客户端定（它带 `schema`）。
  app.post('/v1/diag', async (c) => {
    if (!deps.diag) {
      return c.json({ error: '这台服务器没有开诊断收件箱', code: 'diag_off' }, 503);
    }
    const raw = await c.req.text();
    // 上限比文档松不了多少：一份报告几百 KB 已经很多了，再大就是客户端出了 bug，
    // 而一个能往盘上写任意大文件的接口比没有诊断危险得多。
    if (raw.length > MAX_DIAG_BYTES) return c.json({ error: '诊断报告太大' }, 413);
    let report: unknown;
    try {
      report = JSON.parse(raw);
    } catch {
      return c.json({ error: '诊断报告不是合法 JSON' }, 400);
    }
    return c.json(deps.diag.save(c.get('userId'), report));
  });

  app.get('/v1/diag', (c) => {
    if (!deps.diag) return c.json({ error: '这台服务器没有开诊断收件箱', code: 'diag_off' }, 503);
    return c.json({ reports: deps.diag.list(c.get('userId')) });
  });

  app.get('/v1/diag/:id', (c) => {
    if (!deps.diag) return c.json({ error: '这台服务器没有开诊断收件箱', code: 'diag_off' }, 503);
    const text = deps.diag.get(c.get('userId'), c.req.param('id'));
    if (text === null) return c.json({ error: '没有这份报告' }, 404);
    return c.body(text, 200, { 'content-type': 'application/json; charset=utf-8' });
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
