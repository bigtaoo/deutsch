// 变更 83：译文包 —— 按原文顺序对，只补空的，对不上的留空。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTranslationPack, fillFromPack, parseTranslationPack, PACK_FORMAT, type TranslationPack } from './translationPack';
import { useLessonStore } from '@/state/useLessonStore';
import type { Lesson, Sentence } from '@/types/models';

const s = (index: number, text: string, extra: Partial<Sentence> = {}): Sentence => ({ index, text, ...extra }) as Sentence;
const lesson = (id: string, dwLessonId: string, sentences: Sentence[]): Lesson =>
  ({ id, title: id, source: { type: 'dw', dwLessonId, sourceUrl: '' }, sentences, createdAt: 0, updatedAt: 0 }) as Lesson;
const pack = (lessons: TranslationPack['lessons']): TranslationPack => ({ format: PACK_FORMAT, version: 1, lessons });

describe('parseTranslationPack', () => {
  it('不是 JSON / format 不对 / 版本不认识：说人话的错', () => {
    expect(() => parseTranslationPack('{')).toThrow('不是 JSON 文件');
    expect(() => parseTranslationPack('{"format":"x"}')).toThrow('不是译文包');
    expect(() => parseTranslationPack(JSON.stringify({ format: PACK_FORMAT, version: 2, lessons: [] }))).toThrow('版本');
  });

  it('坏条目跳过，空译文丢掉', () => {
    const p = parseTranslationPack(
      JSON.stringify({
        format: PACK_FORMAT,
        version: 1,
        lessons: [{ title: '没 id', sentences: [] }, { dwLessonId: '1', sentences: [{ de: 'Ja.', zh: '是。' }, { de: 'Nein.', zh: ' ' }] }],
      }),
    );
    expect(p.lessons).toEqual([{ dwLessonId: '1', sentences: [{ de: 'Ja.', zh: '是。' }] }]);
  });
});

describe('fillFromPack', () => {
  it('按原文顺序对：重复的短句各对各的，空白差异不算', () => {
    const out = fillFromPack(
      [s(0, 'Ja.'), s(1, 'Komm  mit!'), s(2, 'Ja.')],
      [
        { de: 'Ja.', zh: '好。' },
        { de: 'Komm mit!', zh: '一起来！' },
        { de: 'Ja.', zh: '行吧。' },
      ],
    );
    expect(out.sentences.map((x) => x.translation)).toEqual(['好。', '一起来！', '行吧。']);
    expect(out.filled).toBe(3);
  });

  it('本地合并过的句子对不上：那一句留空，后面照样对上，不错位', () => {
    const out = fillFromPack(
      [s(0, 'Hallo. Wie geht’s?'), s(1, 'Gut.')],
      [
        { de: 'Hallo.', zh: '你好。' },
        { de: 'Wie geht’s?', zh: '最近好吗？' },
        { de: 'Gut.', zh: '挺好。' },
      ],
    );
    expect(out.sentences.map((x) => x.translation)).toEqual([undefined, '挺好。']);
    expect(out.filled).toBe(1);
  });

  it('已有译文的、排除句不碰，但仍占位往下对', () => {
    const out = fillFromPack(
      [s(0, 'A.', { translation: '我自己译的' }), s(1, 'B.', { excluded: true }), s(2, 'C.')],
      [
        { de: 'A.', zh: '甲' },
        { de: 'B.', zh: '乙' },
        { de: 'C.', zh: '丙' },
      ],
    );
    expect(out.sentences.map((x) => x.translation)).toEqual(['我自己译的', undefined, '丙']);
    expect(out.filled).toBe(1);
  });
});

describe('applyTranslationPack', () => {
  const saveLesson = vi.fn(async (l: Lesson) => {
    useLessonStore.setState({ lessons: useLessonStore.getState().lessons.map((x) => (x.id === l.id ? l : x)) });
  });
  const patchLesson = async (id: string, updater: (l: Lesson) => Lesson) => {
    const l = useLessonStore.getState().lessons.find((x) => x.id === id);
    if (l) await saveLesson(updater(l));
  };
  beforeEach(() => {
    saveLesson.mockClear();
  });

  it('按 dwLessonId 找课；没导的课报出来；一句都填不上的课不写回', async () => {
    useLessonStore.setState({
      lessons: [lesson('a', '100', [s(0, 'Ja.')]), lesson('b', '200', [s(0, 'Nein.', { translation: '不。' })])],
      patchLesson,
    } as never);
    const r = await applyTranslationPack(
      pack([
        { dwLessonId: '100', sentences: [{ de: 'Ja.', zh: '是。' }] },
        { dwLessonId: '200', sentences: [{ de: 'Nein.', zh: '不行。' }] },
        { dwLessonId: '300', title: '3 Eine Frau in der WG?', sentences: [] },
      ]),
    );
    expect(r).toEqual({ lessons: 1, filled: 1, missing: ['3 Eine Frau in der WG?'] });
    expect(saveLesson).toHaveBeenCalledTimes(1);
    expect(useLessonStore.getState().lessons[0].sentences[0].translation).toBe('是。');
    expect(useLessonStore.getState().lessons[1].sentences[0].translation).toBe('不。');
  });

  it('再导一次是幂等的：什么都不写', async () => {
    useLessonStore.setState({ lessons: [lesson('a', '100', [s(0, 'Ja.', { translation: '是。' })])], patchLesson } as never);
    const r = await applyTranslationPack(pack([{ dwLessonId: '100', sentences: [{ de: 'Ja.', zh: '是。' }] }]));
    expect(r).toEqual({ lessons: 0, filled: 0, missing: [] });
    expect(saveLesson).not.toHaveBeenCalled();
  });
});
