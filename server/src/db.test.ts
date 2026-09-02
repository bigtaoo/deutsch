import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from './db.ts';

const USER = 'google-sub-1';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    store.upsertUser({ id: USER, email: 'a@example.com', name: 'A', picture: null });
  });

  it('第一次写入 baseVersion 必须是 null，版本从 1 开始', () => {
    const result = store.putDoc(USER, 'vocab', null, '[]');
    expect(result).toMatchObject({ ok: true, version: 1 });
    expect(store.getDoc(USER, 'vocab')?.body).toBe('[]');
  });

  it('文档已存在时再用 null 当 baseVersion 会冲突，并把远端现值带回来', () => {
    store.putDoc(USER, 'vocab', null, '[1]');
    const result = store.putDoc(USER, 'vocab', null, '[2]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict.body).toBe('[1]');
    // 冲突不能留下痕迹：远端还是旧值、版本没涨。
    expect(store.getDoc(USER, 'vocab')).toMatchObject({ version: 1, body: '[1]' });
  });

  it('baseVersion 对得上就递增版本号', () => {
    store.putDoc(USER, 'vocab', null, '[1]');
    const result = store.putDoc(USER, 'vocab', 1, '[2]');
    expect(result).toMatchObject({ ok: true, version: 2 });
  });

  it('落后的 baseVersion 冲突 —— 绝不静默覆盖', () => {
    store.putDoc(USER, 'vocab', null, '[1]');
    store.putDoc(USER, 'vocab', 1, '[2]');
    const stale = store.putDoc(USER, 'vocab', 1, '[3]');
    expect(stale.ok).toBe(false);
    expect(store.getDoc(USER, 'vocab')?.body).toBe('[2]');
  });

  it('每次覆盖都把旧值留进历史', () => {
    store.putDoc(USER, 'vocab', null, '[1]');
    store.putDoc(USER, 'vocab', 1, '[2]');
    store.putDoc(USER, 'vocab', 2, '[3]');
    expect(store.listRevisions(USER, 'vocab').map((r) => r.version)).toEqual([2, 1]);
    expect(store.getRevision(USER, 'vocab', 1)?.body).toBe('[1]');
  });

  it('pruneRevisions 只保留最近 N 版', () => {
    store.putDoc(USER, 'vocab', null, '[0]');
    for (let v = 1; v <= 10; v += 1) store.putDoc(USER, 'vocab', v, '[' + v + ']');
    store.pruneRevisions(USER, 'vocab', 3);
    expect(store.listRevisions(USER, 'vocab').map((r) => r.version)).toEqual([10, 9, 8]);
  });

  it('删除也留一份历史，删完就查不到了', () => {
    store.putDoc(USER, 'vocab', null, '[1]');
    expect(store.deleteDoc(USER, 'vocab')).toBe(true);
    expect(store.getDoc(USER, 'vocab')).toBeNull();
    expect(store.getRevision(USER, 'vocab', 1)?.body).toBe('[1]');
    expect(store.deleteDoc(USER, 'vocab')).toBe(false);
  });

  it('两个用户的同名文档互不干扰', () => {
    store.upsertUser({ id: 'other', email: 'b@example.com', name: null, picture: null });
    store.putDoc(USER, 'vocab', null, '["a"]');
    store.putDoc('other', 'vocab', null, '["b"]');
    expect(store.getDoc(USER, 'vocab')?.body).toBe('["a"]');
    expect(store.getDoc('other', 'vocab')?.body).toBe('["b"]');
    expect(store.listDocs(USER)).toHaveLength(1);
  });

  it('upsertUser 用同一个 sub 再登录只刷新资料', () => {
    store.upsertUser({ id: USER, email: 'a@example.com', name: '新名字', picture: 'p' });
    expect(store.getUser(USER)).toMatchObject({ email: 'a@example.com', name: '新名字', picture: 'p' });
    expect(store.stats().users).toBe(1);
  });
});
