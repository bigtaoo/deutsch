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

export const LESSON_TABS = ['sentences', 'listen', 'timestamps', 'shadowing', 'study', 'dictation'] as const;
export type LessonTab = (typeof LESSON_TABS)[number];

export const LESSON_TAB_LABELS: Record<LessonTab, string> = {
  sentences: '切句',
  listen: '通听',
  timestamps: '标注',
  shadowing: '跟读',
  study: '学词',
  dictation: '听写',
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
        tab: tab && LESSON_TABS.includes(tab) ? tab : 'sentences',
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
