import { describe, it, expect, afterEach, vi } from 'vitest';
import { applySafeAreaFallback, expectedTopInset, measureEnvInsets } from './safeArea';

/**
 * jsdom 不认 `env()`，`getComputedStyle().paddingTop` 会返回 `''` → 0。
 * 这**恰好就是要守的那种设备**（env 报 0），所以这里不需要假装成 Safari。
 * 真机上 env 正常的那一侧由 `stubEnv` 造出来。
 */
function stubEnv(top: number, bottom: number): () => void {
  const real = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
    const style = real.call(window, el) as CSSStyleDeclaration;
    return { ...style, paddingTop: `${top}px`, paddingBottom: `${bottom}px` } as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle);
  return () => vi.restoreAllMocks();
}

function stubScreen(width: number, height: number): void {
  Object.defineProperty(window.screen, 'width', { value: width, configurable: true });
  Object.defineProperty(window.screen, 'height', { value: height, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--safe-top-min');
  document.documentElement.style.removeProperty('--safe-bottom-min');
});

describe('expectedTopInset', () => {
  it('iPhone 13（390×844）是 47 —— 表里查得到就用表里的', () => {
    expect(expectedTopInset(390, 844)).toBe(47);
  });

  it('横屏进来也认得出是同一台机器', () => {
    expect(expectedTopInset(844, 390)).toBe(47);
  });

  it('灵动岛那几台要 59，补少了照旧压住状态栏', () => {
    expect(expectedTopInset(393, 852)).toBe(59);
    expect(expectedTopInset(430, 932)).toBe(59);
  });

  it('表里没有但长宽比 ≥ 2 的，按刘海机给一个保守值', () => {
    expect(expectedTopInset(400, 900)).toBe(47);
  });

  it('iPhone SE（375×667）不是刘海机 —— 在它上面凭空加白边是实打实的破坏', () => {
    expect(expectedTopInset(375, 667)).toBe(0);
  });

  it('iPad 之类更方的屏幕同理', () => {
    expect(expectedTopInset(768, 1024)).toBe(0);
  });
});

describe('measureEnvInsets', () => {
  it('量完把探针摘掉 —— 一个 fixed 元素留在文档里会拦住点击', () => {
    const before = document.body.childElementCount;
    measureEnvInsets();
    expect(document.body.childElementCount).toBe(before);
  });

  it('env 有值时原样读出来', () => {
    const restore = stubEnv(47, 34);
    expect(measureEnvInsets()).toEqual({ top: 47, bottom: 34 });
    restore();
  });
});

describe('applySafeAreaFallback', () => {
  it('平台跟着结果走 —— 少了它，诊断行里那个 0 有三种含义', () => {
    stubScreen(390, 844);
    expect(applySafeAreaFallback('web').platform).toBe('web');
    expect(applySafeAreaFallback('ios').platform).toBe('ios');
  });

  it('iOS 上 env 报 0 且是刘海机 —— 兜底写进 CSS 变量', () => {
    stubScreen(390, 844);
    const probe = applySafeAreaFallback('ios');
    expect(probe.fallbackApplied).toBe(true);
    expect(probe.fallbackTop).toBe(47);
    expect(document.documentElement.style.getPropertyValue('--safe-top-min')).toBe('47px');
    expect(document.documentElement.style.getPropertyValue('--safe-bottom-min')).toBe('34px');
  });

  it('env 报得出数就什么都不做 —— 兜底在正常设备上必须是零效果', () => {
    stubScreen(390, 844);
    const restore = stubEnv(47, 34);
    const probe = applySafeAreaFallback('ios');
    expect(probe.fallbackApplied).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--safe-top-min')).toBe('');
    restore();
  });

  it('浏览器和 Android 上一律不补 —— 那里 env 一直是对的', () => {
    stubScreen(390, 844);
    expect(applySafeAreaFallback('web').fallbackApplied).toBe(false);
    expect(applySafeAreaFallback('android').fallbackApplied).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--safe-top-min')).toBe('');
  });

  it('iOS 但屏幕不像刘海机（SE）也不补', () => {
    stubScreen(375, 667);
    expect(applySafeAreaFallback('ios').fallbackApplied).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--safe-top-min')).toBe('');
  });
});
