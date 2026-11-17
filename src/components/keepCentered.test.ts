// §12.27「跟读时当前句一直居中」的判据。
//
// 这里只测数字那一半：jsdom 没有布局，`getBoundingClientRect()` 恒为 0，
// 所以「真的滚没滚到中间」只有真浏览器说得准（那条在 e2e/shadowing.spec.ts 里）。
// 拆出 `needsCentering` 的意义正在这儿 —— 偏多少算偏，是可以脱开 DOM 验的。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bottomInsetPx, centerIfNeeded, needsCentering } from './keepCentered';

afterEach(() => vi.unstubAllGlobals());

describe('needsCentering', () => {
  const VH = 800;

  it('正好在中间：不滚 —— 每句都滚会抖', () => {
    expect(needsCentering({ top: 350, height: 100 }, VH)).toBe(false);
  });

  it('偏出容差才滚（容差之内仍算正好）', () => {
    // 中心 400 是正中；容差 80 → 中心落在 320~480 之间都不动。
    expect(needsCentering({ top: 420, height: 100 }, VH)).toBe(false);
    expect(needsCentering({ top: 560, height: 100 }, VH)).toBe(true);
  });

  it('被顶出屏幕上方：滚', () => {
    expect(needsCentering({ top: -200, height: 100 }, VH)).toBe(true);
  });

  it('底部浮层算进去 —— 否则手机上会把卡片推到播放条底下', () => {
    // 浮层 200px → 可视区只剩 600，正中是 300。卡片中心 400 原本是正中，现在偏了 100。
    expect(needsCentering({ top: 350, height: 100 }, VH)).toBe(false);
    expect(needsCentering({ top: 350, height: 100 }, VH, 200)).toBe(true);
  });

  it('比可视区还高的长句：只要求开头露出来，不强行居中（居中会把开头推出去）', () => {
    // 高 900 > 可视 800：顶部在 0~200 之间算好。
    expect(needsCentering({ top: 10, height: 900 }, VH)).toBe(false);
    expect(needsCentering({ top: -300, height: 900 }, VH)).toBe(true);
    expect(needsCentering({ top: 500, height: 900 }, VH)).toBe(true);
  });

  it('可视区被浮层吃光时不动 —— 算出负数再去滚只会乱跳', () => {
    expect(needsCentering({ top: 0, height: 100 }, 100, 300)).toBe(false);
  });
});

describe('bottomInsetPx', () => {
  it('读得出 --bottom-inset', () => {
    document.documentElement.style.setProperty('--bottom-inset', '72px');
    expect(bottomInsetPx()).toBe(72);
    document.documentElement.style.removeProperty('--bottom-inset');
  });

  it('没设过就是 0，不是 NaN —— NaN 会让后面的比较全部变成 false', () => {
    document.documentElement.style.removeProperty('--bottom-inset');
    expect(bottomInsetPx()).toBe(0);
  });
});

describe('centerIfNeeded', () => {
  function el(rect: { top: number; height: number }, spy?: () => void) {
    return {
      getBoundingClientRect: () => ({ top: rect.top, height: rect.height }),
      scrollIntoView: spy,
    } as unknown as HTMLElement;
  }

  it('没有元素、或这个环境没有 scrollIntoView：安静地什么都不做', () => {
    expect(centerIfNeeded(null)).toBe(false);
    expect(centerIfNeeded(el({ top: -500, height: 100 }))).toBe(false);
  });

  it('偏了就滚到中间', () => {
    vi.stubGlobal('innerHeight', 800);
    const spy = vi.fn();
    expect(centerIfNeeded(el({ top: -500, height: 100 }, spy))).toBe(true);
    expect(spy).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('正好就不滚 —— 人可能正自己翻着看', () => {
    vi.stubGlobal('innerHeight', 800);
    const spy = vi.fn();
    expect(centerIfNeeded(el({ top: 350, height: 100 }, spy))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('开了「减少动态效果」就瞬时滚，不做平滑', () => {
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const spy = vi.fn();
    centerIfNeeded(el({ top: -500, height: 100 }, spy));
    expect(spy).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
  });
});
