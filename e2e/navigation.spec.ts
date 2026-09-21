// SPEC §12.1 的导航契约，以及 hash 路由在真浏览器里的行为。
//
// 单测已经从 useRoute 那一侧验过解析（src/app/router.test.ts）。这里补的是
// jsdom 里问不出来的那半边：**地址栏里粘一个链接进去，页面真的是那一页吗**，
// 以及浏览器的前进/后退按钮 —— 后者在 Android 壳里就是硬件返回键（§7.10）。

import { expect, test } from '@playwright/test';
import { openApp, openDrawerPage } from './app';

test('全新安装：空态说清楚下一步做什么，而不是一片空白', async ({ page }) => {
  await openApp(page);
  await expect(page.getByText('还没有课程')).toBeVisible();
  await expect(page.getByRole('button', { name: '手动导入' })).toBeVisible();
  await expect(page.getByRole('button', { name: '从 DW 导入' })).toBeVisible();
});

test('空库上不提醒备份 —— 那时还没有任何东西可丢', async ({ page }) => {
  await openApp(page);
  await expect(page.getByText(/手动导出/)).toHaveCount(0);
});

test('三个活动直接可达，四个管道页收在抽屉里', async ({ page }) => {
  await openApp(page);

  for (const [label, hash] of [
    ['课程', '#/lessons'],
    ['复习', '#/review'],
    ['生词本', '#/vocab'],
  ] as const) {
    await expect(page.locator(`header a[href="${hash}"]`).first()).toHaveText(new RegExp(label));
  }

  await page.getByLabel('更多').click();
  for (const label of ['来源', '素材', '记录', '设置']) {
    await expect(page.getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
});

test('抽屉里每一页都真的打得开', async ({ page }) => {
  for (const [label, hash] of [
    ['来源', '#/sources'],
    ['素材', '#/cache'],
    ['记录', '#/record'],
    ['设置', '#/settings'],
  ] as const) {
    await openApp(page);
    await openDrawerPage(page, label);
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    // 打开了但报错、白屏都算没打开 —— 所以要求页面上真的有内容。
    await expect(page.locator('main')).not.toBeEmpty();
  }
});

test('深链接：地址栏直接粘进去就是那一页', async ({ page }) => {
  for (const hash of ['#/vocab', '#/review', '#/record', '#/settings', '#/cache', '#/sources']) {
    await page.goto(`/${hash}`);
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    await expect(page.locator('main')).not.toBeEmpty();
  }
});

test('认不出的地址退回课程列表，而不是白屏', async ({ page }) => {
  await page.goto('/#/keine-ahnung');
  await expect(page.getByText('还没有课程')).toBeVisible();
});

test('前进后退按钮走的是同一条 hash 历史（Android 的硬件返回键靠它）', async ({ page }) => {
  await openApp(page);
  await page.goto('/#/vocab');
  await page.goto('/#/review');

  await page.goBack();
  await expect(page).toHaveURL(/#\/vocab$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/lessons$|\/$/);
  await page.goForward();
  await expect(page).toHaveURL(/#\/vocab$/);
});

test('桌面宽度下不画底部标签栏（§12.2：底部一次只有一层）', async ({ page }) => {
  await openApp(page);
  // sm:hidden —— 桌面上它在 DOM 里但不可见。
  await expect(page.locator('nav.fixed.inset-x-0.bottom-0')).toBeHidden();
});

test('控制台里没有报错 —— 白屏之前先是一条红字', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await openApp(page);
  await page.goto('/#/vocab');
  await page.goto('/#/review');
  await page.goto('/#/record');
  await page.goto('/#/settings');

  expect(errors).toEqual([]);
});
