// FR-6.11（变更 92）：跟读进度两层存法的取舍规则。
//
// 要守的是三件事：
//   1. 写坏了的值（手改过的 localStorage、旧版本留下的字符串）不许把人送到不存在的句子；
//   2. 本机优先于同步那一份 —— 本机那份每换一句就写，同步那份只在离开时写，不可能更新；
//   3. 「从头开始」真的要把本机那份删掉，否则下次打开又跳回去。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearLocalShadowingAt,
  loadLocalShadowingAt,
  resumeShadowingAt,
  saveLocalShadowingAt,
} from './shadowingProgress';

// jsdom 在这套配置下不给 localStorage（opaque origin，见 align/journal.test.ts），自己给一个。
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

beforeEach(() => {
  store.clear();
});

describe('shadowingProgress', () => {
  it('存了就读得回来，没存过是 null', () => {
    expect(loadLocalShadowingAt('l1')).toBeNull();
    saveLocalShadowingAt('l1', 17);
    expect(loadLocalShadowingAt('l1')).toBe(17);
  });

  it('按课分键 —— 一课的进度不会串到另一课头上', () => {
    saveLocalShadowingAt('l1', 17);
    saveLocalShadowingAt('l2', 3);
    expect(loadLocalShadowingAt('l1')).toBe(17);
    expect(loadLocalShadowingAt('l2')).toBe(3);
  });

  it('第 0 句是真进度，不是「没存过」', () => {
    saveLocalShadowingAt('l1', 0);
    expect(loadLocalShadowingAt('l1')).toBe(0);
  });

  it('坏值一律当没存过（负数、小数、空串、非数字）', () => {
    for (const bad of ['-1', '2.5', '', 'abc', 'NaN']) {
      store.set('deutsch.shadowingAt.l1', bad);
      expect(loadLocalShadowingAt('l1')).toBeNull();
    }
  });

  it('清掉之后真的没了', () => {
    saveLocalShadowingAt('l1', 17);
    clearLocalShadowingAt('l1');
    expect(loadLocalShadowingAt('l1')).toBeNull();
  });

  it('本机优先于同步回来的那一份', () => {
    saveLocalShadowingAt('l1', 17);
    expect(resumeShadowingAt('l1', 3)).toBe(17);
  });

  it('本机没有（换了台设备）才用同步那一份', () => {
    expect(resumeShadowingAt('l1', 3)).toBe(3);
    expect(resumeShadowingAt('l1', undefined)).toBeNull();
  });

  it('同步那一份也可能是坏的（手改过的备份文件）', () => {
    expect(resumeShadowingAt('l1', -1)).toBeNull();
    expect(resumeShadowingAt('l1', 2.5)).toBeNull();
  });

  it('localStorage 整个不能用时不抛 —— 隐私模式下跟读照样要能开始', () => {
    const denied = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    try {
      expect(() => saveLocalShadowingAt('l1', 1)).not.toThrow();
      expect(loadLocalShadowingAt('l1')).toBeNull();
      expect(() => clearLocalShadowingAt('l1')).not.toThrow();
      expect(resumeShadowingAt('l1', 4)).toBe(4);
    } finally {
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      });
    }
  });
});
