// §12.25 主题四档 —— 只有真浏览器里才验得到的那几件事。
//
// 起因是变更 90：系统已经是深色了，晚上关了灯还是刺眼。单测（src/theme.test.ts）
// 读 CSS 原文算对比度，守得住「夜间的色值确实更暗」；但它**算不出页面真正用的是哪一套** ——
// 那要真的层叠、真的 `data-theme`、真的刷新一次。这条正是这里存在的理由。
//
// 另外两件 jsdom 永远给不了的：内联脚本在 React 之前就把属性写好了（冷启动不闪白），
// 以及系统外观中途变了页面跟着换（iOS 的「自动」外观、日落）。

import { expect, test, type Page } from '@playwright/test';
import { openApp } from './app';

/** 页面真正算出来的底色（body 的 `--color-surface`），拆成 0~255 三通道。 */
async function bodyRgb(page: Page): Promise<[number, number, number]> {
  const css = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const m = css.match(/(\d+),\s*(\d+),\s*(\d+)/);
  expect(m, `底色解析不出来：${css}`).toBeTruthy();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

/** WCAG 相对亮度。和 src/theme.test.ts 同一套公式，这里喂的是**算出来的**颜色。 */
function luminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

const themeAttr = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'));

const statusBarColor = (page: Page) =>
  page.evaluate(() => document.getElementById('theme-color')?.getAttribute('content') ?? null);

test('四档各自真的改了整页底色，夜间确实比深色暗一档（§12.25）', async ({ page }) => {
  await openApp(page);
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: '外观' })).toBeVisible();

  await page.getByRole('button', { name: '浅色', exact: true }).click();
  expect(await themeAttr(page)).toBe('light');
  const light = luminance(await bodyRgb(page));

  await page.getByRole('button', { name: '深色', exact: true }).click();
  expect(await themeAttr(page)).toBe('dark');
  const dark = luminance(await bodyRgb(page));

  await page.getByRole('button', { name: '夜间', exact: true }).click();
  expect(await themeAttr(page)).toBe('night');
  const night = luminance(await bodyRgb(page));

  // 浅色远亮于深色；而夜间要**明显**比深色更暗 —— 这一档的全部理由就是这个数。
  expect(light).toBeGreaterThan(0.5);
  expect(dark).toBeLessThan(0.05);
  expect(night).toBeLessThan(dark * 0.6);

  // 状态栏跟着走：浅蓝的状态栏压在近黑的页面上是两个调子。
  expect(await statusBarColor(page)).toBe('#0b0b0a');

  // 选择落在本机，刷新还在（它不走 Settings，因而也不同步 —— 见 src/app/theme.ts）
  await page.reload();
  expect(await themeAttr(page)).toBe('night');
  expect(luminance(await bodyRgb(page))).toBeCloseTo(night, 5);
  await expect(page.getByRole('button', { name: '夜间', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('夜间在 <body> 存在之前就写好了 —— 冷启动不会先闪一屏浅色（§12.25）', async ({ page }) => {
  await openApp(page);
  await page.goto('/#/settings');
  await page.getByRole('button', { name: '夜间', exact: true }).click();
  expect(await themeAttr(page)).toBe('night');

  // 下一次冷启动时盯住 `data-theme` **第一次**被写上去的那一刻，记下当时 <body> 在不在。
  //
  // 这是「会不会闪白」这件事唯一干净的判据：index.html 里那段脚本在 <head> 里同步跑，
  // 那时解析器还没走到 <body>，所以 `document.body` 必然是 null；一旦有人把这件事挪进
  // main.tsx（模块脚本，body 早就有了），这条就会红 —— 而那正是夜间用户每次冷启动
  // 被闪一屏浅色的那个坏法。
  //
  // 观察器装在 addInitScript 里：它比页面上任何脚本都先跑，包括那段内联的。
  await page.addInitScript(() => {
    const w = window as unknown as { __firstTheme?: { value: string | null; bodyExists: boolean } };
    new MutationObserver((records, observer) => {
      for (const r of records) {
        if (r.attributeName !== 'data-theme') continue;
        w.__firstTheme = {
          value: document.documentElement.getAttribute('data-theme'),
          bodyExists: !!document.body,
        };
        observer.disconnect();
        return;
      }
      // 盯 `document` 而不是 `document.documentElement`：初始化脚本跑得比 <html> 还早，
      // 那时候 documentElement 还是 null（第二版用例就是这么静默失效的）。
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-theme'] });
  });
  // 必须是**整页重新加载**：`goto('/')` 从 `#/settings` 过去只改了 hash，同一个文档，
  // 内联脚本根本不会再跑一遍（第一版用例就是这么红的）。
  await page.reload();

  const first = await page.evaluate(
    () => (window as unknown as { __firstTheme?: { value: string; bodyExists: boolean } }).__firstTheme ?? null,
  );
  expect(first, '整次加载里没人写过 data-theme —— 内联脚本没跑').not.toBeNull();
  expect(first!.value).toBe('night');
  expect(first!.bodyExists, '写属性的时候 <body> 已经在了 —— 这一下晚于首次绘制').toBe(false);

  expect(await statusBarColor(page)).toBe('#0b0b0a');
  expect(luminance(await bodyRgb(page))).toBeLessThan(0.005);
});

test('「跟随系统」跟着系统外观走；手动选了一档之后就不再跟（§12.25）', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page);
  // 默认就是「跟随系统」：没人选过的时候系统说深色就深色
  expect(await themeAttr(page)).toBe('dark');

  // 系统外观**中途**变了也要跟上（iOS 的「自动」外观、日落），不必刷新页面 ——
  // 这一条守的是 main.tsx 里那个 watchSystemTheme。
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => themeAttr(page)).toBe('light');

  // 手动选了夜间之后，太阳出来也不该把人切回浅色
  await page.goto('/#/settings');
  await page.getByRole('button', { name: '夜间', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await themeAttr(page)).toBe('night');
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await themeAttr(page)).toBe('night');

  // 选回「跟随系统」就该立刻重新听系统的
  await page.getByRole('button', { name: '跟随系统', exact: true }).click();
  expect(await themeAttr(page)).toBe('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => themeAttr(page)).toBe('dark');
});
