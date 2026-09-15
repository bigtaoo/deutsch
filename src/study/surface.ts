// FR-18.1 的第一个条件：**哪几页算「在练」**。
//
// 单独一个文件、单独一个纯函数，是因为这份名单就是「学习时长」这个数字的定义。
// 它散在组件里的话，下次加一个页面时不会有人想起该不该把它算进来。
//
// 名单 = §12.6 那条动线上的四个 tab，加上复习。刻意**不含**：
//   切句、生词本、来源、素材、设置、记录 —— 那些是准备与管理，不是练。
//   课程列表 —— 挑一课要花的时间不该算进任何一天。

import type { Route } from '@/app/router';
import { PRACTICE_TABS } from '@/app/router';

export function isPracticeRoute(route: Route): boolean {
  if (route.name === 'review') return true;
  if (route.name !== 'lesson') return false;
  return (PRACTICE_TABS as readonly string[]).includes(route.tab);
}
