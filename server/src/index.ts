// 进程入口。配置读不出来就立刻退出（理由见 config.ts 顶部）。

import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { createGoogleVerifier } from './googleToken.ts';
import { createApp } from './app.ts';
import { createEngine } from './align/engine.ts';
import { createJobQueue } from './align/jobs.ts';
import { createAiExplainer } from './ai.ts';

const config = loadConfig();
const store = new Store(join(config.dataDir, 'sync.sqlite'));

// 对齐那一半（FR-15.17）。**不在启动时加载权重** —— 那要十几秒、1.2GB，
// 而绝大多数重启之后的第一件事是同步而不是对齐。第一次真有任务时才加载（engine 自己缓存），
// 所以配错了不会挡住启动，只会让第一次对齐失败并在 /v1/healthz 的 align.message 里说清原因。
const align = config.align.enabled
  ? (() => {
      const engine = createEngine({
        dir: config.align.modelDir,
        dtype: config.align.dtype,
        threads: config.align.threads,
        maxSeconds: config.align.maxSeconds,
        idleMs: config.align.idleMs,
      });
      return {
        engine,
        queue: createJobQueue({
          engine,
          maxQueued: config.align.maxQueued,
          ttlMs: config.align.resultTtlMs,
        }),
        maxAudioBytes: config.align.maxAudioBytes,
      };
    })()
  : undefined;

const app = createApp({
  store,
  config,
  verifyGoogleIdToken: createGoogleVerifier(config.googleClientIds),
  align,
  // 权重站与对齐是分开的两件事：`ALIGN_ENABLED=false` 之后这台服务器仍然可以
  // 只当权重站 —— 桌面浏览器那条路要靠它才拿得到权重（见 align/weights.ts）。
  weightsDir: config.align.serveWeights ? config.align.modelDir : undefined,
  ai: config.ai.apiKey ? createAiExplainer(config.ai.apiKey, config.ai.model) : undefined,
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log('[deutsch-sync] 监听 ' + info.address + ':' + info.port + '，数据在 ' + config.dataDir);
  console.log('[deutsch-sync] 白名单：' + config.allowedEmails.join(', '));
  console.log(
    '[deutsch-sync] 对齐：' +
      (align
        ? `开（${config.align.dtype}，${config.align.threads} 线程，权重在 ${config.align.modelDir}）`
        : '关'),
  );
  console.log('[deutsch-sync] AI 补充解释：' + (config.ai.apiKey ? `开（${config.ai.model}）` : '关'));
});

function shutdown(signal: string): void {
  console.log('[deutsch-sync] 收到 ' + signal + '，关闭中');
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
