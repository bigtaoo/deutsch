import { describe, expect, it, vi } from 'vitest';
import { encodePairingPayload, decodePairingPayload, generatePairingQrDataUrl, decodeQrFromImageData } from './qrPairing';

vi.mock('jsqr', () => ({
  default: vi.fn(),
}));

describe('encodePairingPayload / decodePairingPayload', () => {
  it('round-trips a token-only payload', () => {
    const payload = { v: 1 as const, token: 'github_pat_abc' };
    expect(decodePairingPayload(encodePairingPayload(payload))).toEqual(payload);
  });

  it('round-trips a payload that also carries a selected repo', () => {
    const payload = {
      v: 1 as const,
      token: 'github_pat_abc',
      repo: { owner: 'tao', repo: 'backup', defaultBranch: 'main' },
    };
    expect(decodePairingPayload(encodePairingPayload(payload))).toEqual(payload);
  });

  it('falls back to treating non-JSON content as a raw token, rather than throwing', () => {
    expect(decodePairingPayload('github_pat_not_json_at_all')).toEqual({
      v: 1,
      token: 'github_pat_not_json_at_all',
    });
  });

  it('falls back to raw-token handling when JSON is well-formed but has no token field', () => {
    expect(decodePairingPayload('{"unrelated":true}')).toEqual({ v: 1, token: '{"unrelated":true}' });
  });
});

describe('generatePairingQrDataUrl', () => {
  it('produces a PNG data URL', async () => {
    const url = await generatePairingQrDataUrl({ v: 1, token: 'github_pat_abc' });
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('decodeQrFromImageData', () => {
  it('returns the decoded string when jsQR finds a code', async () => {
    const jsQR = (await import('jsqr')).default as unknown as ReturnType<typeof vi.fn>;
    jsQR.mockReturnValue({ data: 'found-token', location: {} });

    const fakeImageData = { data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData;
    expect(decodeQrFromImageData(fakeImageData)).toBe('found-token');
  });

  it('returns null instead of throwing when no code is found in the frame', async () => {
    const jsQR = (await import('jsqr')).default as unknown as ReturnType<typeof vi.fn>;
    jsQR.mockReturnValue(null);

    const fakeImageData = { data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData;
    expect(decodeQrFromImageData(fakeImageData)).toBeNull();
  });
});
