// 路由是纯函数加一个 hashchange 订阅，但它决定了**深链接还能不能用** ——
// 生词本里的「去这一课」、分享出去的地址、Android 返回键退的那一格，全靠它。
// 解析是私有的，所以从 useRoute 这一侧验：那也正是应用真正用它的方式。

import { describe, expect, it, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  DEFAULT_LESSON_TAB,
  LESSON_TABS,
  LESSON_TAB_LABELS,
  PRACTICE_TABS,
  href,
  lessonHref,
  navigate,
  useRoute,
  type Route,
} from './router';

/** 设好 hash 再渲染 —— 顺序反了要多等一次 hashchange。 */
function routeAt(hash: string): Route {
  window.location.hash = hash;
  return renderHook(() => useRoute()).result.current;
}

afterEach(() => {
  window.location.hash = '';
});

describe('解析', () => {
  it('空 hash 落到课程列表 —— 打开应用第一眼是「今天练哪课」', () => {
    expect(routeAt('')).toEqual({ name: 'lessons' });
    expect(routeAt('#/')).toEqual({ name: 'lessons' });
  });

  it('每个单页路由都认得', () => {
    for (const name of ['lessons', 'import', 'sources', 'vocab', 'review', 'cache', 'record', 'settings'] as const) {
      expect(routeAt(`#/${name}`)).toEqual({ name });
    }
  });

  it('课程页带 tab', () => {
    expect(routeAt('#/lesson/abc/dictation')).toEqual({
      name: 'lesson',
      lessonId: 'abc',
      tab: 'dictation',
    });
  });

  it('不给 tab 时落到通听（§12.6 的动线起点）', () => {
    expect(routeAt('#/lesson/abc')).toEqual({
      name: 'lesson',
      lessonId: 'abc',
      tab: DEFAULT_LESSON_TAB,
    });
  });

  it('认不出的 tab 退回通听，而不是渲染一个空白页', () => {
    expect(routeAt('#/lesson/abc/annotate')).toMatchObject({ tab: DEFAULT_LESSON_TAB });
  });

  it('认不出的路由退回课程列表', () => {
    expect(routeAt('#/keine-ahnung')).toEqual({ name: 'lessons' });
  });

  it('多余的斜杠不影响解析 —— 手打地址和拼接出来的地址都得认', () => {
    expect(routeAt('#lessons')).toEqual({ name: 'lessons' });
    expect(routeAt('#//lesson//abc//study')).toEqual({
      name: 'lesson',
      lessonId: 'abc',
      tab: 'study',
    });
  });

  it('hash 变了会重新解析（hashchange 订阅真的接上了）', async () => {
    window.location.hash = '#/vocab';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: 'vocab' });
    // hashchange 是下一个 task 才投递的，所以要等一拍。
    navigate({ name: 'review' });
    await waitFor(() => expect(result.current).toEqual({ name: 'review' }));
  });
});

describe('生成', () => {
  it('每个路由 href 出来再解析回去还是它自己', () => {
    const routes: Route[] = [
      { name: 'lessons' },
      { name: 'import' },
      { name: 'sources' },
      { name: 'vocab' },
      { name: 'review' },
      { name: 'cache' },
      { name: 'record' },
      { name: 'settings' },
      ...LESSON_TABS.map((tab) => ({ name: 'lesson', lessonId: 'l-123', tab }) as Route),
    ];
    for (const route of routes) {
      expect(routeAt(href(route))).toEqual(route);
    }
  });

  it('lessonHref 默认进通听', () => {
    expect(lessonHref('l-1')).toBe('#/lesson/l-1/listen');
    expect(lessonHref('l-1', 'shadowing')).toBe('#/lesson/l-1/shadowing');
  });
});

describe('tab 清单（§12.6）', () => {
  it('每天走的四个是全部 tab 的子集，顺序就是动线', () => {
    expect(PRACTICE_TABS).toEqual(['listen', 'shadowing', 'study', 'dictation']);
    for (const tab of PRACTICE_TABS) expect(LESSON_TABS).toContain(tab);
  });

  it('切句与译文是一次性准备，不在每天那四个里', () => {
    expect(PRACTICE_TABS).not.toContain('sentences');
    expect(PRACTICE_TABS).not.toContain('translation');
  });

  it('每个 tab 都有中文名 —— 漏一个界面上就是一块空白', () => {
    for (const tab of LESSON_TABS) expect(LESSON_TAB_LABELS[tab]).toBeTruthy();
  });
});
