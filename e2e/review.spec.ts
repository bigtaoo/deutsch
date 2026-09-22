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
import { readCardBackup, sampleBackup } from './fixtures';

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

// ── FR-21：识词卡（读卡）─────────────────────────────────────────
//
// 这条路在 jsdom 里测不到的那一半是**「打开是不是一张空卡」**：读卡的题面是
// `Question.prompt`，它由组题函数算出来，而组题要真的去 /dict/ 取牌组文件。
// 题面没渲染出来的症状不是报错，是一张只有四个选项、没有题目的卡。

test('读卡：题面是文字、卡上没有播放键（FR-21.5）', async ({ page }) => {
  await openApp(page);
  await importBackup(page, readCardBackup());
  await page.goto('/#/review');

  // 队列里两张读卡，复习状态的那张（cloze）排在前面
  await expect(page.getByText('1 / 2')).toBeVisible();
  await expect(page.getByText('哪个词填得进这个空')).toBeVisible();
  // 挖空句真的挖了：定宽的空在、原词不在（FR-21.8）
  await expect(page.getByText(/Der _+ fiel nach dem letzten Akt\./)).toBeVisible();
  // 读卡不放声音 —— 播放键出现就说明走错了分支
  await expect(page.getByRole('button', { name: '播放' })).toHaveCount(0);
});

test('读卡的下一张考「看词形选释义」，题面就是那个词', async ({ page }) => {
  await openApp(page);
  await importBackup(page, readCardBackup());
  await page.goto('/#/review');

  await page.getByRole('button', { name: '不认识', exact: true }).click();
  await page.getByRole('button', { name: /继续/ }).click();

  await expect(page.getByText('2 / 2')).toBeVisible();
  await expect(page.getByText('这个词是什么意思')).toBeVisible();
  await expect(page.getByText('Zuversicht', { exact: true })).toBeVisible();
});

test('读卡的评分落在读卡上 —— 听卡的下次时间不该被动过', async ({ page }) => {
  await openApp(page);
  await importBackup(page, readCardBackup());

  // 先记下听卡的到期日（生词本行上「听 复习中 · 日期」那一段）
  await page.goto('/#/vocab');
  const before = await page.getByText(/听 复习中 · /).first().textContent();

  await page.goto('/#/review');
  await page.getByRole('button', { name: '不认识', exact: true }).click();
  await page.getByRole('button', { name: /继续/ }).click();

  await page.goto('/#/vocab');
  await expect(page.getByText(/听 复习中 · /).first()).toHaveText(before ?? '');
  // 读卡那一半确实动了：答错之后它今天还会再来一次，所以列表上仍然有「读 …」
  await expect(page.getByText(/读 /).first()).toBeVisible();
});

// ── FR-9.11 / FR-9.12：问 AI 补解释 ──────────────────────────────
//
// jsdom 问不出来的那一半是**「解释真的落了盘没有」**：粘回来的那一段是
// 不可重建的数据（它来自一次外部会话，关掉就没了），而 `updateEntries`
// 写完之后界面上立刻就变了 —— 「界面变了」和「库里写了」在 jsdom 的
// fake-indexeddb 里分不出来，每个用例都是一个新库。

test('标记一个词 → 那一块出现；粘回解释 → 刷新之后还在（FR-9.12）', async ({ page }) => {
  await seed(page);
  await page.goto('/#/vocab');

  // fixture 里的词都有释义，所以待办一开始是空的 —— 这一块整个不出现（§12.16）。
  await expect(page.getByText(/问 AI 补解释/)).toHaveCount(0);

  // 标记 `Ansammlung` 那一行。
  const row = page.locator('li', { hasText: 'Ansammlung' }).last();
  await row.getByRole('button', { name: '问 AI' }).click();
  await expect(row.getByRole('button', { name: /已标记/ })).toBeVisible();

  const panel = page.locator('details', { hasText: '问 AI 补解释' });
  await expect(panel).toContainText('1 个词等着');
  await panel.locator('summary').click();

  await panel.locator('textarea').last().fill('1. 聚集：一群人或物凑到一处，偏中性。\n搭配：eine Ansammlung von Menschen。');
  // 对照预览是保存前最后一道人眼关卡（§12.16）：编号对着的必须是那个词。
  await expect(panel.locator('li')).toContainText('Ansammlung');
  await panel.getByRole('button', { name: /保存这 1 条/ }).click();

  // 写进去之后这个词就不再等着了 —— **整块消失**（§12.16：没有待办就不出现），
  // 所以「写入 1 条」那句提示也跟着走了。这不是漏了提示：结果就在上面那一行里，
  // 而 ZhPanel 是同一个行为，双胞胎不该在这一点上分家。
  await expect(page.getByText(/问 AI 补解释/)).toHaveCount(0);
  await expect(page.getByText(/eine Ansammlung von Menschen/)).toBeVisible();

  await page.reload();
  await page.goto('/#/vocab');
  await expect(page.getByText(/问 AI 补解释/)).toHaveCount(0);
  // 而解释本身活过了一次真正的刷新（真 IndexedDB，不是内存里的 store）。
  await expect(page.getByText(/eine Ansammlung von Menschen/)).toBeVisible();
});

test('查不到的词照样收得下，并且自己排进待办（FR-9.6）', async ({ page }) => {
  // 走 seed 而不是空库：fixture 的设置里 `onlineDictFallback: false`，
  // 于是这条用例**一次网络都不发** —— 门禁里一条会去问 de.wiktionary 的用例，
  // 迟早会因为对方慢一次而变红，而那和这里要守的东西毫无关系。
  await seed(page);
  await page.goto('/#/vocab');

  // 内置词典里没有这个编出来的复合词；联网查默认关着（fixture 里 onlineDictFallback: false）,
  // 所以这一步不碰网络。
  await page.getByPlaceholder(/课上碰到的词/).fill('Vorabendprogrammgestaltung');
  await page.getByRole('button', { name: '查', exact: true }).click();
  await expect(page.getByText(/没查到/)).toBeVisible();

  // 这个按钮曾经是个死按钮：`add()` 第一行看 `result`，而查不到时它是 null，
  // 于是按下去什么都不发生 —— 看起来就像这个词只能丢掉。
  await page.getByRole('button', { name: '加入生词本' }).click();
  await expect(page.getByText(/已加进生词本/)).toBeVisible();

  const panel = page.locator('details', { hasText: '问 AI 补解释' });
  await expect(panel).toContainText('1 个词等着');
});
