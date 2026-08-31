import { afterEach, describe, expect, it, vi } from 'vitest';
import { listPrivateRepos, createBackupRepo, verifyRepo } from './repo';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('listPrivateRepos', () => {
  it('filters to only private repos and maps to RepoRef', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([
          { name: 'priv', owner: { login: 'tao' }, private: true, default_branch: 'main' },
          { name: 'pub', owner: { login: 'tao' }, private: false, default_branch: 'main' },
        ]),
      ),
    );
    const repos = await listPrivateRepos('token');
    expect(repos).toEqual([{ owner: 'tao', repo: 'priv', defaultBranch: 'main' }]);
  });
});

describe('createBackupRepo', () => {
  it('creates with private:true and auto_init:true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ name: 'my-backup', owner: { login: 'tao' }, private: true, default_branch: 'main' }));
    vi.stubGlobal('fetch', fetchMock);

    const ref = await createBackupRepo('token', 'my-backup');

    expect(ref).toEqual({ owner: 'tao', repo: 'my-backup', defaultBranch: 'main' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ name: 'my-backup', private: true, auto_init: true });
  });

  it('refuses to accept a repo GitHub reports as non-private', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ name: 'x', owner: { login: 'tao' }, private: false, default_branch: 'main' })),
    );
    await expect(createBackupRepo('token', 'x')).rejects.toThrow(/private/);
  });
});

describe('verifyRepo', () => {
  const ref = { owner: 'tao', repo: 'backup', defaultBranch: 'main' };

  it('reports not-found when the repo does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const result = await verifyRepo('token', ref);
    expect(result).toEqual({ private: false, writable: false, reason: expect.any(String) });
  });

  it('reports non-private repos as invalid without attempting a write', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ private: false }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyRepo('token', ref);
    expect(result.private).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 没有多打一次写测试请求
  });

  it('reports read-only tokens distinctly from a missing repo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (!init || init.method === undefined) {
          if (String(url).endsWith('/repos/tao/backup')) return Promise.resolve(jsonResponse({ private: true }));
          return Promise.resolve(new Response('', { status: 404 })); // 探测 .keep 是否已存在
        }
        return Promise.resolve(new Response('', { status: 403 })); // PUT 被拒绝：只读 token
      }),
    );
    const result = await verifyRepo('token', ref);
    expect(result).toEqual({ private: true, writable: false, reason: expect.any(String) });
  });

  it('succeeds when the repo is private and the token can write', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (!init || init.method === undefined) {
          if (String(url).endsWith('/repos/tao/backup')) return Promise.resolve(jsonResponse({ private: true }));
          return Promise.resolve(new Response('', { status: 404 }));
        }
        return Promise.resolve(jsonResponse({ content: { sha: 'abc' } }));
      }),
    );
    const result = await verifyRepo('token', ref);
    expect(result).toEqual({ private: true, writable: true });
  });
});
