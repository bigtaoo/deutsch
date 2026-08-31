import { describe, expect, it } from 'vitest';
import { toShareablePackage } from './shareable';
import type { Lesson } from '@/types/models';

// 自造的德语句子，不摘抄任何真实版权素材（§3.1.1 R-5）。
const SENTENCE_TEXT =
  'Der kleine Roboter lernte jeden Morgen zehn neue Wörter auswendig und übte sie am Abend fleißig.';

function buildLesson(): Lesson {
  return {
    id: 'l1',
    title: 'Alltagsdeutsch, 2025-11-03',
    source: { type: 'dw', dwLessonId: '99999999', sourceUrl: 'https://example.invalid/l-99999999' },
    sentences: [
      {
        index: 0,
        text: SENTENCE_TEXT,
        charStart: 0,
        charEnd: SENTENCE_TEXT.length,
        startTime: 1.0,
        endTime: 4.5,
        endTimeExplicit: true,
        markedDifficult: false,
        excluded: false,
        blanks: [
          {
            id: 'b1',
            ranges: [{ start: 4, end: 10 }],
            surface: 'kleine',
            lemma: 'klein',
            vocabEntryId: 'v1',
          },
        ],
      },
      {
        index: 1,
        text: 'Dieser zweite Satz ist nur zur Fülle da und wird nicht ausgezeichnet.',
        charStart: 100,
        charEnd: 170,
        endTimeExplicit: false,
        markedDifficult: false,
        excluded: true, // Glossar 等非朗读内容：不应进入包
        blanks: [],
      },
    ],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('toShareablePackage', () => {
  it('never includes forbidden field names', () => {
    const pkg = toShareablePackage(buildLesson());
    const json = JSON.stringify(pkg);
    expect(json).not.toContain('"text"');
    expect(json).not.toContain('"contextSentence"');
    expect(json).not.toContain('"surface"');
  });

  it('never includes any 8+ consecutive-word run of the original sentence', () => {
    const pkg = toShareablePackage(buildLesson());
    const json = JSON.stringify(pkg);
    const words = SENTENCE_TEXT.split(/\s+/);
    for (let i = 0; i + 8 <= words.length; i++) {
      const window = words.slice(i, i + 8).join(' ');
      expect(json).not.toContain(window);
    }
  });

  it('only includes timings for sentences with resolved start and end times', () => {
    const pkg = toShareablePackage(buildLesson());
    expect(pkg.timings).toEqual([{ index: 0, start: 1.0, end: 4.5 }]);
  });

  it('excludes sentences marked excluded (e.g. Glossar) entirely', () => {
    const pkg = toShareablePackage(buildLesson());
    expect(pkg.blanks.every((b) => b.sentenceIndex !== 1)).toBe(true);
    expect(pkg.timings.every((t) => t.index !== 1)).toBe(true);
  });

  it('carries only lemma-level info for blanks, not surface text', () => {
    const pkg = toShareablePackage(buildLesson());
    expect(pkg.blanks).toEqual([{ sentenceIndex: 0, ranges: [{ start: 4, end: 10 }], lemma: 'klein' }]);
  });

  it('includes sourceUrl for dw-sourced lessons and title as a content identifier', () => {
    const pkg = toShareablePackage(buildLesson());
    expect(pkg.sourceUrl).toBe('https://example.invalid/l-99999999');
    expect(pkg.title).toBe('Alltagsdeutsch, 2025-11-03');
  });

  it('omits sourceUrl for manually-sourced lessons', () => {
    const manual = buildLesson();
    manual.source = { type: 'manual' };
    const pkg = toShareablePackage(manual);
    expect(pkg.sourceUrl).toBeUndefined();
  });
});
