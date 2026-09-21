// §12.1「手机为什么放底部」与 §12.2「底部单浮层契约」。
//
// 两条都是**只在窄屏成立**的规定，桌面项目里一条都验不到：底部标签栏是 `sm:hidden`，
// 而 --bottom-inset 那套变量存在的全部理由是「别让浮层压住内容」，
// 在一块 1280 宽的屏幕上压不压得住看不出来。
//
// 这个 project 跑在 Pixel 7 上（config 里 testMatch 只挑 *.mobile.spec.ts）。
// 它不能替代 iPhone 真机复验（安全区、WKWebView 的行为都不一样，§10 那一条还留着），
// 但「标签栏在不在、留白够不够」这两件事它答得了。

import { expect, test } from '@playwright/test';
import { importLesson, openApp } from './app';
import { MANUSCRIPT } from './fixtures';

const inset = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    Number(
      getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset').replace('px', ''),
    ),
  );

test('底部标签栏：三个活动，拇指可达', async ({ page }) => {
  await openApp(page);

  const tabs = page.locator('nav.fixed.inset-x-0.bottom-0');
  await expect(tabs).toBeVisible();
  await expect(tabs.locator('a')).toHaveText(['课程', '复习', '生词本']);

  // §12.1 把热区从约 30px 提到 44px 就是这条规定的由来。
  for (const link of await tabs.locator('a').all()) {
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test('点底部标签真的换页，并且当前那个是高亮的', async ({ page }) => {
  await openApp(page);
  const tabs = page.locator('nav.fixed.inset-x-0.bottom-0');

  await tabs.getByRole('link', { name: '生词本' }).click();
  await expect(page).toHaveURL(/#\/vocab$/);
  await expect(tabs.locator('a[aria-current="page"]')).toHaveText('生词本');

  await tabs.getByRole('link', { name: '复习' }).click();
  await expect(page).toHaveURL(/#\/review$/);
});

test('详情页收起标签栏 —— 底部归音频条（§12.2：一次只有一层）', async ({ page }) => {
  await openApp(page);
  await importLesson(page, { title: 'Der deutsche Wald', text: MANUSCRIPT });

  await expect(page.locator('nav.fixed.inset-x-0.bottom-0')).toHaveCount(0);
  // 取而代之的是顶部那条回课程列表的路（「‹」是 aria-hidden，所以按可见性找）。
  await expect(page.locator('header a[href="#/lessons"]:visible')).toHaveText(/‹\s*课程/);

  await page.goto('/#/import');
  await expect(page.locator('nav.fixed.inset-x-0.bottom-0')).toHaveCount(0);
});

test('--bottom-inset 按实测高度算出来，页面内容不会被标签栏压住', async ({ page }) => {
  await openApp(page);

  // 标签栏在场时留白 > 0，且和它的实测高度一致 —— 这正是那个写死的 pb-24 换掉的东西。
  const tabsHeight = (await page.locator('nav.fixed.inset-x-0.bottom-0').boundingBox())!.height;
  expect(await inset(page)).toBeCloseTo(tabsHeight, 0);

  // 切到没有标签栏的详情页，留白跟着回到 0。
  await importLesson(page, { title: 'Der deutsche Wald', text: MANUSCRIPT });
  await expect(page.locator('nav.fixed.inset-x-0.bottom-0')).toHaveCount(0);
  expect(await inset(page)).toBe(0);
});

test('页面不横向滚动 —— 窄屏上出现横向滚动条就是有东西溢出了', async ({ page }) => {
  for (const hash of ['#/lessons', '#/vocab', '#/review', '#/record', '#/settings', '#/import']) {
    await page.goto(`/${hash}`);
    await expect(page.locator('main')).not.toBeEmpty();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, hash).toBeLessThanOrEqual(1);
  }
});

test('顶部在手机上只说「你在哪儿」，不再横排六项', async ({ page }) => {
  await openApp(page);
  // 桌面那排活动链接在窄屏是 hidden。
  await expect(page.locator('header nav')).toBeHidden();
  // 剩下的是那一行「你在哪儿」的标题。
  await expect(page.locator('header span.text-title.font-semibold')).toHaveText('课程');
});
