// FR-5.3 逐词高亮 —— 这一套只在真浏览器里验得到的那几件事。
//
// 起因是变更 58：当前词原来跟当前行**共用** `bg-warn-soft`，同色叠同色等于没画，
// 「哪个词在读」只剩一档字重可看，iPhone 上因此完全看不见。
// 组件测试能断言 class 名，但**断言不了这两个类最终算出来的颜色是不是同一个** ——
// 那要真的 CSS、真的层叠、真的深浅色令牌。这条正是这里存在的理由。
//
// 顺带守住另外两件 jsdom 给不了的：播放位置真的在推进（rAF + <audio> 的时钟），
// 以及「点一个词从那里开始播」真的跳到了那一句。

import { expect, test } from '@playwright/test';
import { importBackup, importLesson, openApp } from './app';
import { MANUSCRIPT, timedLessonBackup, wavBytes } from './fixtures';

const TITLE = 'Alltagsdeutsch: Der deutsche Wald';

/**
 * 种一课**既有音频、又有词级时间戳**的课，返回它的 id。
 *
 * 两步是因为这两样东西分属两层：音频在缓存层（只能靠 `<input type=file>` 进来），
 * 词级时间戳在标注层（只能靠备份进来）。先导入带 WAV 的一课拿到 id，
 * 再用一份 `updatedAt` 更新的备份把时间戳盖上去 —— 音频在缓存层，不受合并影响。
 */
async function seedTimedLesson(page: import('@playwright/test').Page): Promise<string> {
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT, audio: wavBytes(30) });
  const lessonId = new URL(page.url()).hash.match(/#\/lesson\/([^/]+)\//)![1];

  await importBackup(page, timedLessonBackup(lessonId));
  await page.goto(`/#/lesson/${lessonId}/listen`);
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  return lessonId;
}

/** 展开文本、播一下、等到真的有词亮起来，然后**立刻暂停** —— 暂停之后高亮停在原地，可以从容断言。 */
async function playUntilHighlighted(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '展开文本' }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('[data-active]')).toHaveCount(1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
}

test('播放时当前词真的高亮：它的底色算出来跟当前行不是同一个颜色（变更 58）', async ({ page }) => {
  await seedTimedLesson(page);
  await playUntilHighlighted(page);

  // 一次 evaluate 里取完，避免两次取样之间高亮又走了一个词。
  const seen = await page.evaluate(() => {
    const word = document.querySelector('[data-active]');
    const line = word?.closest('li');
    if (!word || !line) return null;
    return {
      text: word.textContent,
      wordBg: getComputedStyle(word).backgroundColor,
      lineBg: getComputedStyle(line).backgroundColor,
    };
  });

  expect(seen).not.toBeNull();
  expect(seen!.text?.trim().length).toBeGreaterThan(0);
  // 当前行自己得是「当前行」那一档（有底色，不是透明）
  expect(seen!.lineBg).not.toBe('rgba(0, 0, 0, 0)');
  // 而当前词的底色**不能等于**它 —— 同色就是变更 58 那个坏法
  expect(seen!.wordBg).not.toBe('rgba(0, 0, 0, 0)');
  expect(seen!.wordBg).not.toBe(seen!.lineBg);
});

test('点一个词从那一句开始播（FR-5.3）', async ({ page }) => {
  await seedTimedLesson(page);
  await page.getByRole('button', { name: '展开文本' }).click();

  // 第三句的 Herbst —— 挑一个离开头足够远的词，跳过去了才说明真的 seek 了。
  await page.getByText('Herbst', { exact: true }).click();

  // 先等**当前行**跳过去：seek 完成前 rAF 会先按旧位置（0 秒）画一帧，
  // 一次性取样会抓到第一句，所以这里要的是能轮询的断言。
  await expect(page.locator('li.bg-warn-soft')).toContainText('Im Herbst färben sich die Blätter');

  // 停下来再看词：暂停之后高亮不动，取样没有竞态。
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const lineText = await page.evaluate(
    () => document.querySelector('[data-active]')?.closest('li')?.textContent ?? null,
  );
  expect(lineText).toContain('Im Herbst färben sich die Blätter');
});

test('没有时间戳的课不假装高亮，而是说清楚为什么（FR-5.2）', async ({ page }) => {
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT, audio: wavBytes(2) });
  const lessonId = new URL(page.url()).hash.match(/#\/lesson\/([^/]+)\//)![1];

  await page.goto(`/#/lesson/${lessonId}/listen`);
  await page.getByRole('button', { name: '展开文本' }).click();
  await expect(page.getByText('这一课还没有时间戳')).toBeVisible();

  await page.getByRole('button', { name: '播放', exact: true }).click();
  // 播着也一个词都不亮 —— 伪同步是这一页明确不做的事
  await expect(page.locator('[data-active]')).toHaveCount(0);
});
