import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncFetch, SyncApiError, SyncAuthError, SyncConflictError } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('syncFetch', () => {
  it('带上 Bearer 与 JSON 头，并把响应解出来', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { version: 7 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncFetch<{ version: number }>('/v1/docs/vocab', {
      method: 'PUT',
      token: 'tok',
      body: { baseVersion: 6, body: [] },
    });

    expect(result).toEqual({ version: 7 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('PUT');
  });

  it('没有 body 时不发 Content-Type（GET 带着它只会让 CORS 预检变复杂）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await syncFetch('/v1/me', { token: 'tok' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('409 → SyncConflictError，且远端现值原样带出来（合并要用它）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(409, { code: 'conflict', version: 12, body: [{ id: 'w1' }] }),
      ),
    );

    const err = await syncFetch('/v1/docs/vocab', { method: 'PUT', token: 't', body: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SyncConflictError);
    expect((err as SyncConflictError).version).toBe(12);
    expect((err as SyncConflictError).body).toEqual([{ id: 'w1' }]);
  });

  it('401 → SyncAuthError，带上服务器写给人看的原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: '这个账号已不再被允许访问' })));
    const err = await syncFetch('/v1/me', { token: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncAuthError);
    expect((err as SyncAuthError).message).toContain('不再被允许');
  });

  it('其他状态码 → SyncApiError，保留 status 供调用方分辨 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: '文档不存在' })));
    const err = await syncFetch('/v1/docs/nope', { token: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncApiError);
    expect((err as SyncApiError).status).toBe(404);
    expect(err).not.toBeInstanceOf(SyncAuthError);
  });

  it('错误响应体不是 JSON 也不会二次抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));
    const err = await syncFetch('/v1/docs', { token: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncApiError);
    expect((err as SyncApiError).status).toBe(502);
  });
});
