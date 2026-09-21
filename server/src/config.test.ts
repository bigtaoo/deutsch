// 配置在启动时一次性校验完 —— 这个文件的全部意义是让「配错了」在 `docker compose up`
// 那一刻就炸，而不是等到某天第一次有人点「登录」才发现。
//
// 三条拒绝启动的规则值得单独钉住，因为它们保护的东西很贵：
//   · SESSION_SECRET 太短 → 会话令牌可被爆破；
//   · GOOGLE_CLIENT_IDS 为空 → aud 校验失效，任何 Google 应用的 token 都能登录进来；
//   · ALLOWED_EMAILS 为空 → 一个挂在公网 443 上、谁登录都给存东西的备份服务器。

import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const SECRET = 'x'.repeat(32);

const MINIMAL = {
  SESSION_SECRET: SECRET,
  GOOGLE_CLIENT_IDS: 'web.apps.googleusercontent.com',
  ALLOWED_EMAILS: 'Tao@Example.invalid',
  ALLOWED_ORIGINS: 'https://d.example.invalid',
} satisfies NodeJS.ProcessEnv;

const load = (extra: NodeJS.ProcessEnv = {}) => loadConfig({ ...MINIMAL, ...extra });

describe('拒绝启动', () => {
  it('SESSION_SECRET 缺失或不足 32 字符', () => {
    expect(() => loadConfig({ ...MINIMAL, SESSION_SECRET: undefined })).toThrow('SESSION_SECRET');
    expect(() => loadConfig({ ...MINIMAL, SESSION_SECRET: 'kurz' })).toThrow('32');
    expect(() => loadConfig({ ...MINIMAL, SESSION_SECRET: 'x'.repeat(31) })).toThrow('32');
    expect(() => loadConfig({ ...MINIMAL, SESSION_SECRET: 'x'.repeat(32) })).not.toThrow();
  });

  it('GOOGLE_CLIENT_IDS 为空 —— aud 校验没了等于谁都能登录', () => {
    expect(() => loadConfig({ ...MINIMAL, GOOGLE_CLIENT_IDS: undefined })).toThrow(
      'GOOGLE_CLIENT_IDS',
    );
    expect(() => loadConfig({ ...MINIMAL, GOOGLE_CLIENT_IDS: ' , , ' })).toThrow(
      'GOOGLE_CLIENT_IDS',
    );
  });

  it('ALLOWED_EMAILS 为空 —— 白名单空着比没有备份服务器更糟', () => {
    expect(() => loadConfig({ ...MINIMAL, ALLOWED_EMAILS: undefined })).toThrow('ALLOWED_EMAILS');
    expect(() => loadConfig({ ...MINIMAL, ALLOWED_EMAILS: '' })).toThrow('ALLOWED_EMAILS');
  });

  it('ALLOWED_ORIGINS 为空', () => {
    expect(() => loadConfig({ ...MINIMAL, ALLOWED_ORIGINS: undefined })).toThrow('ALLOWED_ORIGINS');
  });
});

describe('列表解析', () => {
  it('逗号分隔，顺手去空白与空项', () => {
    const config = load({ GOOGLE_CLIENT_IDS: ' a , b ,, c ' });
    expect(config.googleClientIds).toEqual(['a', 'b', 'c']);
  });

  it('邮箱一律转小写 —— 白名单比对不能被大小写绕过', () => {
    expect(load({ ALLOWED_EMAILS: 'Tao@Example.INVALID' }).allowedEmails).toEqual([
      'tao@example.invalid',
    ]);
  });

  it('origin **不**转小写（它要和浏览器发来的那串逐字比）', () => {
    expect(load({ ALLOWED_ORIGINS: 'capacitor://localhost' }).allowedOrigins).toEqual([
      'capacitor://localhost',
    ]);
  });
});

describe('默认值', () => {
  it('同步那一半：端口、数据目录、会话有效期、体积上限、历史版本数', () => {
    const config = load();
    expect(config).toMatchObject({
      port: 8790,
      dataDir: './data',
      sessionTtlDays: 90,
      maxDocBytes: 8 * 1024 * 1024,
      revisionsPerDoc: 30,
    });
  });

  it('对齐那一半：默认开、fp32、闲置十分钟释放、权重站开着', () => {
    expect(load().align).toMatchObject({
      enabled: true,
      dtype: 'fp32',
      idleMs: 10 * 60_000,
      serveWeights: true,
      threads: 3,
      maxSeconds: 1800,
      maxQueued: 3,
    });
  });

  it('权重默认放在数据卷里，跟着 DATA_DIR 走 —— 镜像重建不该碰它', () => {
    expect(load({ DATA_DIR: '/data' }).align.modelDir).toBe('/data/models');
    expect(load({ DATA_DIR: '/data', ALIGN_MODEL_DIR: '/anderswo' }).align.modelDir).toBe(
      '/anderswo',
    );
  });

  it('SESSION_SECRET 变成字节，原文不留在配置对象上', () => {
    const config = load();
    expect(config.sessionSecret).toBeInstanceOf(Uint8Array);
    expect(config.sessionSecret.byteLength).toBe(32);
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });
});

describe('开关', () => {
  it('`1` 与 `true`（不分大小写）都算开，别的都算关', () => {
    expect(load({ ALIGN_ENABLED: '1' }).align.enabled).toBe(true);
    expect(load({ ALIGN_ENABLED: 'true' }).align.enabled).toBe(true);
    expect(load({ ALIGN_ENABLED: 'TRUE' }).align.enabled).toBe(true);
    expect(load({ ALIGN_ENABLED: '0' }).align.enabled).toBe(false);
    expect(load({ ALIGN_ENABLED: 'false' }).align.enabled).toBe(false);
    expect(load({ ALIGN_ENABLED: 'ja' }).align.enabled).toBe(false);
  });

  it('空字符串当成「没配」，落回默认值 —— compose 里写了变量名没给值就是这种', () => {
    expect(load({ ALIGN_ENABLED: '' }).align.enabled).toBe(true);
    expect(load({ ALIGN_SERVE_WEIGHTS: '' }).align.serveWeights).toBe(true);
  });

  it('对齐关掉之后权重站仍然可以单开 —— 它们是两件事', () => {
    const config = load({ ALIGN_ENABLED: 'false', ALIGN_SERVE_WEIGHTS: 'true' });
    expect(config.align.enabled).toBe(false);
    expect(config.align.serveWeights).toBe(true);
  });

  it('闲置释放可以关成 0（永不放）', () => {
    expect(load({ ALIGN_IDLE_MS: '0' }).align.idleMs).toBe(0);
  });
});
