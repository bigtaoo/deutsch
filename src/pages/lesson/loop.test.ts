// FR-5.7 循环播放（变更 84）：档位、组内顺序、换课之后自动接着放。
//
// 写错的症状：顺播停在一课没有音频的课上（整条断了）、到组尾不回组首、
// 档位刷新后丢了、上一课放完跳过来却不开始放。

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lesson, LessonCache } from '@/types/models';
import {
  consumeAutoplay,
  getLoopMode,
  groupPlaylist,
  markAutoplay,
  nextInGroup,
  nextLoopMode,
  resetLoopModeForTest,
  setLoopMode,
} from './loop';

function lesson(id: string, title: string, collection?: string, type: 'manual' | 'dw' = 'manual'): Lesson {
  return { id, title, collection, source: { type }, createdAt: 0, sentences: [] } as unknown as Lesson;
}

const BOOK = [
  lesson('k2a', 'Kapitel 2 · A1', 'Aspekte'),
  lesson('k10a', 'Kapitel 10 · A1', 'Aspekte'),
  lesson('k1b', 'Kapitel 1 · B2', 'Aspekte'),
  lesson('k1a', 'Kapitel 1 · A1', 'Aspekte'),
];
const SOLO = lesson('solo', 'Einzeln');

const audio = (...ids: string[]): Record<string, LessonCache> =>
  Object.fromEntries(ids.map((id) => [id, { hasAudio: true } as LessonCache]));

// jsdom 在这套配置下不给 localStorage（opaque origin，见 align/journal.test.ts），自己给一个。
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});

afterEach(() => {
  store.clear();
  resetLoopModeForTest();
});

describe('档位', () => {
  it('不循环 → 本课循环 → 顺播本组 → 不循环', () => {
    expect(nextLoopMode('off')).toBe('lesson');
    expect(nextLoopMode('lesson')).toBe('group');
    expect(nextLoopMode('group')).toBe('off');
  });

  it('存在本机，读回来一样；没存过 / 存了垃圾都是 off', () => {
    expect(getLoopMode()).toBe('off');
    setLoopMode('group');
    expect(getLoopMode()).toBe('group');
    localStorage.setItem('deutsch.loopMode', 'bogus');
    expect(getLoopMode()).toBe('off');
  });
});

describe('groupPlaylist', () => {
  it('顺序与课程页一致：按章自然排序依次展开', () => {
    const g = groupPlaylist([...BOOK, SOLO], 'k10a')!;
    expect(g.name).toBe('Aspekte');
    expect(g.order.map((l) => l.id)).toEqual(['k1a', 'k1b', 'k2a', 'k10a']);
  });

  it('没分组的课：null', () => {
    expect(groupPlaylist([...BOOK, SOLO], 'solo')).toBeNull();
  });
});

describe('nextInGroup', () => {
  const all = [...BOOK, SOLO];
  const caches = audio('k1a', 'k1b', 'k2a', 'k10a');

  it('下一课 / 上一课；到末尾回到组首，到组首往前回到末尾', () => {
    expect(nextInGroup(all, caches, 'k1a')).toBe('k1b');
    expect(nextInGroup(all, caches, 'k10a')).toBe('k1a');
    expect(nextInGroup(all, caches, 'k1a', -1)).toBe('k10a');
  });

  it('本机没有音频的课跳过', () => {
    expect(nextInGroup(all, audio('k1a', 'k10a'), 'k1a')).toBe('k10a');
  });

  it('当前这课自己没缓存也照样能往下走（正在放说明它有）', () => {
    expect(nextInGroup(all, audio('k2a'), 'k1a')).toBe('k2a');
  });

  it('组里只剩自己能放、或没分组：返回自己（从头再放）', () => {
    expect(nextInGroup(all, audio('k1a'), 'k1a')).toBe('k1a');
    expect(nextInGroup(all, caches, 'solo')).toBe('solo');
  });
});

describe('换课后自动放', () => {
  it('只对标记的那一课生效，且只生效一次', () => {
    markAutoplay('k1b');
    expect(consumeAutoplay('k1a')).toBe(false);
    expect(consumeAutoplay('k1b')).toBe(true);
    expect(consumeAutoplay('k1b')).toBe(false);
  });
});
