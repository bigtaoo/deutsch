// §3.1 / FR-11.17：ShareablePackage = f(Lesson)，白名单构造，纯函数。
// V1 不暴露 UI 入口，只在这里实现 + 测试，为将来 §3.1 的分享功能占位。
//
// 绝不能出现在返回值里的东西：Sentence.text / Blank.surface / VocabEntry.contextSentence，
// 以及任何 8 词以上的连续正文片段。测试文件断言这一点。

import type { Lesson, ShareablePackage } from '@/types/models';

export function toShareablePackage(lesson: Lesson): ShareablePackage {
  const timings: ShareablePackage['timings'] = [];
  const blanks: ShareablePackage['blanks'] = [];

  for (const sentence of lesson.sentences) {
    if (sentence.excluded) continue;

    if (sentence.startTime !== undefined && sentence.endTime !== undefined) {
      timings.push({ index: sentence.index, start: sentence.startTime, end: sentence.endTime });
    }

    for (const blank of sentence.blanks) {
      blanks.push({
        sentenceIndex: sentence.index,
        ranges: blank.ranges.map((r) => ({ start: r.start, end: r.end })),
        lemma: blank.lemma,
      });
    }
  }

  const pkg: ShareablePackage = {
    formatVersion: 1,
    timings,
    blanks,
  };

  if (lesson.source.type === 'dw') {
    pkg.sourceUrl = lesson.source.sourceUrl;
  }
  // 内容标识，不是正文：课程标题本身（如 "Alltagsdeutsch: Der deutsche Wald"），
  // 等同于引用一部作品的标题，不同于分发其内容。
  pkg.title = lesson.title;

  return pkg;
}
