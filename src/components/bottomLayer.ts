// 底部单浮层契约（SPEC §12.2）。
//
// ── 它修的是一个真 bug，不只是版面问题 ──
// 在它之前，AlignBar 是 `fixed bottom-0 z-30`，AudioBar 是 `sticky bottom-0 z-10`，
// 两者都往视口底部贴 —— 自动对齐一跑，进度条就正正压住播放键。AlignBar 上那个
// `align-bar` class 本来是留给「避让偏移」的，而 index.css 里从来没有对应的规则。
// 页面容器上的 `pb-24` 是个孤立的魔法数：它既不知道当前有哪几层，也不知道
// 这台设备的安全区有多高。
//
// ── 契约 ──
//   1. 底部最多两层：**基座**（底部标签栏 或 音频条，两者互斥）+ **对齐进度**。
//   2. 每一层挂载时把自己的实测高度报上来，这里换算出两个变量：
//      `--base-bar-h`（基座高度，对齐条据此上移）与 `--bottom-inset`（总高度，
//      页面内容据此留白，见 index.css 的 .app-content）。
//   3. 优先级 音频条 > 对齐进度：有音频条在场时对齐进度默认折叠成一条进度线
//      （见 AlignBar 的 collapsed 分支），点开才占一整行。
//
// 为什么基座取 max 而不是相加：标签栏与音频条按路由互斥（课程页隐藏标签栏），
// 但切路由的那一帧两者可能同时挂着，取和会让页面底部抖一下。

import { useEffect, useSyncExternalStore } from 'react';

type Layer = 'tabbar' | 'audio' | 'align';

const heights = new Map<Layer, number>();
const listeners = new Set<() => void>();

/** 供 useSyncExternalStore 用的快照：只需要「音频条在不在」这一位。 */
let hasAudio = false;

function publish(): void {
  const base = Math.max(heights.get('tabbar') ?? 0, heights.get('audio') ?? 0);
  const total = base + (heights.get('align') ?? 0);
  if (typeof document !== 'undefined') {
    const root = document.documentElement.style;
    root.setProperty('--base-bar-h', `${base}px`);
    root.setProperty('--bottom-inset', `${total}px`);
  }
  // 按**在不在场**判断，不按高度：jsdom 里 offsetHeight 恒为 0，按高度判断会让
  // 测试环境永远认为没有音频条。
  const nextHasAudio = heights.has('audio');
  if (nextHasAudio !== hasAudio) {
    hasAudio = nextHasAudio;
    for (const listener of listeners) listener();
  }
}

/**
 * 把一层注册进底部栈，并持续上报它的实测高度。
 *
 * 实测而不是写死常量：音频条在跟读页多一排按钮、对齐条展开与折叠差一倍高度，
 * 而安全区在 iPhone 上又额外加十几个像素 —— 任何写死的数都会在某一种组合下错。
 */
export function useBottomLayer(layer: Layer, el: HTMLElement | null): void {
  // 每次渲染之后量一遍。**不能只靠 ResizeObserver**：这一层的高度变化绝大多数是
  // React 自己引起的（对齐条折叠 ↔ 展开差一倍高，跟读页给音频条多挂一排按钮），
  // 而那种变化这里量得到、量得准、量得早。
  //
  // 这条是被一次实测逼出来的：在隐藏的浏览器面板里 ResizeObserver 一个回调都不投递
  // （连初次那一发都没有），于是「展开对齐条」之后 --bottom-inset 一直停在折叠时的值。
  // 那种环境是个特例，但它说明了一件普遍的事 —— RO 的投递时机不由我们决定，
  // 而页面底部留白错了就是内容被浮层压住。一次 offsetHeight 读取换掉这个依赖，很便宜。
  useEffect(() => {
    if (!el) return;
    heights.set(layer, el.offsetHeight);
    publish();
  });

  // ResizeObserver 只负责**不是 React 引起的**那些变化：字体加载完、旋转屏幕、
  // 安全区变化（iOS 上转横屏 home indicator 会换边）。
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') {
      // jsdom 没有 ResizeObserver；上面那个 effect 已经量过了。
      return el
        ? () => {
            heights.delete(layer);
            publish();
          }
        : undefined;
    }
    const observer = new ResizeObserver(() => {
      heights.set(layer, el.offsetHeight);
      publish();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      heights.delete(layer);
      publish();
    };
  }, [layer, el]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 对齐条用它决定「折叠成一条线」还是「占一整行」。 */
export function useHasAudioBar(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hasAudio,
    () => false,
  );
}
