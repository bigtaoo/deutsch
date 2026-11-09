// FR-22 每日会话（变更 84）的行为测试。纯函数（排计划、排轮、出题、合并）在 src/drill/*.test.ts 里各自测过，
// 这里测的是把它们装起来之后「点下去发生了什么」：
//   · 打开就开始：顶部 `x / total`，卡面是词形，选项是中文
//   · 答错展开卡背；标记之后中文可改，保存落库、立即用于正确项
//   · 本轮重做的那一次不进调度（FR-22.7）—— 写错的症状是「错了再对」被记成记住了
//   · 斩：落 known、跳到下一张、计数 +1
//   · 先停在这里 → 回来接着背，计数从已做的往上数（做没做完看的是进度，不是这一页记的位置）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME, META_KEYS } from '@/db/schema';
import { putMeta } from '@/db/meta';
import { getDrillState } from '@/drill/state';
import { prefetchWordAudio } from '@/dict/audio';
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

function wrongChoice(w: string): string {
  return Object.values(ZH).find(
    (t) => t !== ZH[w] && screen.getAllByRole('button').some((b) => b.textContent?.replace(/^\d/, '') === t),
  )!;
}

async function openSession() {
  render(<DrillPage />);
  await screen.findByText('这个词是什么意思');
}

const tick = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

describe('打开就开始', () => {
  it('顶部是 0 / 6，卡面词形，四个中文选项里有正确的那个', async () => {
    await openSession();
    expect(screen.getByText('0 / 6')).toBeTruthy();
    const w = shownWord();
    expect(choiceButton(ZH[w])).toBeTruthy();
    const texts = Object.values(ZH);
    const choiceTexts = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.replace(/^\d/, '') ?? '')
      .filter((t) => texts.includes(t));
    expect(choiceTexts).toHaveLength(4);
  });

  it('开始前把今天这批的发音取好', async () => {
    await openSession();
    expect(prefetchWordAudio).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prefetchWordAudio).mock.calls[0][0]).toHaveLength(6);
  });

  it('今天的计划落库 —— 换个页面再来，分母不变', async () => {
    await openSession();
    const s = await getDrillState();
    expect(s.day?.ids).toHaveLength(6);
  });

  it('池子是空的（没词库、也没自己加的词）→ 不出空卡', async () => {
    await putMeta(META_KEYS.drillWordbank, undefined);
    render(<DrillPage />);
    expect(await screen.findByText('今天的背完了。')).toBeTruthy();
  });
});

describe('作答', () => {
  it('答对：进度写 `word:`，计数 +1', async () => {
    await openSession();
    const w = shownWord();
    fireEvent.click(choiceButton(ZH[w]));
    await waitFor(async () => expect((await getDrillState()).progress[`word:${w.toLowerCase()}`]).toBeDefined());
    expect((await getDrillState()).progress[`audio:${w.toLowerCase()}`]).toBeUndefined();
    await screen.findByText('1 / 6');
  });

  it('答错：进调度（Again）、展开卡背；标记 → 改中文 → 保存，立即成为正确项', async () => {
    await openSession();
    const w = shownWord();
    const id = w.toLowerCase();
    fireEvent.click(choiceButton(wrongChoice(w)));

    await waitFor(async () => expect((await getDrillState()).progress[`word:${id}`]).toBeDefined());

    fireEvent.click(await screen.findByRole('button', { name: '☆ 标记' }));
    const input = await screen.findByLabelText('改正确答案的中文');
    fireEvent.change(input, { target: { value: '租房押金（改）' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await screen.findByText('已改，下次出题用这一版');
    const s = await getDrillState();
    expect(s.marks[id]).toMatchObject({ flagged: true, zh: '租房押金（改）' });
    expect(choiceButton('租房押金（改）').className).toContain('border-ok');
  });

  it('错了的词隔几张再出，重做那一次答对**不再评分**、也不再计数', async () => {
    await openSession();
    const first = shownWord();
    const id = first.toLowerCase();
    fireEvent.click(choiceButton(wrongChoice(first)));
    await screen.findByRole('button', { name: '继续 (Space)' });
    const graded = (await getDrillState()).progress[`word:${id}`];

    fireEvent.click(screen.getByRole('button', { name: '继续 (Space)' }));
    for (let i = 0; i < 10; i++) {
      await screen.findByText('这个词是什么意思');
      await waitFor(() => expect(document.querySelector('p.text-word')).toBeTruthy());
      const w = shownWord();
      if (w === first) break;
      fireEvent.click(choiceButton(ZH[w]));
      await tick(700);
    }
    expect(shownWord()).toBe(first);
    expect(screen.getByText('重做')).toBeTruthy();
    // 斩只给第一次：重做时不出
    expect(screen.queryByRole('button', { name: '斩' })).toBeNull();
    const before = screen.getByText(/^\d+ \/ 6$/).textContent;
    fireEvent.click(choiceButton(ZH[first]));
    await tick(50);
    expect((await getDrillState()).progress[`word:${id}`]).toEqual(graded);
    expect(screen.getByText(/^\d+ \/ 6$/).textContent).toBe(before);
  }, 20_000);
});

describe('斩', () => {
  it('落 known、跳到下一张、计数 +1，不写进度', async () => {
    await openSession();
    const w = shownWord();
    fireEvent.click(screen.getByRole('button', { name: '斩' }));
    await screen.findByText('1 / 6');
    const s = await getDrillState();
    expect(s.marks[w.toLowerCase()]?.known).toBe(true);
    expect(s.progress[`word:${w.toLowerCase()}`]).toBeUndefined();
    expect(shownWord()).not.toBe(w);
  });
});

describe('先停在这里', () => {
  it('停下给小结；再打开从已做的往上数，做过的不再出', async () => {
    await openSession();
    const w = shownWord();
    fireEvent.click(choiceButton(ZH[w]));
    await screen.findByText('1 / 6');
    await tick(700);
    fireEvent.click(screen.getByRole('button', { name: '先停在这里' }));
    expect(await screen.findByText(/先停在这里，回来接着背/)).toBeTruthy();
    cleanup();

    await openSession();
    expect(screen.getByText('1 / 6')).toBeTruthy();
    expect(shownWord()).not.toBe(w);
  });
});
