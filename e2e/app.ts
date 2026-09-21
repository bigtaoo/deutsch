// E2E 的公共动作。**只走界面** —— 不用 page.evaluate 直接写 IndexedDB：
// 那会绕过被测代码，而「种数据」这件事本身就有一条用户路径（导入备份，FR-11.14），
// 用它既把数据种好了，也顺手验了那条路。

import { expect, type Page } from '@playwright/test';
import type { BackupFile } from '../src/backup/types';

/**
 * 打开应用并等它真的起来。
 *
 * 等的是「课程列表读完了」而不是 DOM 就绪：App 启动时四张表各读一次 IndexedDB，
 * 在那之前页面上只有一个「加载中…」，这时候点什么都点不着。
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText('加载中…')).toHaveCount(0, { timeout: 15_000 });
}

/** 走顶部抽屉去一个管道页（来源 / 素材 / 记录 / 设置）。 */
export async function openDrawerPage(page: Page, label: string): Promise<void> {
  await page.getByLabel('更多').click();
  await page.getByRole('link', { name: new RegExp(`^${label}`) }).click();
}

/**
 * 通过设置页的「选一份备份 JSON 导入…」种数据。
 *
 * 这条路上会先自动下一份防呆备份（FR-11.14），所以调用方的 context 必须允许下载 ——
 * playwright.config.ts 里 acceptDownloads 是开着的。
 */
export async function importBackup(page: Page, backup: BackupFile): Promise<void> {
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: '手动导出与导入' })).toBeVisible();

  await page.locator('input[type="file"][accept="application/json"]').setInputFiles({
    name: 'backup-e2e.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });

  await expect(page.getByText('确认这次合并')).toBeVisible();
  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.getByText('确认这次合并')).toHaveCount(0);
}

/** 手动导入一课。`audio` 给了就顺带绑一个本地音频文件。 */
export async function importLesson(
  page: Page,
  { title, text, audio }: { title: string; text: string; audio?: Buffer },
): Promise<void> {
  await page.goto('/#/import');
  await page.getByPlaceholder('Alltagsdeutsch: Der deutsche Wald').fill(title);
  await page.getByPlaceholder('把 Manuskript 粘贴到这里…').fill(text);
  // 切句预览挂在失焦上（20000 字符不能卡），所以这里要真的挪开焦点。
  await page.getByPlaceholder('把 Manuskript 粘贴到这里…').blur();

  if (audio) {
    await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
      name: 'wald.wav',
      mimeType: 'audio/wav',
      buffer: audio,
    });
    await expect(page.getByText(/wald\.wav/)).toBeVisible();
  }

  await page.getByRole('button', { name: '保存并去切句' }).click();
  await expect(page).toHaveURL(/#\/lesson\/[^/]+\/sentences$/);
}
