import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushVocabFile, pushLessonFile, lessonPath } from './backupSync';
import { encodeBase64Utf8, decodeBase64Utf8 } from '@/lib/base64';
import type { Lesson, VocabEntry } from '@/types/models';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ref = { owner: 'tao', repo: 'backup', defaultBranch: 'main' };

function vocabEntry(overrides: Partial<VocabEntry>): VocabEntry {
  return {
    id: 'v1',
    surface: 'Wort',
    contextSentence: 'Ein Wort.',
    lessonId: 'l1',
    sentenceIndex: 0,
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

describe('pushVocabFile', () => {
  it('on conflict, merges remote + local vocab via §2.4 last-write-wins before retrying', async () => {
    const remote = [vocabEntry({ id: 'remote-only' }), vocabEntry({ id: 'v1', fsrs: { ...vocabEntry({}).fsrs, last_review: 5 } })];
    const local = [vocabEntry({ id: 'v1', fsrs: { ...vocabEntry({}).fsrs, last_review: 10 } })];

    let putCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (!init || init.method === undefined) {
          return Promise.resolve(
            new Response(JSON.stringify({ content: encodeBase64Utf8(JSON.stringify(remote)), sha: 'remote-sha', encoding: 'base64' }), {
              status: 200,
            }),
          );
        }
        putCount += 1;
        if (putCount === 1) return Promise.resolve(new Response('conflict', { status: 409 }));
        const body = JSON.parse((init.body as string) ?? '{}');
        const written = JSON.parse(decodeBase64Utf8(body.content as string)) as VocabEntry[];
        expect(written.map((v) => v.id).sort()).toEqual(['remote-only', 'v1']);
        expect(written.find((v) => v.id === 'v1')?.fsrs.last_review).toBe(10); // local 更新，胜出
        return Promise.resolve(new Response(JSON.stringify({ content: { sha: 'new-sha' } }), { status: 200 }));
      }),
    );

    const result = await pushVocabFile('token', ref, local, 'stale-sha');
    expect(result).toEqual({ sha: 'new-sha' });
  });
});

describe('pushLessonFile', () => {
  it('writes to lessons/<id>.json', async () => {
    const lesson: Lesson = {
      id: 'l1',
      title: 'T',
      source: { type: 'manual' },
      sentences: [],
      createdAt: 0,
      updatedAt: 0,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ content: { sha: 'sha1' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await pushLessonFile('token', ref, lesson);

    expect(fetchMock.mock.calls[0][0]).toContain(lessonPath('l1'));
  });
});
