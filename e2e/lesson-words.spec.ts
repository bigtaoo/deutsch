// FR-22.14 —— 对齐过的课一打开，新词自动进速背（变更 84），用构建产物里**真的词典**跑一遍。
//
// harvest.test.ts 把词典、常见词表都换成了假的；这里守的正是它守不住的：真的牌组 + 真的常见词形表
// （public/dict/common-forms.json）一起筛完之后，满篇常用词都走掉、只剩少见词进了今天的计划，
// 并且课程词排在最前面。词形表漏部署或判据写反，`Wald` `Menschen` 会全进池 —— 单测里看不出来。

import { expect, test } from '@playwright/test';
import { importBackup, importLesson, openApp } from './app';
import { MANUSCRIPT, timedLessonBackup, wavBytes } from './fixtures';

const TITLE = 'Alltagsdeutsch: Der deutsche Wald';
// 三句话里口语不常见的只有这三个（`Bäumen` `Herbst` `Menschen` 都在前一万的词形里）
const RARE = ['Ansammlung', 'Erholung', 'färben'];

test('打开一课对齐过的课：少见词自动进今天的速背，且排在最前', async ({ page }) => {
  // 词库拿不到：池子里只会有这节课收进来的词
  await page.route('**/v1/wordbank**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT, audio: wavBytes(30) });
  const lessonId = new URL(page.url()).hash.match(/#\/lesson\/([^/]+)\//)![1];
  await importBackup(page, timedLessonBackup(lessonId));
  await page.goto(`/#/lesson/${lessonId}/listen`);
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();

  await page.goto('/#/vocab');
  const today = page.getByRole('region', { name: '今天' });
  await expect(today.getByText(/^0 \/ [1-3]$/)).toBeVisible({ timeout: 15_000 });

  await today.getByRole('button', { name: '开始', exact: true }).click();
  const word = (await page.locator('p.text-word').first().textContent())!.trim();
  expect(RARE.some((w) => word.includes(w))).toBe(true);
});
