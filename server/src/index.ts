// 进程入口。配置读不出来就立刻退出（理由见 config.ts 顶部）。

import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { createGoogleVerifier } from './googleToken.ts';
import { createApp } from './app.ts';

const config = loadConfig();
const store = new Store(join(config.dataDir, 'sync.sqlite'));
const app = createApp({
  store,
  config,
  verifyGoogleIdToken: createGoogleVerifier(config.googleClientIds),
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log('[deutsch-sync] 监听 ' + info.address + ':' + info.port + '，数据在 ' + config.dataDir);
  console.log('[deutsch-sync] 白名单：' + config.allowedEmails.join(', '));
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
