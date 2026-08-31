import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFile, putFile } from './sync';
import { encodeBase64Utf8 } from '@/lib/base64';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ref = { owner: 'tao', repo: 'backup', defaultBranch: 'main' };

describe('getFile', () => {
  it('decodes base64 content, including non-ASCII (ä ö ü ß)', async () => {
    const original = 'Wörter mit Umlauten: äöüß';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ content: encodeBase64Utf8(original), sha: 'sha1', encoding: 'base64' }), {
          status: 200,
        }),
      ),
    );
    const file = await getFile('token', ref, 'vocab.json');
    expect(file).toEqual({ content: original, sha: 'sha1' });
  });

  it('returns null on 404 instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    expect(await getFile('token', ref, 'vocab.json')).toBeNull();
  });
});

describe('putFile', () => {
  it('sends base64-encoded content and returns the new sha on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: { sha: 'new-sha' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await putFile('token', ref, 'vocab.json', 'hello', { message: 'update', sha: 'old-sha' });

    expect(result).toEqual({ sha: 'new-sha' });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.sha).toBe('old-sha');
    expect(body.content).toBe(encodeBase64Utf8('hello'));
  });

  it('on 409, fetches remote content, resolves the conflict, and retries once with the remote sha', async () => {
    let putCallCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (!init || init.method === undefined) {
          // GET remote for conflict resolution
          return Promise.resolve(
            new Response(
              JSON.stringify({ content: encodeBase64Utf8('remote-content'), sha: 'remote-sha', encoding: 'base64' }),
              { status: 200 },
            ),
          );
        }
        putCallCount += 1;
        if (putCallCount === 1) return Promise.resolve(new Response('conflict', { status: 409 }));
        const body = JSON.parse(init.body as string);
        expect(body.sha).toBe('remote-sha');
        return Promise.resolve(new Response(JSON.stringify({ content: { sha: 'merged-sha' } }), { status: 200 }));
      }),
    );

    const onConflict = vi.fn().mockImplementation((remoteContent: string) => `merged(${remoteContent})`);
    const result = await putFile('token', ref, 'vocab.json', 'local-content', {
      message: 'update',
      sha: 'stale-sha',
      onConflict,
    });

    expect(onConflict).toHaveBeenCalledWith('remote-content');
    expect(result).toEqual({ sha: 'merged-sha' });
  });

  it('throws on 409 when no conflict resolver is provided (never silently overwrites)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('conflict', { status: 409 })));
    await expect(putFile('token', ref, 'vocab.json', 'x', { message: 'update' })).rejects.toMatchObject({
      status: 409,
    });
  });
});
