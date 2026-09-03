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
  /**
   * 对齐那一半（FR-15.17）。整块可关：这条服务的本职是备份，
   * 对齐是搭上来的第二个用途，任何一天它碍事了就 `ALIGN_ENABLED=false` 重启。
   */
  align: {
    enabled: boolean;
    /** 权重放哪。默认 `${dataDir}/models` —— 挂进来的卷，镜像重建不碰它。 */
    modelDir: string;
    /** 权重变体。默认 q4，与手机原生插件那一档同一份（见 align/model.ts 顶部）。 */
    dtype: string;
    /** ORT 的 intra-op 线程数。4 vCPU 的机器上默认留一个给别人。 */
    threads: number;
    /** 上传音频的字节上限。一课 6~10MB，40MB 挡的是误传和恶意。 */
    maxAudioBytes: number;
    /** 音频秒数上限。一期 8~10 分钟，30 分钟已经很宽松。 */
    maxSeconds: number;
    /** 排队上限（不含正在跑的那个）。 */
    maxQueued: number;
    /** 结果留多久 —— 「手机切走十分钟再回来取」这条路要靠它。 */
    resultTtlMs: number;
  };
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
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

  const dataDir = env.DATA_DIR ?? './data';

  return {
    port: Number(env.PORT ?? 8790),
    dataDir,
    googleClientIds: requireNonEmpty('GOOGLE_CLIENT_IDS', list(env.GOOGLE_CLIENT_IDS)),
    allowedEmails: requireNonEmpty('ALLOWED_EMAILS', list(env.ALLOWED_EMAILS)).map((e) =>
      e.toLowerCase(),
    ),
    sessionSecret: new TextEncoder().encode(secret),
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 90),
    allowedOrigins: requireNonEmpty('ALLOWED_ORIGINS', list(env.ALLOWED_ORIGINS)),
    maxDocBytes: Number(env.MAX_DOC_BYTES ?? 8 * 1024 * 1024),
    revisionsPerDoc: Number(env.REVISIONS_PER_DOC ?? 30),
    align: {
      enabled: flag(env.ALIGN_ENABLED, true),
      modelDir: env.ALIGN_MODEL_DIR ?? `${dataDir}/models`,
      dtype: env.ALIGN_MODEL_DTYPE ?? 'q4',
      threads: Number(env.ALIGN_THREADS ?? 3),
      maxAudioBytes: Number(env.ALIGN_MAX_AUDIO_BYTES ?? 40 * 1024 * 1024),
      maxSeconds: Number(env.ALIGN_MAX_SECONDS ?? 1800),
      maxQueued: Number(env.ALIGN_MAX_QUEUED ?? 3),
      resultTtlMs: Number(env.ALIGN_RESULT_TTL_MS ?? 30 * 60_000),
    },
  };
}
