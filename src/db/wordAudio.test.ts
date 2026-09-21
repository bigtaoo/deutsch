// FR-17.6：预置卡发音的缓存。这个 store 有两处容易被写错，都不会报错、只会算错：
//
// ① 「问过但没有」也要记一条（值里没有 blob）。不记的话每次批量预取都会把那几百个
//    查不到的词再问一遍 Wiktionary —— 而它们永远查不到。
// ② 用量统计要把这一块算进去（FR-3.8）。只数有 blob 的那些，否则「占了多少」是错的。

import { afterEach, describe, expect, it } from 'vitest';
import { getDB, _resetDBForTests } from './index';
import { DB_NAME } from './schema';
import {
  clearWordAudio,
  getWordAudio,
  getWordAudioBytes,
  knownWordAudioKeys,
  putWordAudio,
} from './wordAudio';

function blob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' });
}

afterEach(async () => {
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

describe('读写', () => {
  it('存进去读得回，键是归一化词元键', async () => {
    await putWordAudio('strasse', { lemma: 'Straße', blob: blob(128), file: 'De-Straße.ogg', fetchedAt: 1 });
    const stored = await getWordAudio('strasse');
    expect(stored?.lemma).toBe('Straße');
    expect(stored?.file).toBe('De-Straße.ogg');
    // 有没有录音这一位要准；**Blob 本身在这里验不了** —— fake-indexeddb 的结构化克隆
    // 不保留它，往返之后只剩一个空对象（db.test.ts 里那两条也因此只验有无）。
    expect(stored?.blob).toBeDefined();
  });

  it('没存过的键是 undefined，不抛', async () => {
    expect(await getWordAudio('nie-gefragt')).toBeUndefined();
  });

  it('再存一次是覆盖 —— 同一个词不该攒出两份录音', async () => {
    await putWordAudio('haus', { lemma: 'Haus', blob: blob(10), fetchedAt: 1 });
    await putWordAudio('haus', { lemma: 'Haus', blob: blob(20), fetchedAt: 2 });
    expect(await getWordAudio('haus')).toMatchObject({ fetchedAt: 2 });
    expect((await knownWordAudioKeys()).size).toBe(1);
  });
});

describe('问过但没有', () => {
  it('否定结果也进库，且会出现在「问过的键」里', async () => {
    await putWordAudio('kein-audio', { lemma: 'Kein', fetchedAt: 1 });
    expect(await getWordAudio('kein-audio')).toMatchObject({ lemma: 'Kein' });
    expect((await getWordAudio('kein-audio'))?.blob).toBeUndefined();
    expect((await knownWordAudioKeys()).has('kein-audio')).toBe(true);
  });

  it('批量预取据此跳过 —— 查不到的词不该每次都再问一遍 Wiktionary', async () => {
    await putWordAudio('a', { lemma: 'A', blob: blob(4), fetchedAt: 1 });
    await putWordAudio('b', { lemma: 'Kein', fetchedAt: 1 });
    const known = await knownWordAudioKeys();
    expect([...known].sort()).toEqual(['a', 'b']);
    expect(['a', 'b', 'c'].filter((k) => !known.has(k))).toEqual(['c']);
  });
});

describe('用量统计（FR-3.8）', () => {
  // 字节数在这个环境里验不了（见上面那条注释），能验的是**数谁**：
  // 把否定结果也算成一条录音的话，素材页上的条数会比实际多出一大截。
  it('只数有录音的那些，「问过但没有」不算', async () => {
    await putWordAudio('a', { lemma: 'A', blob: blob(100), fetchedAt: 1 });
    await putWordAudio('b', { lemma: 'B', blob: blob(200), fetchedAt: 1 });
    await putWordAudio('c', { lemma: 'Kein', fetchedAt: 1 });

    expect((await knownWordAudioKeys()).size).toBe(3);
    expect((await getWordAudioBytes()).count).toBe(2);
  });

  it('空库是 0/0，不是 NaN', async () => {
    expect(await getWordAudioBytes()).toEqual({ count: 0, bytes: 0 });
  });
});

describe('清缓存', () => {
  it('整块清掉之后连「问过」都不记得了 —— 它整个属于缓存层', async () => {
    await putWordAudio('a', { lemma: 'A', blob: blob(10), fetchedAt: 1 });
    await putWordAudio('b', { lemma: 'Kein', fetchedAt: 1 });

    await clearWordAudio();

    expect((await knownWordAudioKeys()).size).toBe(0);
    expect(await getWordAudioBytes()).toEqual({ count: 0, bytes: 0 });
  });
});
