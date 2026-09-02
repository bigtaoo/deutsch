// 全部配置从环境变量读，启动时一次性校验完 —— 配错了要在 `docker compose up` 那一刻就炸，
// 而不是等到某天第一次有人点「登录」才发现 SESSION_SECRET 是空的。
//
// 这条服务只服务一个人（或很少几个人）。allowlist 为空时**拒绝启动**：
// 一个挂在公网 443 上、谁登录都给存东西的备份服务器，比没有备份服务器糟糕得多。

export interface Config {
  port: number;
  dataDir: string;
  /** 允许的 Google ID token `aud` —— Web / iOS / Android 各一个客户端 ID。 */
  googleClientIds: string[];
  /** 允许登录的邮箱，小写。 */
  allowedEmails: string[];
  sessionSecret: Uint8Array;
  sessionTtlDays: number;
  /** CORS 白名单。原生壳的 origin 是 capacitor://localhost（iOS）/ https://localhost（Android）。 */
  allowedOrigins: string[];
  /** 单个文档的字节上限。vocab.json 上万条也就几 MB，8MB 足够且能挡住误传音频。 */
  maxDocBytes: number;
  /** 每个文档保留多少个历史版本 —— 这是 GitHub 方案里「git 历史可回滚」的替代物。 */
  revisionsPerDoc: number;
}

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function requireNonEmpty(name: string, values: string[]): string[] {
  if (values.length === 0) throw new Error(`缺少环境变量 ${name}`);
  return values;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.SESSION_SECRET ?? '';
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET 至少 32 个字符（openssl rand -hex 32）');
  }

  return {
    port: Number(env.PORT ?? 8790),
    dataDir: env.DATA_DIR ?? './data',
    googleClientIds: requireNonEmpty('GOOGLE_CLIENT_IDS', list(env.GOOGLE_CLIENT_IDS)),
    allowedEmails: requireNonEmpty('ALLOWED_EMAILS', list(env.ALLOWED_EMAILS)).map((e) =>
      e.toLowerCase(),
    ),
    sessionSecret: new TextEncoder().encode(secret),
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 90),
    allowedOrigins: requireNonEmpty('ALLOWED_ORIGINS', list(env.ALLOWED_ORIGINS)),
    maxDocBytes: Number(env.MAX_DOC_BYTES ?? 8 * 1024 * 1024),
    revisionsPerDoc: Number(env.REVISIONS_PER_DOC ?? 30),
  };
}
