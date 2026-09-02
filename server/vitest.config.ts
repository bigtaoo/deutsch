import { defineConfig } from 'vitest/config';

// 独立的配置文件，否则 vitest 会往上找到仓库根那份 vite.config.ts
// （里面有 jsdom 环境和前端的 setup 文件），后端测试会因为找不到 setup 而整体不跑。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
