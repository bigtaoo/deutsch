import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubRequest, githubRequestJson, GITHUB_API_BASE } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('githubRequest', () => {
  it('sends bearer auth and API version headers against the real API base', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await githubRequest('/user', 'my-token');

    expect(fetchMock).toHaveBeenCalledWith(
      `${GITHUB_API_BASE}/user`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-token',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      }),
    );
  });
});

describe('githubRequestJson', () => {
  it('returns parsed JSON on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const result = await githubRequestJson<{ ok: boolean }>('/user', 'token');
    expect(result).toEqual({ ok: true });
  });

  it('throws GitHubApiError with the status code on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403, statusText: 'Forbidden' })));
    await expect(githubRequestJson('/user', 'token')).rejects.toMatchObject({
      name: 'GitHubApiError',
      status: 403,
    });
  });
});
