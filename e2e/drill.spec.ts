// FR-22 速背（变更 84：每天 200 个、一次背完、可以随时停）。DrillPage.test.tsx 已经在 jsdom 里测过时序；
// 这里补 jsdom 给不了的几件：
//   · 从单词页的今日卡片真的走得进去，在真浏览器里跑得起来；
//   · 停下来再回来，「今天 x / total」真的是落了盘的数（刷新也不丢）；
//   · 斩掉的词真的进了「斩掉的」，改过的中文刷新之后还在（FR-22.9）。

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
  // 词库拿不到时池子只剩备份里那 5 个手动词，今天的计划就是这 5 个。
  await page.route('**/v1/wordbank**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await openApp(page);
  await importBackup(page, drillBackup());
});

async function currentWord(page: import('@playwright/test').Page): Promise<string> {
  return (await page.locator('p.text-word').first().textContent())!.trim();
}

test('今日卡片 → 会话：四个中文选项、答错展开卡背；停下来回单词页，进度跟着走', async ({ page }) => {
  await page.goto('/#/vocab');
  const today = page.getByRole('region', { name: '今天' });
  await expect(today.getByText('0 / 5')).toBeVisible();
  await today.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page).toHaveURL(/#\/drill$/);

  await expect(page.getByText('0 / 5')).toBeVisible();
  const word = await currentWord(page);
  const choices = page.locator('.grid button');
  await expect(choices).toHaveCount(4);
  const texts = (await choices.allTextContents()).map((t) => t.replace(/^\d/, ''));
  expect(texts).toContain(ZH[word]);

  await page.getByRole('button', { name: '不认识' }).click();
  await expect(page.getByRole('button', { name: '☆ 标记' })).toBeVisible();
  await expect(page.getByText('1 / 5')).toBeVisible();

  await page.getByRole('button', { name: '先停在这里' }).click();
  await expect(page.getByText(/先停在这里，回来接着背。/)).toBeVisible();
  await page.getByRole('link', { name: '回单词页' }).click();

  // 落了盘：刷新之后今日卡片还是 1 / 5，按钮变「继续」
  await page.reload();
  await expect(today.getByText('1 / 5')).toBeVisible({ timeout: 15_000 });
  await expect(today.getByRole('button', { name: '继续' })).toBeVisible();
});

test('斩：计数加一、以后不再出，单词页「斩掉的」里能看到', async ({ page }) => {
  await page.goto('/#/drill');
  await expect(page.getByText('0 / 5')).toBeVisible();
  const word = await currentWord(page);
  await page.getByRole('button', { name: '斩', exact: true }).click();
  await expect(page.getByText('1 / 5')).toBeVisible();
  expect(await currentWord(page)).not.toBe(word);

  await page.goto('/#/vocab');
  await page.locator('summary', { hasText: /词库$/ }).click();
  await page.getByText('斩掉的（1）').click();
  await expect(page.getByText(word, { exact: false }).first()).toBeVisible();
});

test('标记后改中文，刷新之后还在（FR-22.9）', async ({ page }) => {
  await page.goto('/#/drill');
  const word = await currentWord(page);

  await page.getByRole('button', { name: '不认识' }).click();
  await page.getByRole('button', { name: '☆ 标记' }).click();
  const input = page.getByLabel('改正确答案的中文');
  await input.fill(`${ZH[word]}（改过）`);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已改，下次出题用这一版')).toBeVisible();
  // 正确项那一格立刻换成新中文
  await expect(page.locator('.grid button', { hasText: `${ZH[word]}（改过）` })).toBeVisible();

  await page.goto('/#/vocab');
  await page.reload();
  await page.locator('summary', { hasText: /词库$/ }).click();
  await page.getByText('已标记（1）').click();
  await expect(page.getByLabel(`${word} 的中文`)).toHaveValue(`${ZH[word]}（改过）`);
});
