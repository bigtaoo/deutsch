// generateId 是课程与生词的主键来源。它只有一条硬要求：**不重**。
// 兜底分支（没有 crypto.randomUUID）平时跑不到，所以必须在这里单独喂一次 ——
// 它真正生效的场合是「某个旧 WebView 上」，而那时候没人在看测试。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateId } from './id';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateId', () => {
  it('有 crypto.randomUUID 时就用它', () => {
    const randomUUID = vi.fn(() => '11111111-2222-3333-4444-555555555555' as const);
    vi.stubGlobal('crypto', { randomUUID });
    expect(generateId()).toBe('11111111-2222-3333-4444-555555555555');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('没有 crypto.randomUUID 时不抛，走兜底分支', () => {
    vi.stubGlobal('crypto', {});
    expect(() => generateId()).not.toThrow();
    expect(generateId()).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  it('连 crypto 全局都没有时也不抛', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => generateId()).not.toThrow();
  });

  it('兜底分支连出 1000 个也不重 —— 它是主键', () => {
    vi.stubGlobal('crypto', {});
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    expect(ids.size).toBe(1000);
  });

  it('真实环境下连出 1000 个也不重', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    expect(ids.size).toBe(1000);
  });
});
