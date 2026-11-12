// FR-6.8 跟读录音回放 —— 只有真浏览器里才验得到的那条链：
// getUserMedia → MediaRecorder 真的吐出一段音频 → decodeAudioData 真的解得开 → 真的放了那么长。
//
// 单测里录音机是假的（`shadowing.test.ts` 的 FakeEcho，`echo.test.ts` 的假 MediaRecorder），
// 它们守得住状态机的每一个分支，但守不住「Chrome 的 MediaRecorder 吐出来的 webm/opus，
// 同一个浏览器的 decodeAudioData 认不认」这种事 —— 认不认，这里一跑就知道。
//
// 麦克风用 Chromium 自带的假设备（`--use-fake-device-for-media-stream`：一段持续的哔声），
// `--use-fake-ui-for-media-stream` 让权限弹窗自动放行。

import { expect, test, type Page } from '@playwright/test';
import { importBackup, importLesson, openApp } from './app';
import { MANUSCRIPT, timedLessonBackup, wavBytes } from './fixtures';

const TITLE = 'Alltagsdeutsch: Der deutsche Wald';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
});

/**
 * 把页面拿到的每一条麦克风流记下来，好在「停止」之后看音轨是不是真的还回去了。
 * 只包一层、原样转交 —— 流本身还是 Chromium 假设备给的那条。
 */
async function trackMicStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __micStreams: MediaStream[] };
    w.__micStreams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      w.__micStreams.push(stream);
      return stream;
    };
  });
}

/** 一课 1.5 秒一句、录音回放打开的课，停在跟读页。 */
async function seedShadowingLesson(page: Page): Promise<void> {
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT, audio: wavBytes(30) });
  const lessonId = new URL(page.url()).hash.match(/#\/lesson\/([^/]+)\//)![1];
  await importBackup(
    page,
    timedLessonBackup(lessonId, undefined, {
      sentenceSeconds: 1.5,
      settings: { shadowingEcho: true, shadowingRepeat: 1 },
    }),
  );
  await page.goto(`/#/lesson/${lessonId}/shadowing`);
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
}

const recordButton = (page: Page) => page.getByRole('button', { name: /录音中/ });

test('原句 → 录音一直录到点「读完了」→ 真的放出了录下的那么长 → 再听原句 → 下一句（FR-6.8）', async ({ page }) => {
  await trackMicStreams(page);
  await seedShadowingLesson(page);

  await page.getByRole('button', { name: '开始跟读' }).click();
  await expect(recordButton(page)).toBeVisible();

  // 录够 2 秒 —— 比原来的固定间隔（1 秒 × 1.2）长，证明录音不再按倒计时收尾。
  await page.waitForTimeout(2000);
  await expect(recordButton(page)).toBeVisible();
  await recordButton(page).click();
  const clickedAt = Date.now();

  await expect(page.getByText('回放你刚才的跟读')).toBeVisible();
  // 放完自己，原句再放一遍，然后才是下一句
  await expect(page.getByText('再听一遍原句')).toBeVisible({ timeout: 15_000 });
  const playedMs = Date.now() - clickedAt;
  await expect(page.getByText('Für viele Menschen')).toBeVisible({ timeout: 15_000 });

  // 回放真的放了录下的那一段：解码失败或录了个空，状态机会**立刻**跳到下一句（≈ 0 秒）。
  // 下限留松一点（录了 2 秒，放 ≥ 1.2 秒就算），上限只防「卡在回放里靠保底才出来」。
  expect(playedMs).toBeGreaterThan(1200);
  expect(playedMs).toBeLessThan(8000);

  // 第二句起用 Enter 收尾
  await expect(recordButton(page)).toBeVisible();
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await expect(page.getByText('回放你刚才的跟读')).toBeVisible();
});

test('停止之后麦克风真的还回去了：音轨全部 ended（FR-6.8）', async ({ page }) => {
  await trackMicStreams(page);
  await seedShadowingLesson(page);

  await page.getByRole('button', { name: '开始跟读' }).click();
  await expect(recordButton(page)).toBeVisible();

  const live = () =>
    page.evaluate(() =>
      (window as unknown as { __micStreams: MediaStream[] }).__micStreams
        .flatMap((s) => s.getTracks())
        .filter((t) => t.readyState === 'live').length,
    );
  expect(await live()).toBe(1);

  await page.getByRole('main').getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始跟读' })).toBeVisible();
  expect(await live()).toBe(0);
});

test('麦克风被拒：说明原因，这一课照样按固定间隔跟读下去（FR-6.8）', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('denied', 'NotAllowedError');
    };
  });
  await seedShadowingLesson(page);

  await page.getByRole('button', { name: '开始跟读' }).click();
  await expect(page.getByText('麦克风没有授权')).toBeVisible();
  // 退回 FR-6.1 的倒计时，而不是挂着一个没在录的「读完了」
  await expect(page.getByText(/现在跟读 —— 还有/)).toBeVisible();
  await expect(recordButton(page)).toHaveCount(0);
  await expect(page.getByText('Für viele Menschen')).toBeVisible();
});

test('关掉「录音并回放」：不申请麦克风，和原来的跟读一模一样', async ({ page }) => {
  await trackMicStreams(page);
  await seedShadowingLesson(page);
  // 这个勾选框受控于设置 store（异步落库后才变），`uncheck()` 会同步地查状态、偶尔判它没变。
  await page.getByLabel('录音并回放').click();
  await expect(page.getByLabel('录音并回放')).not.toBeChecked();

  await page.getByRole('button', { name: '开始跟读' }).click();
  await expect(page.getByText(/现在跟读 —— 还有/)).toBeVisible();
  await expect(recordButton(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __micStreams: MediaStream[] }).__micStreams.length),
  ).toBe(0);
});

// FR-6.9 原句播放时的逐词高亮（变更 90）。和通听那条（listen.spec.ts）同一个理由：
// 组件测试能断言 class 名，**断言不了这两个类最终算出来的颜色是不是同一个** ——
// 变更 58 那次「当前词和当前行共用 bg-warn-soft」就是这么溜过去的。
//
// 这一课故意用默认的 10 秒一句、并且**关掉录音回放**：原句播放那一段要足够长，
// 断言才跑得完；关掉录音是为了让「原句 → 间隔」这两档干净地轮到，
// 而间隔那一档正是「该我开口的时候屏幕上不该有当前词」的判据。
test('跟读原句时当前词反白：底色算出来跟卡片不是一个颜色；轮到自己开口就不亮了（FR-6.9）', async ({ page }) => {
  await openApp(page);
  await importLesson(page, { title: TITLE, text: MANUSCRIPT, audio: wavBytes(40) });
  const lessonId = new URL(page.url()).hash.match(/#\/lesson\/([^/]+)\//)![1];
  await importBackup(
    page,
    timedLessonBackup(lessonId, undefined, {
      settings: { shadowingEcho: false, shadowingRepeat: 1 },
    }),
  );
  await page.goto(`/#/lesson/${lessonId}/shadowing`);
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();

  await page.getByRole('button', { name: '开始跟读' }).click();
  await expect(page.locator('[data-active]')).toHaveCount(1);

  // 一次 evaluate 里取完，避免两次取样之间高亮又走了一个词。
  const seen = await page.evaluate(() => {
    const word = document.querySelector('[data-active]');
    const card = word?.closest('.bg-raised');
    if (!word || !card) return null;
    return {
      text: word.textContent,
      wordBg: getComputedStyle(word).backgroundColor,
      cardBg: getComputedStyle(card).backgroundColor,
      wordInk: getComputedStyle(word).color,
      cardInk: getComputedStyle(card).color,
    };
  });

  expect(seen).not.toBeNull();
  expect(seen!.text?.trim().length).toBeGreaterThan(0);
  // §12.17 的反白：实底 + 反过来的字色，两样都不能和卡片本身一样
  expect(seen!.wordBg).not.toBe('rgba(0, 0, 0, 0)');
  expect(seen!.wordBg).not.toBe(seen!.cardBg);
  expect(seen!.wordInk).not.toBe(seen!.cardInk);

  // 原句放完 → 轮到自己开口：整句一个词都不该亮着
  // （不关掉的话会有一个词僵在那里，看起来像卡住了）
  await expect(page.getByText(/现在跟读 —— 还有/)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-active]')).toHaveCount(0);
});
