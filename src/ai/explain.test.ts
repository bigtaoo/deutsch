import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';

vi.stubEnv('VITE_SYNC_API_BASE', 'https://sync.example.test');
vi.stubEnv('VITE_GOOGLE_WEB_CLIENT_ID', 'client-id');

const getSessionToken = vi.fn<() => Promise<string | undefined>>();
vi.mock('@/sync/session', () => ({
  getSessionToken: () => getSessionToken(),
}));

const { aiAvailable, explainWithAi, getCachedAiNote, resetAiAvailability } = await import('./explain');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  getSessionToken.mockReset();
  resetAiAvailability();
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

describe('aiAvailable', () => {
  it('没登录 → false，不发请求', async () => {
    getSessionToken.mockResolvedValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await aiAvailable()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('登录过 → true', async () => {
    getSessionToken.mockResolvedValue('tok');
    expect(await aiAvailable()).toBe(true);
  });

  it('服务器说过没配 key（503）之后，再问就直接 false，不再发请求', async () => {
    getSessionToken.mockResolvedValue('tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, { error: '没开', code: 'ai_off' })));
    await expect(explainWithAi({ word: 'Zug' })).rejects.toThrow();

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await aiAvailable()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resetAiAvailability 之后重新可用', async () => {
    getSessionToken.mockResolvedValue('tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, { code: 'ai_off' })));
    await expect(explainWithAi({ word: 'Zug' })).rejects.toThrow();
    resetAiAvailability();
    expect(await aiAvailable()).toBe(true);
  });
});

describe('explainWithAi', () => {
  it('没登录 → 直接抛错，不发请求', async () => {
    getSessionToken.mockResolvedValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(explainWithAi({ word: 'Zug' })).rejects.toThrow('尚未登录');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('带上 token 与请求体，成功时返回 note', async () => {
    getSessionToken.mockResolvedValue('tok');
    const fetchMock = vi.fn(async () => jsonResponse(200, { note: '这是解释' }));
    vi.stubGlobal('fetch', fetchMock);

    const note = await explainWithAi({ word: 'Zug', context: '原句', existing: '词典释义' });
    expect(note).toBe('这是解释');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sync.example.test/v1/ai/explain');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ word: 'Zug', context: '原句', existing: '词典释义' });
  });

  it('502（上游失败）→ 抛出服务器给的原因', async () => {
    getSessionToken.mockResolvedValue('tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(502, { error: 'AI 接口返回 HTTP 429', code: 'ai_failed' })));
    await expect(explainWithAi({ word: 'Zug' })).rejects.toThrow('AI 接口返回 HTTP 429');
  });

  it('成功之后答案进了缓存（变更 49）——下次查同一个词不用再问一遍', async () => {
    getSessionToken.mockResolvedValue('tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { note: '一列火车' })));

    await explainWithAi({ word: ' Zug ' });
    await vi.waitFor(async () => {
      expect(await getCachedAiNote('zug')).toBe('一列火车');
    });
  });

  it('失败时不写缓存', async () => {
    getSessionToken.mockResolvedValue('tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(502, { error: '坏了', code: 'ai_failed' })));
    await expect(explainWithAi({ word: 'Zug' })).rejects.toThrow();
    expect(await getCachedAiNote('Zug')).toBeUndefined();
  });
});
