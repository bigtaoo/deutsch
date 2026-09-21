// FR-11.11 / FR-11.14：手动导出与导入。
//
// §2.6.5 说得很直白：**恢复路径是最容易悄悄坏掉的那条** —— 平时没人走，
// 等真需要时才发现它早就不通了。sync/restore.test.ts 已经在纯逻辑那一层把合并规则
// 钉住了，而这里补的是那一层之外的全部：`a[download]` 真的落了一个文件、
// 文件里真的是那份 JSON、`<input type=file>` 真的读得回来、导入之后界面真的变了。
//
// 「导入前自动先导出一份防呆备份」也在这里 —— 它是一次**没有按钮的下载**，
// 只有在真浏览器里才看得见它到底有没有发生。

import { expect, test, type Download } from '@playwright/test';
import { importBackup, importLesson, openApp } from './app';
import { MANUSCRIPT, sampleBackup } from './fixtures';
import type { BackupFile } from '../src/backup/types';

async function readJson(download: Download): Promise<BackupFile> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as BackupFile;
}

test('导出：文件名按日期、内容是标注层全部、缓存层零字节', async ({ page }) => {
  await openApp(page);
  await importLesson(page, { title: 'Der deutsche Wald', text: MANUSCRIPT });

  await page.goto('/#/settings');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出备份 JSON' }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^backup-\d{4}-\d{2}-\d{2}\.json$/);

  const backup = await readJson(download);
  expect(backup.formatVersion).toBe(1);
  expect(backup._warning).toContain('Do not share');
  expect(backup.lessons).toHaveLength(1);
  expect(backup.lessons[0].title).toBe('Der deutsche Wald');
  expect(backup.lessons[0].sentences.length).toBeGreaterThan(0);
  // 缓存层一个字节都不该在里面（§2.3）。
  expect(JSON.stringify(backup)).not.toContain('plainText');
  expect(JSON.stringify(backup)).not.toContain('manuscriptHtml');

  await expect(page.getByText(/已导出 1 课/)).toBeVisible();
});

test('导入：先自动落一份防呆备份，再给合并预览，确认之后数据才进库', async ({ page, context }) => {
  await openApp(page);

  await page.goto('/#/settings');
  const safety = page.waitForEvent('download');
  await page.locator('input[type="file"][accept="application/json"]').setInputFiles({
    name: 'backup-e2e.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(sampleBackup())),
  });

  // FR-11.14：这一次下载没有按钮，是导入流程自己触发的。
  expect((await safety).suggestedFilename()).toMatch(/^before-import-backup-/);

  await expect(page.getByText('确认这次合并')).toBeVisible();
  await expect(page.getByText('新增课程 1')).toBeVisible();
  await expect(page.getByText('新增生词 2')).toBeVisible();

  // 确认之前不该已经进库。**另开一页去看**，不能在这一页跳走 ——
  // 合并预览是组件状态，切走就没了，再回来那个「确认导入」按钮已经不在。
  // 同一个 context 共享 IndexedDB，所以另一页看到的就是库里的真实状态。
  const peek = await context.newPage();
  await peek.goto('/#/lessons');
  await expect(peek.getByText('还没有课程')).toBeVisible();
  await peek.close();

  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.getByText('确认这次合并')).toHaveCount(0);

  // 点完就该看得到，不用刷新页面。
  await page.goto('/#/lessons');
  await expect(page.getByRole('link', { name: /Der deutsche Wald/ })).toBeVisible();
  await page.goto('/#/vocab');
  await expect(page.getByText('Ansammlung', { exact: true })).toBeVisible();
  await expect(page.getByText('Erholung', { exact: true })).toBeVisible();
});

test('导入回来的课带着时间戳与挖空 —— 听写因此立刻可用', async ({ page }) => {
  await openApp(page);
  await importBackup(page, sampleBackup());

  await page.goto('/#/lesson/e2e-lesson-1/dictation');
  await expect(page.getByRole('heading', { name: /Der deutsche Wald/ })).toBeVisible();
  // 「需要有时间戳 + 有挖空的句子」那句话不该出现 —— fixture 里两样都有。
  await expect(page.getByText('去「学词」标几个词')).toHaveCount(0);
});

test('导入一份坏 JSON：给一条看得懂的报错，不动已有数据', async ({ page }) => {
  await openApp(page);
  await importLesson(page, { title: '本来就有的一课', text: MANUSCRIPT });

  await page.goto('/#/settings');
  await page.locator('input[type="file"][accept="application/json"]').setInputFiles({
    name: 'kaputt.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ das ist kein JSON'),
  });

  await expect(page.getByText('这个备份文件读不出来')).toBeVisible();
  await expect(page.getByText('确认这次合并')).toHaveCount(0);

  await page.goto('/#/lessons');
  await expect(page.getByRole('link', { name: /本来就有的一课/ })).toBeVisible();
});

test('往返：导出 → 清空 → 导入，课程与生词都回来了', async ({ page }) => {
  await openApp(page);
  await importBackup(page, sampleBackup());

  await page.goto('/#/settings');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出备份 JSON' }).click(),
  ]);
  const exported = await readJson(download);

  // 清空：删掉那一课（生词跟着课走，留在库里正好能验合并不是「清空后覆盖」）。
  await page.goto('/#/lessons');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('还没有课程')).toBeVisible();

  await importBackup(page, exported);

  await page.goto('/#/lessons');
  await expect(page.getByRole('link', { name: /Der deutsche Wald/ })).toBeVisible();
  await page.goto('/#/vocab');
  await expect(page.getByText('Ansammlung', { exact: true })).toBeVisible();
});

test('本机更新的那一份不被旧备份覆盖（§2.4 的合并规则）', async ({ page }) => {
  await openApp(page);
  await importBackup(page, sampleBackup());

  // 本机改一下标题 —— 走切句页之外最短的一条：改完 updatedAt 一定比备份新。
  await page.goto('/#/lesson/e2e-lesson-1/sentences');
  await expect(page.getByRole('heading', { name: /Der deutsche Wald/ })).toBeVisible();

  // 拿一份 updatedAt 更老的备份再导一次。
  const older = sampleBackup(Date.now() - 10 * 86_400_000);
  older.lessons[0].title = '这个标题不该赢';
  await importBackup(page, older);

  await page.goto('/#/lessons');
  await expect(page.getByRole('link', { name: /Der deutsche Wald/ })).toBeVisible();
  await expect(page.getByText('这个标题不该赢')).toHaveCount(0);
});
