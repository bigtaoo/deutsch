import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  THEME_COLOR,
  THEME_KEY,
  applyTheme,
  readThemeChoice,
  resolveTheme,
  setThemeChoice,
  watchSystemTheme,
  type ThemeChoice,
} from './theme';

/**
 * 主题选择（变更 90 / §12.25）。
 *
 * 这一套的判据集中在两件事上，因为这两件错了没人会立刻发现：
 * 1. **「跟随系统」之外的四档不许被系统外观改掉** —— 手动选了夜间的人，
 *    太阳一出来（iOS 的「自动」外观）被切回浅色，等于这个开关不存在；
 * 2. **读不出来时永远回落到 system** —— 主题是一个每次启动都必须有答案的问题，
 *    存储坏了（隐私模式、WKWebView 的某些配置）不该变成一片没有令牌的白页。
 */

/**
 * jsdom 在这套配置下不给 `localStorage`（源是 opaque origin），而 Node 自己那个
 * 实验性全局又是 undefined —— 裸写 `localStorage` 在测试里拿到的就是它。
 * 所以和 align/journal.test.ts 一样，整个换成一个内存实现。
 */
function stubStorage() {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  vi.stubGlobal('localStorage', store);
  return store;
}

/** jsdom 没有 matchMedia。装一个能开关的假货，并把注册的监听器留出来好手动触发。 */
function stubMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', () => mql);
  window.matchMedia = (() => mql) as unknown as typeof window.matchMedia;
  return {
    /** 系统外观变了：改 matches 再把监听器都叫一遍，和浏览器的顺序一致。 */
    flip(next: boolean) {
      mql.matches = next;
      for (const fn of listeners) fn();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

let storage: ReturnType<typeof stubStorage>;

beforeEach(() => {
  storage = stubStorage();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '<meta id="theme-color" name="theme-color" content="#e0f2fe">';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveTheme', () => {
  it('system 跟着系统外观走，其余三档原样返回', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    for (const choice of ['light', 'dark', 'night'] as const) {
      expect(resolveTheme(choice, true)).toBe(choice);
      expect(resolveTheme(choice, false)).toBe(choice);
    }
  });
});

describe('readThemeChoice', () => {
  it('没存过 → system', () => {
    expect(readThemeChoice()).toBe('system');
  });

  it('存过的四档原样读回来', () => {
    for (const choice of ['system', 'light', 'dark', 'night'] as const) {
      storage.setItem(THEME_KEY, choice);
      expect(readThemeChoice()).toBe(choice);
    }
  });

  it('存着一个不认识的值（老版本写的、手动改坏的）→ system，不是原样返回', () => {
    storage.setItem(THEME_KEY, 'sepia');
    expect(readThemeChoice()).toBe('system');
  });

  it('localStorage 读一下就抛（隐私模式）→ system，不往外扔异常', () => {
    storage.getItem = () => {
      throw new Error('SecurityError');
    };
    expect(readThemeChoice()).toBe('system');
  });
});

describe('applyTheme', () => {
  it('把解析后的那一档写进 <html data-theme>，并同步状态栏颜色', () => {
    stubMatchMedia(false);
    expect(applyTheme('night')).toBe('night');
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
    expect(document.querySelector<HTMLMetaElement>('#theme-color')!.content).toBe(
      THEME_COLOR.night,
    );
  });

  it('写进去的永远是 light|dark|night —— `system` 不许落到属性上', () => {
    // CSS 里只有这三条规则；属性写成 system 的话一个令牌都不会命中。
    stubMatchMedia(true);
    expect(applyTheme('system')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.querySelector<HTMLMetaElement>('#theme-color')!.content).toBe(THEME_COLOR.dark);
  });

  it('不碰 localStorage —— 落盘是 setThemeChoice 的事', () => {
    stubMatchMedia(false);
    applyTheme('dark');
    expect(storage.getItem(THEME_KEY)).toBeNull();
  });
});

describe('setThemeChoice', () => {
  it('落盘 + 立刻生效', () => {
    stubMatchMedia(false);
    expect(setThemeChoice('night')).toBe('night');
    expect(storage.getItem(THEME_KEY)).toBe('night');
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
  });

  it('存不下也照样生效本次会话 —— 别因为存储坏了连切换都不认', () => {
    stubMatchMedia(false);
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(setThemeChoice('night')).toBe('night');
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
  });
});

describe('watchSystemTheme', () => {
  it('选的是「跟随系统」时，系统外观一变就跟着换', () => {
    const media = stubMatchMedia(false);
    watchSystemTheme(() => 'system');
    expect(media.listenerCount).toBe(1);

    media.flip(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    media.flip(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('**手动选了某一档就不许被系统改掉** —— 这是整个开关存在的理由', () => {
    const media = stubMatchMedia(false);
    let choice: ThemeChoice = 'night';
    applyTheme(choice);
    watchSystemTheme(() => choice);

    media.flip(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
    media.flip(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');

    // 切回「跟随系统」之后同一个订阅要重新开始生效，不用重新注册。
    choice = 'system';
    media.flip(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('退订之后不再反应', () => {
    const media = stubMatchMedia(false);
    const off = watchSystemTheme(() => 'system');
    off();
    expect(media.listenerCount).toBe(0);
    media.flip(true);
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('没有 matchMedia 的环境里是空操作，不抛', () => {
    vi.stubGlobal('matchMedia', undefined);
    // @ts-expect-error 故意把它拿掉，模拟老 WebView
    window.matchMedia = undefined;
    expect(() => watchSystemTheme(() => 'system')()).not.toThrow();
  });
});
