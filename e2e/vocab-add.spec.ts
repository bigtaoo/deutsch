// FR-9.13 / FR-9.14 —— 课上加生词，用构建产物里**真的词典**跑一遍。
//
// 组件测试把词典整个换掉了，它守不住的正是这里要看的：真的牌组 + 真的常见词形表
// （public/dict/common-forms.json）一起筛完之后，满篇常用词真的都走掉了、剩下的是那几个少见词。
// 词形表漏部署或者判据写反，这一页会把 `Wald` `Menschen` 全列成「生词」—— 单测里看不出来。

import { expect, test } from '@playwright/test';
import { importBackup, importLesson, openApp } from './app';
import { MANUSCRIPT, timedLessonBackup, wavBytes } from './fixtures';

const TITLE = 'Alltagsdeutsch: Der deutsche Wald';

async function seedTimedLesson(page: import('@playwright/test').Page): Promise<string> {
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT, audio: wavBytes(30) });
  const lessonId = new URL(page.url()).hash.match(/#\/lesson\/([^/]+)\//)![1];
  await importBackup(page, timedLessonBackup(lessonId));
  await page.goto(`/#/lesson/${lessonId}/study`);
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  return lessonId;
}

test('候选只剩少见词；勾一个加进去，它就从候选里走掉、句子上多了挖空', async ({ page }) => {
  await seedTimedLesson(page);

  // 三句话里口语不常见的只有这三个（`Bäumen` `Herbst` `Menschen` 都在前一万的词形里）
  const section = page.locator('section', { hasText: '本课生词候选' });
  await expect(section.getByRole('heading')).toHaveText('本课生词候选（3）');
  const boxes = section.getByRole('checkbox');
  await expect(boxes).toHaveCount(3);
  const labels = await boxes.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(labels.sort()).toEqual(['Ansammlung', 'Erholung', 'färben']);

  await section.getByRole('checkbox', { name: 'Erholung' }).check();
  await section.getByRole('button', { name: '加入选中的 1 个' }).click();

  await expect(section.getByRole('heading')).toHaveText('本课生词候选（2）');
  await expect(section.getByText(/加进生词本 1 个/)).toBeVisible();
  // 挖空列表里有它，带着词典给的德语释义
  await expect(page.getByRole('button', { name: '取消挖空' })).toHaveCount(1);
});

test('正文里点一个词就加好，不弹确认；撤销之后挖空和词条都没了', async ({ page }) => {
  await seedTimedLesson(page);

  await page.locator('p.text-de span', { hasText: /^Ansammlung$/ }).click();
  await expect(page.getByText(/已加「Ansammlung」/)).toBeVisible();
  await expect(page.getByText('标记为生词并挖空')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消挖空' })).toHaveCount(1);

  await page.getByRole('button', { name: '撤销' }).click();
  await expect(page.getByRole('button', { name: '取消挖空' })).toHaveCount(0);
  // 词条也删了：它重新回到候选里
  await expect(page.locator('section', { hasText: '本课生词候选' }).getByRole('heading')).toHaveText('本课生词候选（3）');
});
