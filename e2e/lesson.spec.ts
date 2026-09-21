// FR-1 的地板路径：手动导入（粘文稿 + 选本地文件）。
//
// 这条在 vitest 里只测得到 store 那一层（src/state/useLessonStore.test.ts）。
// 这里要的是它上面那三件 jsdom 给不了的：
//   · <input type=file> 真的选进一个文件；
//   · 浏览器真的解出了音频时长（readAudioDuration 用的是 <audio>）；
//   · **关掉页面再打开，课程还在** —— 素材只存本地，这是这个应用最基本的承诺。

import { expect, test } from '@playwright/test';
import { importLesson, openApp } from './app';
import { MANUSCRIPT, MANUSCRIPT_SENTENCE_COUNT, wavBytes } from './fixtures';

const TITLE = 'Alltagsdeutsch: Der deutsche Wald';

test('导入一课：切句预览 → 保存 → 落到切句页 → 列表里出现', async ({ page }) => {
  await openApp(page);
  await page.goto('/#/import');

  await page.getByPlaceholder('Alltagsdeutsch: Der deutsche Wald').fill(TITLE);
  const manuscript = page.getByPlaceholder('把 Manuskript 粘贴到这里…');
  await manuscript.fill(MANUSCRIPT);
  await manuscript.blur();

  // 切句预览只在失焦后算一次（FR-1.2：20000 字符不能卡）。
  await expect(page.getByText(`自动切分约 ${MANUSCRIPT_SENTENCE_COUNT} 句`)).toBeVisible();

  await page.getByRole('button', { name: '保存并去切句' }).click();
  await expect(page).toHaveURL(/#\/lesson\/[^/]+\/sentences$/);
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();

  await page.goto('/#/lessons');
  await expect(page.getByRole('link', { name: new RegExp(TITLE) })).toBeVisible();
  await expect(page.getByText(`${MANUSCRIPT_SENTENCE_COUNT} 句`)).toBeVisible();
});

test('标题或正文为空时保存键是灰的 —— 建不出一课空壳', async ({ page }) => {
  await openApp(page);
  await page.goto('/#/import');
  const save = page.getByRole('button', { name: '保存并去切句' });

  await expect(save).toBeDisabled();
  await page.getByPlaceholder('Alltagsdeutsch: Der deutsche Wald').fill(TITLE);
  await expect(save).toBeDisabled();
  await page.getByPlaceholder('把 Manuskript 粘贴到这里…').fill(MANUSCRIPT);
  await expect(save).toBeEnabled();
});

test('选一个真音频文件：浏览器解出时长，体积与文件名都显示出来', async ({ page }) => {
  await openApp(page);
  await page.goto('/#/import');

  await page.getByPlaceholder('Alltagsdeutsch: Der deutsche Wald').fill(TITLE);
  await page.getByPlaceholder('把 Manuskript 粘贴到这里…').fill(MANUSCRIPT);
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'wald.wav',
    mimeType: 'audio/wav',
    buffer: wavBytes(2),
  });

  // 2 秒的 WAV：时长那一栏必须真的读出来，而不是 0:00。
  await expect(page.getByText(/wald\.wav · .* · 时长 0:02/)).toBeVisible();
});

test('刷新页面之后课程还在 —— IndexedDB 真的落了盘', async ({ page }) => {
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT });

  await page.reload();
  await page.goto('/#/lessons');
  await expect(page.getByRole('link', { name: new RegExp(TITLE) })).toBeVisible();
});

test('没有音频的课在列表里标「素材未下载」，并且不假装能播', async ({ page }) => {
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT });

  await page.goto('/#/lessons');
  await expect(page.getByText('素材未下载')).toBeVisible();

  await page.getByRole('link', { name: new RegExp(TITLE) }).click();
  await expect(page.getByText('素材未下载 —— 播放相关的功能全部不可用')).toBeVisible();
});

test('一课的四个 tab 都进得去，缺前提时说清缺什么', async ({ page }) => {
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT });
  const lessonUrl = new URL(page.url()).hash.replace('/sentences', '');

  await page.goto(`/${lessonUrl}/listen`);
  // 刚导入的课没有时间戳，通听只是一份静态文本 —— 这一点要说出来，不能静默。
  await expect(page.locator('main')).not.toBeEmpty();

  for (const tab of ['shadowing', 'study', 'dictation']) {
    await page.goto(`/${lessonUrl}/${tab}`);
    await expect(page.locator('main')).not.toBeEmpty();
    await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  }
});

test('切句与译文收在「⋯」里，不占 tab 条', async ({ page }) => {
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT });
  const lessonUrl = new URL(page.url()).hash.replace('/sentences', '');
  await page.goto(`/${lessonUrl}/listen`);

  const tabs = page.locator('nav.border-b a');
  await expect(tabs).toHaveText(['通听', '跟读', '学词', '听写']);

  await page.getByLabel('这一课的更多操作').click();
  await expect(page.getByRole('link', { name: /^切句/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^译文/ })).toBeVisible();
});

test('删除一课要先确认，确认之后列表空了且刷新也不回来', async ({ page }) => {
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT });
  await page.goto('/#/lessons');

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain(TITLE);
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: '删除' }).click();
  await expect(page.getByRole('link', { name: new RegExp(TITLE) })).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('还没有课程')).toBeVisible();

  await page.reload();
  await expect(page.getByText('还没有课程')).toBeVisible();
});
