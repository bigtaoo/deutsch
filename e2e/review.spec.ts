// FR-10：复习。**手机上每天唯一会用的那一页**（§2.1），所以它值得一条真浏览器的路径。
//
// ReviewPage.test.tsx 已经在 jsdom 里把时序行为测过一遍（对错判定、评分落库、
// 答对自动跳、答错才亮卡背）。这里不重复那些，只补 jsdom 给不了的两件：
//   · 词典分档文件是**真的从 /dict/ 取回来的**（它随包走，离线也要能组题）；
//   · 评分**真的落了盘** —— 关掉页面再打开，那张卡不再到期。
//     这一条是整个应用最要命的数据（FSRS 状态不可重建），而 jsdom 里的
//     fake-indexeddb 每个用例都是新的，「关掉再打开」在那里问不出来。

import { expect, test } from '@playwright/test';
import { importBackup, openApp } from './app';
import { sampleBackup } from './fixtures';

/** 到期的两张卡都在 fixture 里，且都已经过了 due。 */
async function seed(page: import('@playwright/test').Page): Promise<void> {
  await openApp(page);
  await importBackup(page, sampleBackup());
}

test('空库时说清楚下一步，而不是一张空卡', async ({ page }) => {
  await openApp(page);
  await page.goto('/#/review');
  await expect(page.getByText('今天没有到期的卡片。')).toBeVisible();
  await expect(page.getByText(/可以在生词本页报名一档预置词库/)).toBeVisible();
});

test('导航上的角标就是今天到期几张', async ({ page }) => {
  await seed(page);
  await page.goto('/#/lessons');
  await expect(page.locator('header a[href="#/review"]').first()).toHaveText(/复习2/);
  // 首页上那一行入口也该出现。
  await expect(page.getByRole('link', { name: /2.*张卡今天到期/ })).toBeVisible();
});

test('一张卡：选项组得出来 + 一个「没听清」的出口（FR-10.8）', async ({ page }) => {
  await seed(page);
  await page.goto('/#/review');

  await expect(page.getByText('1 / 2')).toBeVisible();

  // 库里只有两个生词、没报名任何预置档，所以音近的候选凑不满四个 ——
  // choices.ts 的规则⑥说得很明白：**候选不够时给三个甚至两个，不要崩**。
  // 这里钉的就是那条：题照样出得来，而不是整个复习流程停在这张卡上。
  const choices = page.locator('.grid button');
  const count = await choices.count();
  expect(count).toBeGreaterThanOrEqual(2);
  expect(count).toBeLessThanOrEqual(4);

  // 四选一有 25% 瞎猜命中率 —— 没有这个出口，猜对会被记成 Good。
  await expect(page.getByRole('button', { name: '没听清 / 不认识' })).toBeVisible();
});

test('揭晓之后恰好一个选项是对的 —— 两个都对或一个都不对都是组题坏了', async ({ page }) => {
  await seed(page);
  await page.goto('/#/review');
  await expect(page.getByText('1 / 2')).toBeVisible();

  await page.getByRole('button', { name: '没听清 / 不认识' }).click();
  await expect(page.getByRole('button', { name: /继续/ })).toBeVisible();

  await expect(page.locator('.grid button.border-ok')).toHaveCount(1);
});

test('答错才亮卡背，答对直接进下一张', async ({ page }) => {
  await seed(page);
  await page.goto('/#/review');
  await expect(page.getByText('1 / 2')).toBeVisible();

  await page.getByRole('button', { name: '没听清 / 不认识' }).click();

  // 「不认识」= 答错：卡背亮出来，等人自己点继续。
  await expect(page.getByRole('button', { name: /继续/ })).toBeVisible();
  await expect(page.getByText('1 / 2')).toBeVisible();

  await page.getByRole('button', { name: /继续/ }).click();
  await expect(page.getByText('2 / 2')).toBeVisible();
});

test('一轮做完之后有明确的收尾，不是停在最后一张上', async ({ page }) => {
  await seed(page);
  await page.goto('/#/review');

  for (let i = 0; i < 2; i++) {
    await expect(page.getByText(`${i + 1} / 2`)).toBeVisible();
    await page.getByRole('button', { name: '没听清 / 不认识' }).click();
    await page.getByRole('button', { name: /继续/ }).click();
  }

  await expect(page.getByText('这一轮做完了。')).toBeVisible();
});

test('评分真的落了盘：刷新之后到期数变了，卡不会再来一遍', async ({ page }) => {
  await seed(page);
  await page.goto('/#/review');

  await expect(page.getByText('1 / 2')).toBeVisible();
  await page.getByRole('button', { name: '没听清 / 不认识' }).click();
  await page.getByRole('button', { name: /继续/ }).click();
  await expect(page.getByText('2 / 2')).toBeVisible();

  await page.reload();
  await page.goto('/#/lessons');
  // 评过的那张被推到了几分钟之后 —— 到期数从 2 掉到 1。
  await expect(page.locator('header a[href="#/review"]').first()).toHaveText(/复习1/);
});

test('生词本列出导入回来的两个词，并说得出它们出自哪一课', async ({ page }) => {
  await seed(page);
  await page.goto('/#/vocab');

  await expect(page.getByText('Ansammlung', { exact: true })).toBeVisible();
  await expect(page.getByText('聚集，集合')).toBeVisible();
  await expect(page.getByText('Erholung', { exact: true })).toBeVisible();
  await expect(page.getByText('休养，恢复')).toBeVisible();
});
