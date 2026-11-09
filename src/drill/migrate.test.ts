// 变更 84：旧生词本（VocabEntry）迁进速背 —— applyVocabMigration 是纯函数，直接喂数据。
//
// 迁错的症状：词库里有的词被加成重复的手动词、速背里更近的进度被旧卡覆盖、
// 没复习过的词带着一张假进度进来（第一天就不当新词出）。

import { describe, expect, it } from 'vitest';
import { newCard } from '@/srs/fsrs';
import type { DictLookup } from '@/dict/types';
import type { FSRSCard, VocabEntry } from '@/types/models';
import { unifiedCard } from './daily';
import { applyVocabMigration, type MigrateRow } from './migrate';
import { emptyDrillState, withCustom, withProgress } from './state';
import type { Wordbank } from './types';
import { customItemId } from './wordbank';

const BANK: Wordbank = {
  version: 't',
  items: [{ id: 'kaution', w: 'Kaution', p: 'noun', g: 'f', zh: '押金', t: 'wohnen' }] as Wordbank['items'],
};

function entry(surface: string, extra: Partial<VocabEntry> = {}): VocabEntry {
  return { id: `v-${surface}`, surface, hasTimestamp: false, suspended: false, fsrs: newCard(new Date(0)), ...extra } as VocabEntry;
}

function reviewed(due: number, lastReview: number): FSRSCard {
  return { ...newCard(new Date(0)), state: 2, reps: 3, due, last_review: lastReview };
}

const verbDict = { entry: { w: 'vermieten', s: [{ p: 'verb', zh: ['出租'] }] }, via: 'exact' } as DictLookup;

function row(e: VocabEntry, zh: string, dict: DictLookup | null = null): MigrateRow {
  return { entry: e, zh, dict };
}

describe('applyVocabMigration', () => {
  it('词库里有的词：不加手动词，只把进度挂到词库那条 id 上', () => {
    const s = applyVocabMigration(emptyDrillState(), [row(entry('Kaution', { fsrs: reviewed(100, 50) }), '押金')], BANK, 1000);
    expect(Object.keys(s.custom)).toEqual([]);
    expect(unifiedCard(s, 'kaution')?.due).toBe(100);
  });

  it('词库里没有：加成手动词，词性从词典来；查词来的标 lookup、课程来的标 lesson 并带出处', () => {
    const s = applyVocabMigration(
      emptyDrillState(),
      [
        row(entry('vermietet', { lemma: 'vermieten', lookup: true }), '出租', verbDict),
        row(entry('Nebenkosten', { lessonId: 'L1', sentenceIndex: 4, gender: 'f' }), '附加费'),
      ],
      BANK,
      1000,
    );
    expect(s.custom[customItemId('vermieten')]).toMatchObject({ w: 'vermieten', p: 'verb', zh: '出租', src: 'lookup' });
    expect(s.custom[customItemId('Nebenkosten')]).toMatchObject({ p: 'other', g: 'f', src: 'lesson', lessonId: 'L1', si: 4 });
  });

  it('预置词库来的旧卡不算课程词（没有 src）', () => {
    const s = applyVocabMigration(emptyDrillState(), [row(entry('Gerede', { preset: { band: 5, rank: 1 }, lessonId: 'x' }), '闲话')], BANK, 1);
    expect(s.custom[customItemId('Gerede')]?.src).toBeUndefined();
  });

  it('没中文的手动词不迁（出不了四选一）', () => {
    const s = applyVocabMigration(emptyDrillState(), [row(entry('Quatsch'), '')], BANK, 1);
    expect(s.custom).toEqual({});
  });

  it('进度取听卡 / 读卡里最近复习过的那张；从没复习过的不写进度（当新词出）', () => {
    const s = applyVocabMigration(
      emptyDrillState(),
      [
        row(entry('Miete', { fsrs: reviewed(10, 5), fsrsRead: reviewed(20, 9) }), '房租'),
        row(entry('Mieter'), '租户'),
      ],
      BANK,
      1,
    );
    expect(unifiedCard(s, customItemId('Miete'))?.due).toBe(20);
    expect(unifiedCard(s, customItemId('Mieter'))).toBeUndefined();
  });

  it('速背里已经有进度的不覆盖 —— 那是更近的判断', () => {
    const before = withProgress(emptyDrillState(), 'audio', 'kaution', reviewed(999, 500), 1);
    const s = applyVocabMigration(before, [row(entry('Kaution', { fsrs: reviewed(100, 50) }), '押金')], BANK, 1000);
    expect(unifiedCard(s, 'kaution')?.due).toBe(999);
  });

  it('已经有的手动词不改写（另一台设备迁过、或手动加过）', () => {
    const before = withCustom(emptyDrillState(), { id: customItemId('Miete'), w: 'Miete', p: 'noun', zh: '我改过的中文' }, 1);
    const s = applyVocabMigration(before, [row(entry('Miete'), '房租')], BANK, 1000);
    expect(s.custom[customItemId('Miete')]?.zh).toBe('我改过的中文');
  });

  it('跑两遍结果一样（两台设备各迁一次）', () => {
    const rows = [row(entry('Miete', { fsrs: reviewed(10, 5) }), '房租'), row(entry('Kaution', { fsrs: reviewed(100, 50) }), '押金')];
    const once = applyVocabMigration(emptyDrillState(), rows, BANK, 1000);
    const twice = applyVocabMigration(once, rows, BANK, 2000);
    expect(twice.custom).toEqual(once.custom);
    expect(twice.progress).toEqual(once.progress);
  });
});
