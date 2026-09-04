// 极薄的 hash 路由。不引 react-router：这个应用一共十来个页面、没有嵌套布局、
// 没有 loader/action 需求，一个 hashchange 订阅就够了。hash 而非 history 路由，
// 是因为部署在静态托管上（§2.5），不想为 SPA fallback 再配一层规则。

import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type Route =
  | { name: 'lessons' }
  | { name: 'import' }
  | { name: 'sources' }
  | { name: 'lesson'; lessonId: string; tab: LessonTab }
  | { name: 'vocab' }
  | { name: 'review' }
  | { name: 'cache' }
  | { name: 'settings' };

/**
 * 一课的所有 tab。**顺序就是真实动线**（§12.6）：通听 → 跟读 → 学词 → 听写。
 *
 * 「标注」那一页在 FR-15 之后去掉了：时间戳一律由自动对齐给（导入后立刻跑），
 * 状态与重跑入口在课程页头部的 AlignStatus 里。
 */
export const LESSON_TABS = ['listen', 'shadowing', 'study', 'dictation', 'sentences'] as const;
export type LessonTab = (typeof LESSON_TABS)[number];

/**
 * 每天要走的那四个。`sentences` **不在其中** —— 它是一次性的准备工作（§12.6）。
 *
 * 以前五个 tab 平级排着，而且落地页就是 `sentences`：打开一课的默认状态是
 * 「编辑模式」，不是「能练」。切句现在收进课程页头部的「⋯」，深链接照旧有效。
 */
export const PRACTICE_TABS = ['listen', 'shadowing', 'study', 'dictation'] as const;

export const DEFAULT_LESSON_TAB: LessonTab = 'listen';

export const LESSON_TAB_LABELS: Record<LessonTab, string> = {
  listen: '通听',
  shadowing: '跟读',
  study: '学词',
  dictation: '听写',
  sentences: '切句',
};

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case undefined:
    case 'lessons':
      return { name: 'lessons' };
    case 'import':
      return { name: 'import' };
    case 'sources':
      return { name: 'sources' };
    case 'vocab':
      return { name: 'vocab' };
    case 'review':
      return { name: 'review' };
    case 'cache':
      return { name: 'cache' };
    case 'settings':
      return { name: 'settings' };
    case 'lesson': {
      const tab = parts[2] as LessonTab | undefined;
      return {
        name: 'lesson',
        lessonId: parts[1] ?? '',
        tab: tab && LESSON_TABS.includes(tab) ? tab : DEFAULT_LESSON_TAB,
      };
    }
    default:
      return { name: 'lessons' };
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'lessons':
      return '#/lessons';
    case 'lesson':
      return `#/lesson/${route.lessonId}/${route.tab}`;
    default:
      return `#/${route.name}`;
  }
}

/** 进一课的默认落点。绝大多数链接都该用它，而不是自己挑一个 tab。 */
export function lessonHref(lessonId: string, tab: LessonTab = DEFAULT_LESSON_TAB): string {
  return href({ name: 'lesson', lessonId, tab });
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => '',
  );
  // parse 每次返回新对象，但只在 hash 变化时重新渲染，不会造成循环。
  return parse(hash);
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

/** 供 <a> 用：既保留「中键新开标签」的原生行为，又能在同页跳转。 */
export function useNavigate(): (route: Route) => void {
  return useCallback((route: Route) => navigate(route), []);
}

/** 进入新页面时滚回顶部 —— 长课程列表滚到一半点进去，不该停在半空。 */
export function useScrollToTopOnRouteChange(route: Route): void {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.name, route.name === 'lesson' ? route.lessonId : '']);
}
