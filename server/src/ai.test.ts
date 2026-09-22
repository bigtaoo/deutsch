import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiExplainer } from './ai.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createAiExplainer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('把词、原句、已有释义都塞进提示词，模型名与 key 落到请求上', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: '解释内容' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const explainer = createAiExplainer('sk-test', 'claude-haiku-4-5-20251001');
    const text = await explainer.explain({ word: 'Zuversicht', context: 'Sie hat große Zuversicht.', existing: '信心' });

    expect(text).toBe('解释内容');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' });
    const body = JSON.parse(init.body as string) as { model: string; messages: Array<{ content: string }> };
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.messages[0].content).toContain('Zuversicht');
    expect(body.messages[0].content).toContain('Sie hat große Zuversicht.');
    expect(body.messages[0].content).toContain('信心');
  });

  it('没有原句/已有释义时不强塞这两行', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'x' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await createAiExplainer('sk-test', 'model').explain({ word: 'Zug' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
    expect(body.messages[0].content).not.toContain('出现的原句：');
    expect(body.messages[0].content).not.toContain('词典已经给出的释义（');
  });

  it('多段 text block 拼接，非 text block（如 thinking）被跳过', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ content: [{ type: 'thinking', text: '别露出来' }, { type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const text = await createAiExplainer('sk-test', 'model').explain({ word: 'Zug' });
    expect(text).toBe('第一段第二段');
  });

  it('上游非 2xx → 抛错，且不透传响应体（可能带账单细节）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { message: '你的账单欠费了' } }, 429)));
    const err = await createAiExplainer('sk-test', 'model')
      .explain({ word: 'Zug' })
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HTTP 429');
    expect((err as Error).message).not.toContain('账单');
  });

  it('返回体里没有文本 → 抛错，而不是把空字符串当成一份解释存进 note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ content: [] })));
    await expect(createAiExplainer('sk-test', 'model').explain({ word: 'Zug' })).rejects.toThrow('没有返回文本');
  });
});
