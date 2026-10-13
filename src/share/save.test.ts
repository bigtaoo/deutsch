import { describe, expect, it } from 'vitest';
import { shareCardFileName } from './save';
import { SHARE_CARD_MIME, SHARE_CARD_QUALITY } from './card';

describe('分享图的导出格式', () => {
  it('是 JPEG 而不是 PNG —— PNG 存照片一张近 2MB（变更 78）', () => {
    expect(SHARE_CARD_MIME).toBe('image/jpeg');
    expect(SHARE_CARD_QUALITY).toBeGreaterThanOrEqual(0.85);
    expect(SHARE_CARD_QUALITY).toBeLessThan(1);
  });

  it('文件名扩展名跟格式一致，日期在文件名里', () => {
    expect(shareCardFileName('2026-10-13')).toBe('努力学德语-2026-10-13.jpg');
  });
});
