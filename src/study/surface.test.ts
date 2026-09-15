import { describe, expect, it } from 'vitest';
import { isPracticeRoute } from './surface';

describe('isPracticeRoute', () => {
  it('每天走的那四个 tab 都算在练', () => {
    for (const tab of ['listen', 'shadowing', 'study', 'dictation'] as const) {
      expect(isPracticeRoute({ name: 'lesson', lessonId: 'l1', tab })).toBe(true);
    }
  });

  it('复习算', () => {
    expect(isPracticeRoute({ name: 'review' })).toBe(true);
  });

  it('切句不算 —— 那是一次性的准备工作（§12.6）', () => {
    expect(isPracticeRoute({ name: 'lesson', lessonId: 'l1', tab: 'sentences' })).toBe(false);
  });

  it('管理与浏览类的页面都不算', () => {
    expect(isPracticeRoute({ name: 'lessons' })).toBe(false);
    expect(isPracticeRoute({ name: 'vocab' })).toBe(false);
    expect(isPracticeRoute({ name: 'settings' })).toBe(false);
    expect(isPracticeRoute({ name: 'record' })).toBe(false);
  });
});
