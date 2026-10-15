// 变更 82：一课的逐句中译走服务器 AI，只补没有的、写回时核对原文。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson, Sentence } from '@/types/models';

vi.stubEnv('VITE_SYNC_API_BASE', 'https://sync.example.test');
vi.stubEnv('VITE_GOOGLE_WEB_CLIENT_ID', 'client-id');

const getSessionToken = vi.fn<() => Promise<string | undefined>>();
vi.mock('@/sync/session', () => ({ getSessionToken: () => getSessionToken() }));

const { translateLessonWithAi, queueLessonTranslation, untranslatedCount, __resetTranslationQueue, TRANSLATE_BATCH } =
  await import('./translate');
const { resetAiAvailability } = await import('./explain');
const { useLessonStore } = await import('@/state/useLessonStore');

const s = (index: number, text: string, extra: Partial<Sentence> = {}): Sentence => ({ index, text, ...extra }) as Sentence;
const lesson = (id: string, sentences: Sentence[]): Lesson =>
  ({ id, title: `Staffel 1 · ${id}`, source: { type: 'dw', dwLessonId: id, sourceUrl: '' }, sentences, createdAt: 0, updatedAt: 0 }) as Lesson;

function reply(translations: string[]): Response {
  return new Response(JSON.stringify({ translations }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function sent(fetchMock: ReturnType<typeof vi.fn>, n = 0): { title?: string; lines: Array<{ speaker?: string; text: string }> } {
  return JSON.parse((fetchMock.mock.calls[n][1] as RequestInit).body as string);
}

/** 真的 patchLesson 会落库；这里只改内存，够测「写回了什么」。 */
const saveLesson = vi.fn(async (l: Lesson) => {
  useLessonStore.setState({ lessons: useLessonStore.getState().lessons.map((x) => (x.id === l.id ? l : x)) });
});
const patchLesson = vi.fn(async (id: string, updater: (l: Lesson) => Lesson) => {
  const l = useLessonStore.getState().lessons.find((x) => x.id === id);
  if (l) await saveLesson(updater(l));
});
const get = (id: string) => useLessonStore.getState().lessons.find((l) => l.id === id)!;

beforeEach(() => {
  getSessionToken.mockResolvedValue('tok');
  resetAiAvailability();
  __resetTranslationQueue();
  saveLesson.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function setLessons(...lessons: Lesson[]) {
  useLessonStore.setState({ lessons, patchLesson } as never);
}

describe('translateLessonWithAi', () => {
  it('只问没有译文的句子（排除句、已有译文的都不发），说话人与标题一起带上', async () => {
    setLessons(
      lesson('A', [
        s(0, 'Wow – das ist also Köln.', { speaker: 'JOJO' }),
        s(1, 'Glossar', { excluded: true }),
        s(2, 'Wohin soll es gehen?', { speaker: 'REZA', translation: '去哪儿？（我自己粘的）' }),
        s(3, 'Zum Bahnhof.', { speaker: 'JOJO' }),
      ]),
    );
    const fetchMock = vi.fn().mockResolvedValue(reply(['哇，原来这就是科隆。', '去火车站。']));
    vi.stubGlobal('fetch', fetchMock);

    expect(await translateLessonWithAi('A')).toEqual({ translated: 2 });
    expect(sent(fetchMock)).toEqual({
      title: 'Staffel 1 · A',
      lines: [
        { speaker: 'JOJO', text: 'Wow – das ist also Köln.' },
        { speaker: 'JOJO', text: 'Zum Bahnhof.' },
      ],
    });
    expect(get('A').sentences.map((x) => x.translation)).toEqual(['哇，原来这就是科隆。', undefined, '去哪儿？（我自己粘的）', '去火车站。']);
  });

  it('全都有译文：一个请求都不发', async () => {
    setLessons(lesson('A', [s(0, 'Hallo.', { translation: '你好。' })]));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await translateLessonWithAi('A')).toEqual({ translated: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('问的这段时间里句子被改了字 / 被人粘了译文：那几句不填（错位比没有更糟）', async () => {
    setLessons(lesson('A', [s(0, 'Hallo.'), s(1, 'Tschüss.'), s(2, 'Danke.')]));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        useLessonStore.setState({
          lessons: [lesson('A', [s(0, 'Hallo!'), s(1, 'Tschüss.', { translation: '拜拜（手粘）' }), s(2, 'Danke.')])],
        });
        return reply(['你好。', '再见。', '谢谢。']);
      }),
    );
    expect(await translateLessonWithAi('A')).toEqual({ translated: 1 });
    expect(get('A').sentences.map((x) => x.translation)).toEqual([undefined, '拜拜（手粘）', '谢谢。']);
  });

  it(`超过 ${TRANSLATE_BATCH} 句分批问`, async () => {
    const many = Array.from({ length: TRANSLATE_BATCH + 5 }, (_, i) => s(i, `Satz ${i}.`));
    setLessons(lesson('A', many));
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const { lines } = JSON.parse(init.body as string) as { lines: unknown[] };
      return reply(lines.map((_, i) => `第 ${i} 句`));
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await translateLessonWithAi('A')).toEqual({ translated: TRANSLATE_BATCH + 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(fetchMock, 1).lines).toHaveLength(5);
  });

  it('服务器报错 → 抛出来（译文页的按钮要把原因说出来）', async () => {
    setLessons(lesson('A', [s(0, 'Hallo.')]));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'AI 返回了 1 条，要的是 2 条', code: 'ai_failed' }), { status: 502 })));
    await expect(translateLessonWithAi('A')).rejects.toThrow();
    expect(get('A').sentences[0].translation).toBeUndefined();
  });
});

describe('queueLessonTranslation', () => {
  it('一课一课串行地问；一课失败不挡后面的', async () => {
    setLessons(lesson('A', [s(0, 'A.')]), lesson('B', [s(0, 'B.')]), lesson('C', [s(0, 'C.')]));
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const text = (JSON.parse(init.body as string) as { lines: Array<{ text: string }> }).lines[0].text;
      if (text === 'B.') return new Response('{}', { status: 502 });
      return reply([`译 ${text}`]);
    });
    vi.stubGlobal('fetch', fetchMock);

    void queueLessonTranslation(['A', 'B']);
    await queueLessonTranslation(['C', 'A']); // 已在排的 A 不重复排
    expect(maxInFlight).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(['A', 'B', 'C'].map((id) => get(id).sentences[0].translation)).toEqual(['译 A.', undefined, '译 C.']);
  });

  it('没登录：整队丢掉，一个请求都不发', async () => {
    getSessionToken.mockResolvedValue(undefined);
    setLessons(lesson('A', [s(0, 'A.')]));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await queueLessonTranslation(['A']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('untranslatedCount', () => {
  it('排除句、空句、已有译文的都不算', () => {
    expect(untranslatedCount([s(0, 'a'), s(1, 'b', { excluded: true }), s(2, ' '), s(3, 'c', { translation: '丙' })])).toBe(1);
  });
});
