// FR-3.6a：绑本地音频之后要不要重对齐、拼过的课怎么认文件、整组补音频怎么认领。
//
// 起因（2026-09-26）：重绑音频之后**无条件** enqueueAlign —— 桌面对好、同步到手机的时间戳，
// 在手机上重新选一次同一个 mp3 就被送去服务器再算两分钟、原样盖回来。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson, Sentence } from '@/types/models';

const attachAudio = vi.fn();
const enqueue = vi.fn();
vi.mock('@/state/useLessonStore', () => ({
  useLessonStore: { getState: () => ({ attachAudio }) },
}));
vi.mock('@/state/useAlignStore', () => ({
  useAlignStore: { getState: () => ({ enqueue }) },
}));
const concatAudioFiles = vi.fn(async (files: File[]) => ({ file: files[0], method: 'bytes' as const }));
vi.mock('@/audio/concat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/audio/concat')>()),
  concatAudioFiles: (files: File[]) => concatAudioFiles(files),
}));

const { bindPickedAudio, isMultiTrack, listedAudioFiles, matchGroupFiles, shouldRealign } = await import('./bindAudio');

function sentence(startTime?: number): Sentence {
  return { index: 0, text: 'Hallo.', charStart: 0, charEnd: 6, startTime, endTimeExplicit: false, blanks: [], markedDifficult: false, excluded: false };
}

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: 'l1',
    title: 'Kapitel 1 · Modul 2 Aufgabe 2a',
    source: { type: 'manual', audioFileName: 'a.mp3' },
    sentences: [sentence(0)],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const file = (name: string) => new File([], name);

beforeEach(() => {
  vi.clearAllMocks();
  attachAudio.mockResolvedValue({ duration: 10, mismatch: false, audioChanged: false });
});

describe('shouldRealign', () => {
  it('有时间戳、音频没换：不重对 —— 这就是那个 bug', () => {
    expect(shouldRealign(lesson(), { duration: 10, mismatch: false, audioChanged: false })).toBe(false);
  });

  it('换了音频：重对', () => {
    expect(shouldRealign(lesson(), { duration: 10, mismatch: true, audioChanged: true })).toBe(true);
  });

  it('一句时间戳都没有：总要对一次', () => {
    expect(shouldRealign(lesson({ sentences: [sentence()] }), { duration: 10, mismatch: false, audioChanged: false })).toBe(true);
  });
});

describe('listedAudioFiles / isMultiTrack', () => {
  it('拼过的课按清单；单文件的课只有那一个；DW 的课没有', () => {
    expect(listedAudioFiles(lesson({ source: { type: 'manual', audioFileName: 'a', audioFiles: ['a', 'b'] } }))).toEqual(['a', 'b']);
    expect(listedAudioFiles(lesson())).toEqual(['a.mp3']);
    expect(listedAudioFiles(lesson({ source: { type: 'dw', dwLessonId: '1', sourceUrl: '' } }))).toEqual([]);
    expect(listedAudioFiles(lesson({ source: { type: 'manual' } }))).toEqual([]);
  });

  it('两个以上才算多轨', () => {
    expect(isMultiTrack(lesson())).toBe(false);
    expect(isMultiTrack(lesson({ source: { type: 'manual', audioFiles: ['a', 'b'] } }))).toBe(true);
  });
});

describe('bindPickedAudio', () => {
  it('同一份音频绑回来：绑上，但不排对齐', async () => {
    const result = await bindPickedAudio(lesson(), [file('a.mp3')]);
    expect(result).toMatchObject({ ok: true, realigned: false });
    expect(attachAudio).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('换了音频：绑上并排对齐', async () => {
    attachAudio.mockResolvedValue({ duration: 99, mismatch: true, audioChanged: true });
    const result = await bindPickedAudio(lesson(), [file('neu.mp3')]);
    expect(result).toMatchObject({ ok: true, realigned: true });
    expect(enqueue).toHaveBeenCalledWith('l1');
  });

  it('拼过的课：按清单顺序拼，不按选择顺序', async () => {
    const multi = lesson({ source: { type: 'manual', audioFileName: '1.mp3', audioFiles: ['1.mp3', '2.mp3', '3.mp3'] } });
    await bindPickedAudio(multi, [file('3.mp3'), file('1.mp3'), file('2.mp3'), file('fremd.mp3')]);
    expect(concatAudioFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['1.mp3', '2.mp3', '3.mp3']);
  });

  it('拼过的课少选了一轨：什么都不绑，把缺的报出来', async () => {
    const multi = lesson({ source: { type: 'manual', audioFiles: ['1.mp3', '2.mp3'] } });
    expect(await bindPickedAudio(multi, [file('1.mp3')])).toEqual({ ok: false, missing: ['2.mp3'] });
    expect(attachAudio).not.toHaveBeenCalled();
  });

  it('单文件的课多选了一堆：优先认记着的那个名字', async () => {
    await bindPickedAudio(lesson(), [file('x.mp3'), file('a.mp3')]);
    expect(concatAudioFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.mp3']);
  });

  it('单文件的课认不出名字：用第一个（和以前单选一样）', async () => {
    await bindPickedAudio(lesson(), [file('umbenannt.mp3')]);
    expect(concatAudioFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['umbenannt.mp3']);
  });
});

describe('matchGroupFiles', () => {
  it('每课按自己的清单认领；文件不全的课不认领', () => {
    const a = lesson({ id: 'a', source: { type: 'manual', audioFileName: '1.mp3' } });
    const b = lesson({ id: 'b', source: { type: 'manual', audioFiles: ['2.mp3', '3.mp3'] } });
    const c = lesson({ id: 'c', source: { type: 'manual', audioFiles: ['4.mp3', '5.mp3'] } });
    const d = lesson({ id: 'd', source: { type: 'manual' } }); // 很老的课，没记文件名
    const { matched, unmatched } = matchGroupFiles([a, b, c, d], [file('3.mp3'), file('1.mp3'), file('2.mp3'), file('4.mp3')]);
    expect(matched.map((m) => [m.lesson.id, m.files.map((f) => f.name)])).toEqual([
      ['a', ['1.mp3']],
      ['b', ['2.mp3', '3.mp3']],
    ]);
    expect(unmatched.map((l) => l.id)).toEqual(['c', 'd']);
  });
});
