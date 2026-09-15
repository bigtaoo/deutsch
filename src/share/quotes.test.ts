import { describe, expect, it } from 'vitest';
import { QUOTES, quoteAttribution, quoteForDate } from './quotes';
import { SHARE_PHOTOS, photoForDate, photoUrl } from './photos';

describe('QUOTES', () => {
  it('每条都有德语原文和中文', () => {
    for (const q of QUOTES) {
      expect(q.de.trim().length).toBeGreaterThan(0);
      expect(q.zh.trim().length).toBeGreaterThan(0);
    }
  });

  it('不重复', () => {
    expect(new Set(QUOTES.map((q) => q.de)).size).toBe(QUOTES.length);
  });

  it('谚语署名成「德语谚语」而不是留空', () => {
    expect(quoteAttribution({ de: 'x', zh: 'x', author: null })).toBe('Deutsches Sprichwort');
    expect(quoteAttribution({ de: 'x', zh: 'x', author: 'Goethe' })).toBe('Goethe');
  });
});

describe('quoteForDate', () => {
  it('同一天永远是同一句', () => {
    expect(quoteForDate('2026-09-15')).toBe(quoteForDate('2026-09-15'));
  });

  it('换一句会真的换掉', () => {
    expect(quoteForDate('2026-09-15', 1)).not.toBe(quoteForDate('2026-09-15'));
  });

  it('连着换一圈能回到原处，中间不越界', () => {
    const first = quoteForDate('2026-09-15');
    for (let i = 1; i < QUOTES.length; i++) {
      expect(quoteForDate('2026-09-15', i)).toBeDefined();
    }
    expect(quoteForDate('2026-09-15', QUOTES.length)).toBe(first);
  });

  it('不同的日子不会总是同一句', () => {
    const picked = new Set(
      Array.from({ length: 30 }, (_, i) => quoteForDate(`2026-09-${String(i + 1).padStart(2, '0')}`).de),
    );
    expect(picked.size).toBeGreaterThan(3);
  });
});

describe('底图', () => {
  it('地址指向打包进来的那六张', () => {
    for (const photo of SHARE_PHOTOS) {
      expect(photoUrl(photo.id)).toContain(`share/photos/${photo.id}.webp`);
    }
  });

  it('同一天默认同一张，换图会换掉', () => {
    expect(photoForDate('2026-09-15')).toBe(photoForDate('2026-09-15'));
    expect(photoForDate('2026-09-15', 1)).not.toBe(photoForDate('2026-09-15'));
  });
});
