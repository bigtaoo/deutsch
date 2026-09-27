import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VocabEntry } from '@/types/models';

vi.stubEnv('VITE_SYNC_API_BASE', 'https://sync.example.test');
vi.stubEnv('VITE_GOOGLE_WEB_CLIENT_ID', 'client-id');

const getSessionToken = vi.fn<() => Promise<string | undefined>>();
vi.mock('@/sync/session', () => ({ getSessionToken: () => getSessionToken() }));

const { queueZhGloss, flushZhGloss, __resetZhGloss, GLOSS_BATCH, GLOSS_DELAY_MS } = await import('./gloss');
const { resetAiAvailability } = await import('./explain');
const { useVocabStore } = await import('@/state/useVocabStore');

function entry(id: string, extra: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id,
    surface: `Wort${id}`,
    contextSentence: `Satz mit Wort${id}.`,
    lessonId: 'L',
    sentenceIndex: 0,
    hasTimestamp: true,
    suspended: false,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  } as VocabEntry;
}

function glossResponse(glosses: string[]): Response {
  return new Response(JSON.stringify({ glosses }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** 从 fetch 的第 n 次调用里取出发给服务器的 items */
function sentItems(fetchMock: ReturnType<typeof vi.fn>, n = 0): Array<{ word: string; context?: string }> {
  const init = fetchMock.mock.calls[n][1] as RequestInit;
  return (JSON.parse(init.body as string) as { items: Array<{ word: string; context?: string }> }).items;
}

const updateEntries = vi.fn(async (list: VocabEntry[]) => {
  const byId = new Map(list.map((e) => [e.id, e]));
  useVocabStore.setState({ entries: useVocabStore.getState().entries.map((e) => byId.get(e.id) ?? e) });
});

beforeEach(() => {
  getSessionToken.mockResolvedValue('tok');
  useVocabStore.setState({ entries: [], updateEntries });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  updateEntries.mockClear();
  getSessionToken.mockReset();
  resetAiAvailability();
  __resetZhGloss();
});

describe('queueZhGloss（FR-9.15）', () => {
  it('几秒内连着排的词合成一批、只发一次请求；词带原句，写回 meaningZh', async () => {
    vi.useFakeTimers();
    useVocabStore.setState({ entries: [entry('1', { lemma: 'Zug' }), entry('2')] });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => glossResponse(['一步棋', '第二个']));
    vi.stubGlobal('fetch', fetchMock);

    queueZhGloss(['1']);
    await vi.advanceTimersByTimeAsync(GLOSS_DELAY_MS - 100);
    queueZhGloss(['2']); // 重新计时
    await vi.advanceTimersByTimeAsync(GLOSS_DELAY_MS - 100);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(updateEntries).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/ai/gloss');
    // 问的是词元（有就用），带着原句
    expect(sentItems(fetchMock)).toEqual([
      { word: 'Zug', context: 'Satz mit Wort1.' },
      { word: 'Wort2', context: 'Satz mit Wort2.' },
    ]);
    const byId = Object.fromEntries(useVocabStore.getState().entries.map((e) => [e.id, e.meaningZh]));
    expect(byId).toEqual({ 1: '一步棋', 2: '第二个' });
  });

  it('已经有中文的、没有原句的（查词/预置卡）不问', async () => {
    useVocabStore.setState({
      entries: [entry('1', { meaningZh: '已有' }), entry('2', { contextSentence: undefined, lookup: true }), entry('3')],
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => glossResponse(['三']));
    vi.stubGlobal('fetch', fetchMock);

    queueZhGloss(['1', '2', '3']);
    await flushZhGloss();

    expect(sentItems(fetchMock).map((i) => i.word)).toEqual(['Wort3']);
  });

  it(`超过 ${GLOSS_BATCH} 个切成几批`, async () => {
    const many = Array.from({ length: GLOSS_BATCH + 5 }, (_, i) => entry(String(i)));
    useVocabStore.setState({ entries: many });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const n = (JSON.parse(init.body as string) as { items: unknown[] }).items.length;
      return glossResponse(Array.from({ length: n }, () => '中'));
    });
    vi.stubGlobal('fetch', fetchMock);

    queueZhGloss(many.map((e) => e.id));
    await flushZhGloss();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentItems(fetchMock, 0)).toHaveLength(GLOSS_BATCH);
    expect(sentItems(fetchMock, 1)).toHaveLength(5);
    expect(useVocabStore.getState().entries.every((e) => e.meaningZh === '中')).toBe(true);
  });

  it('问的这几秒里用户自己填了中文 —— 不覆盖；认不出的（空串）不写', async () => {
    useVocabStore.setState({ entries: [entry('1'), entry('2')] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const [a, b] = useVocabStore.getState().entries;
        useVocabStore.setState({ entries: [{ ...a, meaningZh: '我自己填的' }, b] });
        return glossResponse(['AI 的', '']);
      }),
    );

    queueZhGloss(['1', '2']);
    await flushZhGloss();

    expect(useVocabStore.getState().entries.map((e) => e.meaningZh)).toEqual(['我自己填的', undefined]);
    expect(updateEntries).toHaveBeenCalledWith([]);
  });

  it('没登录 → 不发请求；服务器报错 → 什么都不写、不抛', async () => {
    useVocabStore.setState({ entries: [entry('1')] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    getSessionToken.mockResolvedValue(undefined);
    queueZhGloss(['1']);
    await flushZhGloss();
    expect(fetchMock).not.toHaveBeenCalled();

    getSessionToken.mockResolvedValue('tok');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"x"}', { status: 502 })));
    queueZhGloss(['1']);
    await expect(flushZhGloss()).resolves.toBeUndefined();
    expect(updateEntries).not.toHaveBeenCalled();
  });
});
