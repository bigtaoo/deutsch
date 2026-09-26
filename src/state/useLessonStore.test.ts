// 课程与素材缓存的唯一写入口。文件顶部点名了两件「容易出事所以集中在这里做」的事，
// 这里就按那两件来验：
//
// ① 任何改动都要 touch updatedAt —— §2.4 的合并规则拿它比新旧。漏了 touch 的症状是
//    「在手机上改的东西同步回桌面就没了」，而且要过好几天才有人发现。
// ② 句子结构编辑会重排 index，必须同步 VocabEntry.sentenceIndex。漏了的症状是
//    生词的出处静默错位：点「去这一课」跳到另一句上。
//
// 外加 saveLesson 那条「先改内存再落库」—— 它修的是「连按 Enter 打点只留下最后一下」。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import { getLesson, getAllLessons } from '@/db/lessons';
import { getLessonCache, hasCachedAudio } from '@/db/cache';
import { getVocabEntriesByLesson, putVocabEntry } from '@/db/vocab';
import type { Sentence, VocabEntry } from '@/types/models';

const scheduleLessonSync = vi.fn();
const syncLessonDeletion = vi.fn(async (_id: string) => {});
vi.mock('@/sync/trigger', () => ({
  scheduleLessonSync: (id: string) => scheduleLessonSync(id),
  syncLessonDeletion: (id: string) => syncLessonDeletion(id),
}));

// jsdom 里 <audio> 永远不会触发 loadedmetadata，真读会挂在那儿。
const readAudioDuration = vi.fn(async (_file: File) => 123.5);
vi.mock('@/audio/player', () => ({
  readAudioDuration: (file: File) => readAudioDuration(file),
}));

const { DURATION_TOLERANCE_SECONDS, isMaterialMissing, isRehydratable, useLessonStore } =
  await import('./useLessonStore');

const TEXT = 'Erster Satz. Zweiter Satz. Dritter Satz.';

function audioFile(name = 'lektion.mp3', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: 'audio/mpeg' });
}

function vocab(overrides: Partial<VocabEntry>): VocabEntry {
  return {
    id: 'v1',
    surface: 'Wort',
    hasTimestamp: false,
    suspended: false,
    fsrs: {
      due: 0,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: 0,
    },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useLessonStore.setState({ lessons: [], caches: {}, loaded: false });
});

afterEach(async () => {
  vi.clearAllMocks();
  const db = await getDB();
  db.close();
  _resetDBForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe('createLesson', () => {
  it('切句、落库、进内存，并排一次同步', async () => {
    const id = await useLessonStore.getState().createLesson({ title: 'Lektion', plainText: TEXT });

    const stored = await getLesson(id);
    expect(stored?.sentences).toHaveLength(3);
    expect(stored?.manuscriptHash).toBeTruthy();
    expect(useLessonStore.getState().lessons.map((l) => l.id)).toEqual([id]);
    expect(scheduleLessonSync).toHaveBeenCalledWith(id);
  });

  it('原文进缓存层、不进标注层 —— 分层标准就在这一行上（§2.3）', async () => {
    const id = await useLessonStore.getState().createLesson({ title: 'Lektion', plainText: TEXT });
    expect((await getLessonCache(id))?.plainText).toBe(TEXT);
    expect(await getLesson(id)).not.toHaveProperty('plainText');
  });

  it('带音频文件时读时长、存 blob、记文件名', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      audioFile: audioFile('alltagsdeutsch.mp3', 2048),
    });

    const stored = await getLesson(id);
    expect(stored?.audioDuration).toBe(123.5);
    expect(stored?.source).toEqual({ type: 'manual', audioFileName: 'alltagsdeutsch.mp3' });
    expect(await hasCachedAudio(id)).toBe(true);
    expect((await getLessonCache(id))?.audioBytes).toBe(2048);
  });

  it('手动导入也在标注层记下字节数 —— 另一台设备重绑同一个文件时靠它认出是同一份（FR-3.6a）', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      audioFile: audioFile('track.mp3', 4096),
    });
    expect((await getLesson(id))!.audioBytes).toBe(4096);
  });

  it('几轨拼起来的课记下全部文件名（按拼接顺序），第一个同时是 audioFileName（FR-1.8）', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Kapitel 1 · Modul 2 Aufgabe 2a',
      plainText: TEXT,
      audioFile: audioFile('1_02 +7.mp3'),
      audioFiles: ['1_02.mp3', '1_03.mp3'],
    });
    expect((await getLesson(id))!.source).toEqual({
      type: 'manual',
      audioFileName: '1_02.mp3',
      audioFiles: ['1_02.mp3', '1_03.mp3'],
    });
  });

  it('分组名去掉首尾空白再存；空串等于不分组（FR-1.9）', async () => {
    const a = await useLessonStore.getState().createLesson({ title: 'A', plainText: TEXT, collection: '  Aspekte neu C1 ' });
    const b = await useLessonStore.getState().createLesson({ title: 'B', plainText: TEXT, collection: '   ' });
    expect((await getLesson(a))!.collection).toBe('Aspekte neu C1');
    expect(await getLesson(b)).not.toHaveProperty('collection');
  });

  it('给了说话人清单就从行首剥掉、记在第一句上，并把清单存进课程（FR-1.7）', async () => {
    const text = '● Hallo. Wie geht’s?\n○ Gut.';
    const id = await useLessonStore.getState().createLesson({ title: 'Dialog', plainText: text, speakers: ['●', '○'] });
    const stored = (await getLesson(id))!;
    expect(stored.speakers).toEqual(['●', '○']);
    expect(stored.sentences.map((s) => [s.speaker, s.text])).toEqual([
      ['●', 'Hallo.'],
      [undefined, 'Wie geht’s?'],
      ['○', 'Gut.'],
    ]);
  });

  it('空清单等于没给：不存 speakers 字段，切句与以前一样', async () => {
    const id = await useLessonStore.getState().createLesson({ title: 'X', plainText: '● Hallo.', speakers: [] });
    const stored = (await getLesson(id))!;
    expect(stored).not.toHaveProperty('speakers');
    expect(stored.sentences[0].text).toBe('● Hallo.');
  });

  it('给了 dwLessonId 就是 DW 来源，因此可以自动补齐（FR-3.5）', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      dwLessonId: '45334084',
      sourceUrl: 'https://example.invalid/l-45334084',
    });
    const stored = (await getLesson(id))!;
    expect(stored.source).toEqual({
      type: 'dw',
      dwLessonId: '45334084',
      sourceUrl: 'https://example.invalid/l-45334084',
    });
    expect(isRehydratable(stored)).toBe(true);
  });

  it('两课的 id 不同，新课排在列表最前', async () => {
    const first = await useLessonStore.getState().createLesson({ title: 'A', plainText: TEXT });
    const second = await useLessonStore.getState().createLesson({ title: 'B', plainText: TEXT });
    expect(first).not.toBe(second);
    expect(useLessonStore.getState().lessons.map((l) => l.id)).toEqual([second, first]);
  });
});

describe('saveLesson / patchLesson', () => {
  it('每次保存都推进 updatedAt —— §2.4 靠它判新旧', async () => {
    const id = await useLessonStore.getState().createLesson({ title: 'Lektion', plainText: TEXT });
    const before = (await getLesson(id))!.updatedAt;
    vi.useFakeTimers({ now: before + 1000, toFake: ['Date'] });
    await useLessonStore.getState().patchLesson(id, (l) => ({ ...l, title: '改过' }));
    vi.useRealTimers();
    expect((await getLesson(id))!.updatedAt).toBeGreaterThan(before);
  });

  it('内存先于落库更新：同一帧连打两次点，两次都留得下来', async () => {
    const id = await useLessonStore.getState().createLesson({ title: 'Lektion', plainText: TEXT });
    const mark = (index: number, at: number) =>
      useLessonStore.getState().patchLesson(id, (l) => ({
        ...l,
        sentences: l.sentences.map((s) => (s.index === index ? { ...s, startTime: at } : s)),
      }));

    // 不 await 第一次就发第二次 —— 组件里连按 Enter 就是这个形状。
    await Promise.all([mark(0, 1.5), mark(1, 3.5)]);

    const stored = (await getLesson(id))!;
    expect(stored.sentences[0].startTime).toBe(1.5);
    expect(stored.sentences[1].startTime).toBe(3.5);
  });

  it('patch 一个不存在的课是空操作，不抛', async () => {
    await expect(
      useLessonStore.getState().patchLesson('gibt-es-nicht', (l) => l),
    ).resolves.toBeUndefined();
    expect(scheduleLessonSync).not.toHaveBeenCalled();
  });
});

describe('updateSentences 与生词的句号', () => {
  async function lessonWithVocab() {
    const id = await useLessonStore.getState().createLesson({ title: 'Lektion', plainText: TEXT });
    await putVocabEntry(vocab({ id: 'v0', lessonId: id, sentenceIndex: 0 }));
    await putVocabEntry(vocab({ id: 'v2', lessonId: id, sentenceIndex: 2 }));
    return id;
  }

  const renumber = (sentences: Sentence[]): Sentence[] =>
    sentences.map((s, i) => ({ ...s, index: i }));

  it('给了 indexMap 就把生词的 sentenceIndex 一起搬走', async () => {
    const id = await lessonWithVocab();
    const sentences = useLessonStore.getState().lessons[0].sentences;
    // 删掉第 0 句：原来的 1→0、2→1。
    await useLessonStore
      .getState()
      .updateSentences(id, renumber(sentences.slice(1)), new Map([[1, 0], [2, 1]]));

    const byId = new Map((await getVocabEntriesByLesson(id)).map((e) => [e.id, e.sentenceIndex]));
    expect(byId.get('v2')).toBe(1);
    // 映射里没有 0（那一句没了），所以 v0 保持原样 —— 不该被改成 undefined。
    expect(byId.get('v0')).toBe(0);
  });

  it('没给 indexMap 就一个生词都不动 —— 纯改内容的编辑不该碰句号', async () => {
    const id = await lessonWithVocab();
    const sentences = useLessonStore.getState().lessons[0].sentences;
    await useLessonStore
      .getState()
      .updateSentences(id, sentences.map((s) => ({ ...s, markedDifficult: true })));

    const byId = new Map((await getVocabEntriesByLesson(id)).map((e) => [e.id, e.sentenceIndex]));
    expect(byId.get('v0')).toBe(0);
    expect(byId.get('v2')).toBe(2);
  });

  it('映射到同一个号的不重写库（少一次写、少一次同步）', async () => {
    const id = await lessonWithVocab();
    const sentences = useLessonStore.getState().lessons[0].sentences;
    const before = await getVocabEntriesByLesson(id);
    await useLessonStore.getState().updateSentences(id, sentences, new Map([[0, 0], [2, 2]]));
    expect(await getVocabEntriesByLesson(id)).toEqual(before);
  });

  it('课程不在内存里时从库里捞 —— 深链接直接进切句页就是这个场景', async () => {
    const id = await useLessonStore.getState().createLesson({ title: 'Lektion', plainText: TEXT });
    useLessonStore.setState({ lessons: [], caches: {}, loaded: false });
    await useLessonStore.getState().updateSentences(id, []);
    expect((await getLesson(id))!.sentences).toEqual([]);
  });
});

describe('resegmentLesson（FR-1.5）', () => {
  it('按新文稿重切，保留匹配上的标注，并换掉 manuscriptHash', async () => {
    const id = await useLessonStore.getState().createLesson({ title: 'Lektion', plainText: TEXT });
    const hashBefore = (await getLesson(id))!.manuscriptHash;

    const result = await useLessonStore
      .getState()
      .resegmentLesson(id, `${TEXT} Vierter Satz.`);

    expect(result.sentences).toHaveLength(4);
    const stored = (await getLesson(id))!;
    expect(stored.sentences).toHaveLength(4);
    expect(stored.manuscriptHash).not.toBe(hashBefore);
    expect((await getLessonCache(id))?.plainText).toBe(`${TEXT} Vierter Satz.`);
  });

  it('用这一课当初的说话人清单重切 —— 换一份清单同一行切出来的文本不同，一句都认领不上', async () => {
    const text = '● Hallo.\n○ Gut.';
    const id = await useLessonStore.getState().createLesson({ title: 'Dialog', plainText: text, speakers: ['●', '○'] });
    await useLessonStore.getState().patchLesson(id, (l) => ({
      ...l,
      sentences: l.sentences.map((s) => ({ ...s, startTime: s.index * 2, timingSource: 'auto' as const })),
    }));

    const result = await useLessonStore.getState().resegmentLesson(id, `${text}\n● Tschüss.`);

    expect(result.sentences.map((s) => [s.speaker, s.text, s.startTime])).toEqual([
      ['●', 'Hallo.', 0],
      ['○', 'Gut.', 2],
      ['●', 'Tschüss.', undefined],
    ]);
  });

  it('课程不存在时抛，而不是静默建一课', async () => {
    await expect(
      useLessonStore.getState().resegmentLesson('gibt-es-nicht', TEXT),
    ).rejects.toThrow('课程不存在');
  });
});

describe('attachAudio（FR-3.6）', () => {
  it('第一次绑音频：记下时长，不报不匹配', async () => {
    const id = await useLessonStore.getState().createLesson({ title: 'Lektion', plainText: TEXT });
    const { duration, mismatch } = await useLessonStore.getState().attachAudio(id, audioFile());
    expect(duration).toBe(123.5);
    expect(mismatch).toBe(false);
    expect((await getLesson(id))!.audioDuration).toBe(123.5);
    expect(await hasCachedAudio(id)).toBe(true);
  });

  it('换了个时长明显不同的文件：报不匹配，但不拦着', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      audioFile: audioFile(),
    });
    readAudioDuration.mockResolvedValueOnce(123.5 + DURATION_TOLERANCE_SECONDS + 1);
    const { mismatch } = await useLessonStore.getState().attachAudio(id, audioFile('anders.mp3'));
    expect(mismatch).toBe(true);
    // 已有时长不被覆盖 —— 时间戳还是按它标的。
    expect((await getLesson(id))!.audioDuration).toBe(123.5);
  });

  it('绑回同一个文件（字节数一样）：audioChanged 为 false —— 调用方据此不重对齐（FR-3.6a）', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      audioFile: audioFile('track.mp3', 4096),
    });
    const outcome = await useLessonStore.getState().attachAudio(id, audioFile('track.mp3', 4096));
    expect(outcome.audioChanged).toBe(false);
  });

  it('字节数不同但时长在容差内（WAV 兜底在别的浏览器上差几个采样）：不算换了音频', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      audioFile: audioFile('a +1.wav', 4096),
    });
    readAudioDuration.mockResolvedValueOnce(123.5 + 0.01);
    expect((await useLessonStore.getState().attachAudio(id, audioFile('a +1.wav', 4100))).audioChanged).toBe(false);
  });

  it('字节数不同且时长对不上：换了音频', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      audioFile: audioFile('a.mp3', 4096),
    });
    readAudioDuration.mockResolvedValueOnce(200);
    expect((await useLessonStore.getState().attachAudio(id, audioFile('b.mp3', 9999))).audioChanged).toBe(true);
  });

  it('什么都没记过的课（没有字节数也没有时长）只能当作换过', async () => {
    const id = await useLessonStore.getState().createLesson({ title: 'Lektion', plainText: TEXT });
    expect((await useLessonStore.getState().attachAudio(id, audioFile())).audioChanged).toBe(true);
  });

  it('audioChanged 是拿写回之前的字节数比的 —— 写回之后再比永远相等', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      audioFile: audioFile('a.mp3', 100),
    });
    readAudioDuration.mockResolvedValueOnce(300);
    const first = await useLessonStore.getState().attachAudio(id, audioFile('b.mp3', 200));
    expect(first.audioChanged).toBe(true);
    expect((await getLesson(id))!.audioBytes).toBe(200);
  });

  it('容差之内当成同一份', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      audioFile: audioFile(),
    });
    readAudioDuration.mockResolvedValueOnce(123.5 + DURATION_TOLERANCE_SECONDS - 0.01);
    expect((await useLessonStore.getState().attachAudio(id, audioFile())).mismatch).toBe(false);
  });
});

describe('删除与清缓存', () => {
  it('删课：库里、内存里都没了，远端也去删一次', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      audioFile: audioFile(),
    });
    await useLessonStore.getState().removeLesson(id);

    expect(await getAllLessons()).toEqual([]);
    expect(await getLessonCache(id)).toBeUndefined();
    expect(await hasCachedAudio(id)).toBe(false);
    expect(useLessonStore.getState().lessons).toEqual([]);
    // 不删远端的话，下次在另一台设备上恢复会把它原样拉回来。
    expect(syncLessonDeletion).toHaveBeenCalledWith(id);
  });

  it('清缓存只动缓存层，标注层一个字段都不掉（FR-3.8）', async () => {
    const id = await useLessonStore.getState().createLesson({
      title: 'Lektion',
      plainText: TEXT,
      audioFile: audioFile(),
    });
    const before = await getLesson(id);

    await useLessonStore.getState().clearCache(id);

    expect(await getLesson(id)).toEqual(before);
    expect(await hasCachedAudio(id)).toBe(false);
    expect(useLessonStore.getState().caches[id]).toBeUndefined();
  });
});

describe('load', () => {
  it('按 createdAt 倒序排 —— 最新一课在最上面', async () => {
    const older = await useLessonStore.getState().createLesson({ title: '旧', plainText: TEXT });
    vi.useFakeTimers({ now: Date.now() + 10_000, toFake: ['Date'] });
    const newer = await useLessonStore.getState().createLesson({ title: '新', plainText: TEXT });
    vi.useRealTimers();

    useLessonStore.setState({ lessons: [], caches: {}, loaded: false });
    await useLessonStore.getState().load();

    expect(useLessonStore.getState().lessons.map((l) => l.id)).toEqual([newer, older]);
    expect(useLessonStore.getState().loaded).toBe(true);
  });
});

describe('isMaterialMissing（FR-3.4）', () => {
  it('没缓存、有缓存但没音频，都算「素材未下载」', () => {
    expect(isMaterialMissing(undefined)).toBe(true);
    expect(
      isMaterialMissing({ lessonId: 'l1', hasAudio: false, audioBytes: 0, fetchedAt: 0 }),
    ).toBe(true);
    expect(
      isMaterialMissing({ lessonId: 'l1', hasAudio: true, audioBytes: 10, fetchedAt: 0 }),
    ).toBe(false);
  });
});
