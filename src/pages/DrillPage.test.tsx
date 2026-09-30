// FR-22 速背页的行为测试。纯函数（排轮、出题、合并）在 src/drill/*.test.ts 里各自测过，
// 这里测的是把它们装起来之后「点下去发生了什么」：
//   · 单词模式亮词形、选项是中文；答错展开卡背
//   · 标记之后中文变成可改，保存落库、立即用于正确项
//   · 本轮重做的那一次不进调度（FR-22.7）—— 写错的症状是「错了再对」被记成记住了
//   · 音频模式开轮前先取发音

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME, META_KEYS } from '@/db/schema';
import { putMeta } from '@/db/meta';
import { getDrillState, putDrillState, emptyDrillState, withPrefs } from '@/drill/state';
import { prefetchWordAudio } from '@/dict/audio';
import { scheduleDrillSync } from '@/sync/trigger';
import type { CachedWordbank } from '@/drill/types';

vi.mock('@/sync/config', () => ({ SYNC_API_BASE: '', isSyncConfigured: () => false }));
vi.mock('@/dict/lookup', () => ({ lookupDict: vi.fn(async () => null) }));
vi.mock('@/dict/audio', () => ({
  ensureWordAudio: vi.fn(async () => undefined),
  germanVoice: vi.fn(() => ({ name: 'Anna' })),
  speak: vi.fn(() => true),
  prefetchWordAudio: vi.fn(async () => ({ human: 0, missing: 0 })),
}));
vi.mock('@/audio/player', () => ({
  audioPlayer: { load: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn() },
}));
vi.mock('@/audio/sfx', () => ({ playSfx: vi.fn(), preloadSfx: vi.fn(async () => {}) }));
vi.mock('@/ai/explain', () => ({
  aiAvailable: vi.fn(async () => false),
  explainWithAi: vi.fn(async () => ''),
  getCachedAiNote: vi.fn(async () => undefined),
}));
vi.mock('@/ai/gloss', () => ({ glossWithAi: vi.fn(async () => []) }));
vi.mock('@/sync/trigger', () => ({
  scheduleDrillSync: vi.fn(),
  syncDrillNow: vi.fn(async () => {}),
  syncVocabNow: vi.fn(),
}));

const { DrillPage } = await import('./DrillPage');

const ZH: Record<string, string> = {
  Kaution: '押金',
  Mieter: '租户',
  Vermieter: '房东',
  Makler: '中介',
  Umzug: '搬家',
  Nebenkosten: '附加费用',
};

const BANK: CachedWordbank = {
  version: 't1',
  fetchedAt: 0,
  items: Object.entries(ZH).map(([w, zh]) => ({ id: w.toLowerCase(), w, p: 'noun' as const, g: 'm' as const, zh, t: 'wohnen' as const })),
};

beforeEach(async () => {
  await putMeta(META_KEYS.drillWordbank, BANK);
});

afterEach(async () => {
  vi.clearAllMocks();
  const db = await getDB();
  db.close();
  _resetDBForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

/** 单词模式下卡面上那个词。 */
function shownWord(): string {
  const el = document.querySelector('p.text-word');
  if (!el) throw new Error('卡面上没有词');
  return el.textContent ?? '';
}

function choiceButton(text: string): HTMLElement {
  const btn = screen.getAllByRole('button').find((b) => b.textContent?.replace(/^\d/, '') === text);
  if (!btn) throw new Error(`没有选项「${text}」`);
  return btn;
}

async function startWordRound() {
  await putDrillState(withPrefs(emptyDrillState(), { mode: 'word', roundSize: 10 }, 1));
  render(<DrillPage />);
  fireEvent.click(await screen.findByRole('button', { name: '开始一轮' }));
  await screen.findByText('这个词是什么意思');
}

describe('首页', () => {
  it('写出词库大小与「到期 / 没学过」，三大类各带词数', async () => {
    render(<DrillPage />);
    expect(await screen.findByText(/还没学过 6/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '日常（6）' })).toBeTruthy();
    expect(screen.getByText(/词库 6 个词/)).toBeTruthy();
  });

  it('从没拿到过词库、也没有自己加的词 → 拦路横幅，说清下一步', async () => {
    await putMeta(META_KEYS.drillWordbank, undefined);
    render(<DrillPage />);
    expect(await screen.findByText('词库还没下载')).toBeTruthy();
  });

  it('切模式落库并触发同步（偏好跟着账号走）', async () => {
    render(<DrillPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Aa 单词' }));
    await waitFor(async () => expect((await getDrillState()).prefs.mode).toBe('word'));
    expect(scheduleDrillSync).toHaveBeenCalled();
  });
});

describe('单词模式一轮', () => {
  it('选项是四个中文，其中一个是卡面那个词的中文', async () => {
    await startWordRound();
    const w = shownWord();
    expect(choiceButton(ZH[w])).toBeTruthy();
    const texts = Object.values(ZH);
    const choiceTexts = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.replace(/^\d/, '') ?? '')
      .filter((t) => texts.includes(t));
    expect(choiceTexts).toHaveLength(4);
  });

  it('答错：进调度（Again）、展开卡背；标记 → 改中文 → 保存，立即成为正确项', async () => {
    await startWordRound();
    const w = shownWord();
    const id = w.toLowerCase();
    const wrong = Object.values(ZH).find(
      (t) => t !== ZH[w] && screen.getAllByRole('button').some((b) => b.textContent?.replace(/^\d/, '') === t),
    )!;
    fireEvent.click(choiceButton(wrong));

    await waitFor(async () => expect((await getDrillState()).progress[`word:${id}`]).toBeDefined());
    expect((await getDrillState()).progress[`audio:${id}`]).toBeUndefined(); // 另一个模式不动

    fireEvent.click(await screen.findByRole('button', { name: '☆ 标记' }));
    const input = await screen.findByLabelText('改正确答案的中文');
    fireEvent.change(input, { target: { value: '租房押金（改）' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await screen.findByText('已改，下次出题用这一版');
    const s = await getDrillState();
    expect(s.marks[id]).toMatchObject({ flagged: true, zh: '租房押金（改）' });
    expect(choiceButton('租房押金（改）').className).toContain('border-ok');
  });

  it('错了的词本轮内再出，重做那一次答对**不再评分**', async () => {
    await startWordRound();
    const first = shownWord();
    const id = first.toLowerCase();
    const wrong = Object.values(ZH).find(
      (t) => t !== ZH[first] && screen.getAllByRole('button').some((b) => b.textContent?.replace(/^\d/, '') === t),
    )!;
    fireEvent.click(choiceButton(wrong));
    await screen.findByRole('button', { name: '继续 (Space)' });
    const graded = (await getDrillState()).progress[`word:${id}`];

    fireEvent.click(screen.getByRole('button', { name: '继续 (Space)' }));
    // 一路答对，直到那个词作为重做回来
    for (let i = 0; i < 10; i++) {
      await screen.findByText('这个词是什么意思');
      await waitFor(() => expect(document.querySelector('p.text-word')).toBeTruthy());
      const w = shownWord();
      if (w === first) break;
      fireEvent.click(choiceButton(ZH[w]));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
    }
    expect(shownWord()).toBe(first);
    expect(screen.getByText('重做')).toBeTruthy();
    fireEvent.click(choiceButton(ZH[first]));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect((await getDrillState()).progress[`word:${id}`]).toEqual(graded);
  }, 20_000);
});

describe('音频模式', () => {
  it('开轮前先把这一轮的发音取好', async () => {
    await putDrillState(withPrefs(emptyDrillState(), { mode: 'audio', roundSize: 10 }, 1));
    render(<DrillPage />);
    fireEvent.click(await screen.findByRole('button', { name: '开始一轮' }));
    await screen.findByText(/听这个词，选出它的意思/);
    expect(prefetchWordAudio).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prefetchWordAudio).mock.calls[0][0]).toHaveLength(6);
    // 音频模式卡面上不给词形
    expect(document.querySelector('p.text-word')).toBeNull();
  });
});
