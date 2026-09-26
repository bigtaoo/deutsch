// FR-1.6 ~ FR-1.9 / FR-3.6a：教材导入（2026-09-26）。
//
// jsdom 给不了的三件事在这里验：
//   · `<input type=file multiple>` 真的一次选进好几轨；
//   · 几轨 WAV 真的被浏览器解码、拼成一个音频，时长是加起来的（WAV 兜底那条路，要 Web Audio）；
//   · 换设备之后一次选齐整组音频，同步来的时间戳**不被重对**（那个 bug 本身）。

import { expect, test } from '@playwright/test';
import { importBackup, openApp } from './app';
import { wavBytes } from './fixtures';
import type { BackupFile } from '../src/backup/types';
import type { Sentence } from '../src/types/models';

/** 照 Aspekte neu C1 Transkript 的版式（不是内容）：硬换行、行尾连字符、页码、页边音轨号、说话人符号。 */
const TRANSCRIPT = [
  'Transkript zum Lehrbuch',
  'Kapitel 1 Alltägliches',
  'Modul 2 Aufgabe 2a',
  ' ●  Hallo, seid wieder einmal herzlich ',
  'willkommen bei uns.',
  ' ○  Ja, genau. Das Gemeinschafts-',
  'leben ist schön.',
  '1.2',
  '1.3',
  '2',
  'Modul 4 Aufgabe 2c',
  ' ●  Gibt es goldene Regeln?',
  ' ○  Ja, kann man sagen.',
  'Kapitel 2 Hast du Worte?',
  'Auftakt Aufgabe 2a',
  ' ●  Kennt ihr den?',
].join('\n');

const wav = (name: string) => ({ name, mimeType: 'audio/wav', buffer: wavBytes(2) });

test('整份文稿按题导入：勾一章、一题两轨、拼成一个音频、说话人从正文里拿掉', async ({ page }) => {
  await openApp(page);
  await page.goto('/#/import-book');

  await page.getByPlaceholder('Aspekte neu C1').fill('Aspekte neu C1');
  const box = page.getByPlaceholder('把整份 Transkript 粘贴到这里…');
  await box.fill(TRANSCRIPT);
  await box.blur();
  await expect(page.getByText('2 章 · 3 题')).toBeVisible();

  // 说话人符号默认勾上
  await expect(page.getByRole('checkbox', { name: /●/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /○/ })).toBeChecked();

  await page.getByRole('checkbox', { name: 'Kapitel 1 Alltägliches' }).check();
  await page.getByRole('button', { name: '多一轨' }).first().click();
  await expect(page.getByText('2 轨')).toBeVisible();

  await page
    .locator('input[type="file"][accept="audio/*"]')
    .setInputFiles([wav('1_04.wav'), wav('1_02.wav'), wav('1_03.wav')]); // 选的顺序乱，按文件名排
  await expect(page.getByText('1_02.wav、1_03.wav')).toBeVisible();
  await expect(page.getByText('1_04.wav', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '导入 2 课' }).click();
  await expect(page).toHaveURL(/#\/lessons$/);

  // 默认折叠的一组
  const group = page.locator('details', { hasText: 'Aspekte neu C1' });
  await expect(group.getByText('2 课')).toBeVisible();
  await group.locator('summary').click();
  const first = group.getByRole('link', { name: /Kapitel 1 · Modul 2 Aufgabe 2a/ });
  await expect(first).toBeVisible();
  await expect(first).toContainText('0:04'); // 两轨各 2 秒，拼起来 4 秒

  await first.click();
  const lessonId = new URL(page.url()).hash.match(/#\/lesson\/([^/]+)\//)![1];
  await page.goto(`/#/lesson/${lessonId}/sentences`);
  await expect(page.getByText('Hallo, seid wieder einmal herzlich willkommen bei uns.')).toBeVisible();
  await expect(page.getByText('Das Gemeinschaftsleben ist schön.')).toBeVisible();
  await expect(page.getByLabel('说话人 ○')).toBeVisible();
  await expect(page.getByText(/^● /)).toHaveCount(0);
});

/** 另一台设备上的样子：标注层（含时间戳和文件清单）同步来了，音频没有。 */
function syncedBookBackup(now = Date.now() + 60_000): BackupFile {
  const texts = ['Gibt es goldene Regeln?', 'Ja, kann man sagen.'];
  let charStart = 0;
  const sentences: Sentence[] = texts.map((text, index) => {
    const s: Sentence = {
      index,
      text,
      charStart,
      charEnd: charStart + text.length,
      startTime: index * 2,
      endTime: index * 2 + 1.8,
      endTimeExplicit: true,
      timingSource: 'auto',
      blanks: [],
      markedDifficult: false,
      excluded: false,
      speaker: index === 0 ? '●' : '○',
    };
    charStart += text.length + 3;
    return s;
  });
  return {
    _warning: 'Contains copyrighted text. Local backup only. Do not share.',
    formatVersion: 1,
    exportedAt: now,
    lessons: [
      {
        id: 'book-lesson-1',
        title: 'Kapitel 1 · Modul 4 Aufgabe 2c',
        collection: 'Aspekte neu C1',
        speakers: ['●', '○'],
        source: { type: 'manual', audioFileName: '1_10.wav', audioFiles: ['1_10.wav', '1_11.wav'] },
        audioDuration: 4, // 两轨各 2 秒；字节数故意不记 —— 走「比时长」那一档
        sentences,
        createdAt: now - 86_400_000,
        updatedAt: now,
      },
    ],
    vocab: [],
  } as unknown as BackupFile;
}

test('换设备后一次选齐整组音频：按文件名各归各课，同步来的时间戳不重对（FR-3.6a）', async ({ page }) => {
  await openApp(page);
  await importBackup(page, syncedBookBackup());
  await page.goto('/#/lessons');

  const group = page.locator('details', { hasText: 'Aspekte neu C1' });
  await expect(group.getByText('1 课缺音频')).toBeVisible();
  await group.locator('summary').click();

  // 多选进来一个不相干的文件，顺序也是乱的
  await group
    .locator('input[type="file"][accept="audio/*"]')
    .setInputFiles([wav('1_11.wav'), wav('fremd.wav'), wav('1_10.wav')]);

  await expect(group.getByText('补上了 1 课，时间戳都是同步来的，不用重对。')).toBeVisible();
  await expect(group.getByText('1 课缺音频')).toHaveCount(0);
});

test('单个文件的课在课程页上绑回同一份音频：提示时间戳是同步来的，不重对（FR-3.6a 的另一个入口）', async ({ page }) => {
  const backup = syncedBookBackup();
  const [synced] = backup.lessons;
  backup.lessons = [
    { ...synced, id: 'single-1', source: { type: 'manual', audioFileName: 'solo.wav' }, audioDuration: 2 },
  ];
  await openApp(page);
  await importBackup(page, backup);
  await page.goto('/#/lesson/single-1/listen');

  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles([wav('solo.wav')]);
  // 绑上之后「素材未下载」那块横幅整个消失（提示文字在它里面，跟着一起没了），播放器拿到了 2 秒的音频
  await expect(page.getByText('0:00.0 / 0:02')).toBeVisible();
  // 判据是**底部没有冒出对齐进度条**：排进队的话它在 enqueue 的同一帧就出现（反向验证过：
  // 把 shouldRealign 改回恒为 true，这一条会红）。等一会儿再看，是因为这是一个「不该发生」的断言
  await page.waitForTimeout(1500);
  await expect(page.getByLabel(/^对齐中/)).toHaveCount(0);
  await expect(page.getByText('已对齐 2 / 2 句')).toBeVisible();
});

test('拼过的课在课程页上少选一轨：不绑，把缺的文件名报出来', async ({ page }) => {
  await openApp(page);
  await importBackup(page, syncedBookBackup());
  await page.goto('/#/lesson/book-lesson-1/listen');

  await expect(page.getByText(/要把这几个文件一起选上：1_10\.wav、1_11\.wav/)).toBeVisible();
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles([wav('1_10.wav')]);
  await expect(page.getByText(/还缺这几个文件：1_11\.wav/)).toBeVisible();
});
