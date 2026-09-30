// FR-22 速背。DrillPage.test.tsx 已经在 jsdom 里测过时序（答错展开、重做不评分、标记改中文）；
// 这里补 jsdom 给不了的两件：
//   · 从生词本页那块入口真的走得进去，一轮在真浏览器里跑得起来；
//   · 改过的中文**真的落了盘** —— 刷新之后「已标记」里还是改过的那一版。
//     改中文是一次人工判断，丢了就得再判一次（FR-22.9）。

import { expect, test } from '@playwright/test';
import { importBackup, openApp } from './app';
import { drillBackup } from './fixtures';

const ZH: Record<string, string> = {
  Kaution: '押金',
  Vermieter: '房东',
  Umzug: '搬家',
  Makler: '中介',
  Grundriss: '户型图',
};

test.beforeEach(async ({ page }) => {
  // 本机构建配了线上同步服务器：别真去拉六千个词，也别让测试结果取决于线上那一版。
  await page.route('**/v1/wordbank**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await openApp(page);
  await importBackup(page, drillBackup());
});

test('从生词本进速背，单词模式一轮：四个中文选项，答错展开卡背', async ({ page }) => {
  await page.goto('/#/vocab');
  await expect(page.getByText('快速背单词')).toBeVisible();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page).toHaveURL(/#\/drill$/);

  await expect(page.getByRole('button', { name: '我加的（5）' })).toBeVisible();
  await expect(page.getByText('这个模式里到期 0 · 还没学过 5')).toBeVisible();

  await page.getByRole('button', { name: '开始一轮' }).click();
  await expect(page.getByText('这个词是什么意思')).toBeVisible();
  await expect(page.getByText('1 / 5')).toBeVisible();

  const word = (await page.locator('p.text-word').textContent())!.trim();
  const choices = page.locator('.grid button');
  await expect(choices).toHaveCount(4);
  const texts = (await choices.allTextContents()).map((t) => t.replace(/^\d/, ''));
  expect(texts).toContain(ZH[word]);

  await page.getByRole('button', { name: '不认识' }).click();
  // 卡背：带冠词的词形 + 正确中文 + 标记；错题排回本轮，队列多了一张
  await expect(page.getByRole('button', { name: '☆ 标记' })).toBeVisible();
  await expect(page.getByText('1 / 6')).toBeVisible();
  await expect(page.getByText('本轮错 1')).toBeVisible();
});

test('标记后改中文，刷新之后还在（FR-22.9）', async ({ page }) => {
  await page.goto('/#/drill');
  await page.getByRole('button', { name: '开始一轮' }).click();
  const word = (await page.locator('p.text-word').textContent())!.trim();

  await page.getByRole('button', { name: '不认识' }).click();
  await page.getByRole('button', { name: '☆ 标记' }).click();
  const input = page.getByLabel('改正确答案的中文');
  await input.fill(`${ZH[word]}（改过）`);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已改，下次出题用这一版')).toBeVisible();
  // 正确项那一格立刻换成新中文
  await expect(page.locator('.grid button', { hasText: `${ZH[word]}（改过）` })).toBeVisible();

  await page.reload();
  await expect(page.getByText('加载中…')).toHaveCount(0, { timeout: 15_000 });
  await page.getByText('已标记（1）').click();
  await expect(page.getByLabel(`${word} 的中文`)).toHaveValue(`${ZH[word]}（改过）`);
  // 答过的那一个词在这个模式里不再是「没学过」
  await expect(page.getByText('这个模式里到期 0 · 还没学过 4')).toBeVisible();
});
