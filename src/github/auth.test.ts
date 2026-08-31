import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyToken, daysUntilExpiry, shouldWarnAboutExpiry } from './auth';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyToken', () => {
  it('returns login and avatar on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ login: 'tao', avatar_url: 'https://example.invalid/a.png' }), {
          status: 200,
        }),
      ),
    );
    const { identity } = await verifyToken('token');
    expect(identity).toEqual({ login: 'tao', avatarUrl: 'https://example.invalid/a.png' });
  });

  it('throws a clear error on 401 instead of a generic one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(verifyToken('bad-token')).rejects.toMatchObject({ status: 401 });
  });

  it('parses expiry from a candidate header when present', async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toUTCString();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ login: 'tao', avatar_url: '' }), {
          status: 200,
          headers: { 'github-authentication-token-expiration': future },
        }),
      ),
    );
    const { expiry } = await verifyToken('token');
    expect(expiry.expiresAt).not.toBeNull();
  });

  it('returns null expiry (not an error) when no candidate header is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ login: 'tao', avatar_url: '' }), { status: 200 })),
    );
    const { expiry } = await verifyToken('token');
    expect(expiry.expiresAt).toBeNull();
  });
});

describe('shouldWarnAboutExpiry (FR-11.5: 剩余 30 天起提醒)', () => {
  it('warns at exactly 30 days out', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const expiresAt = new Date('2026-01-31T00:00:00Z');
    expect(daysUntilExpiry(expiresAt, now)).toBe(30);
    expect(shouldWarnAboutExpiry(expiresAt, now)).toBe(true);
  });

  it('does not warn when more than 30 days remain', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const expiresAt = new Date('2026-03-01T00:00:00Z');
    expect(shouldWarnAboutExpiry(expiresAt, now)).toBe(false);
  });

  it('never warns when expiry is unknown (null)', () => {
    expect(shouldWarnAboutExpiry(null)).toBe(false);
  });
});
