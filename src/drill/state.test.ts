// FR-22.11：速背状态的合并。写错的两种症状都是静默的：
//   漏合并 —— 手机上背完一轮，桌面上打开还是「没学过」；
//   合并方向反了 —— 改过的中文被旧的顶掉、删掉的手动词又冒出来。

import { afterEach, describe, expect, it } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import { newCard } from '@/srs/fsrs';
import {
  drillNeedsPush,
  emptyDrillState,
  getDrillState,
  mergeDrillStates,
  normalizeDrillState,
  progressKey,
  updateDrillState,
  withCustom,
  withMark,
  withoutCustom,
  withPrefs,
  withProgress,
} from './state';

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

const card = (due: number) => ({ ...newCard(new Date(0)), due });

describe('mergeDrillStates：逐键 last-write-wins', () => {
  it('两台设备各背各的模式 —— 合并之后两份进度都在（整份覆盖会抹掉一边）', () => {
    const desktop = withProgress(emptyDrillState(), 'audio', 'kaution', card(1), 100);
    const phone = withProgress(emptyDrillState(), 'word', 'kaution', card(2), 200);
    const { merged, changed } = mergeDrillStates(desktop, phone);
    expect(changed).toBe(true);
    expect(merged.progress[progressKey('audio', 'kaution')].card.due).toBe(1);
    expect(merged.progress[progressKey('word', 'kaution')].card.due).toBe(2);
  });

  it('同一个键：ts 大的赢；相等时保留本地', () => {
    const a = withProgress(emptyDrillState(), 'audio', 'x', card(1), 100);
    const newer = withProgress(emptyDrillState(), 'audio', 'x', card(9), 200);
    expect(mergeDrillStates(a, newer).merged.progress['audio:x'].card.due).toBe(9);
    expect(mergeDrillStates(newer, a).merged.progress['audio:x'].card.due).toBe(9);
    expect(mergeDrillStates(newer, a).changed).toBe(false);

    const same = withProgress(emptyDrillState(), 'audio', 'x', card(5), 100);
    expect(mergeDrillStates(a, same).merged.progress['audio:x'].card.due).toBe(1);
  });

  it('删掉的手动词是墓碑，另一台设备上旧的那条不会把它复活', () => {
    const added = withCustom(emptyDrillState(), { id: 'u:abc', w: 'abc', p: 'noun', zh: '甲' }, 100);
    const removed = withoutCustom(added, 'u:abc', 200);
    const { merged } = mergeDrillStates(removed, added);
    expect(merged.custom['u:abc'].deleted).toBe(true);
    expect(mergeDrillStates(added, removed).merged.custom['u:abc'].deleted).toBe(true);
  });

  it('改过的中文：晚改的赢，取消标记不丢已改的中文', () => {
    let s = withMark(emptyDrillState(), 'x', { flagged: true, zh: '新译' }, 100);
    s = withMark(s, 'x', { flagged: false }, 200);
    expect(s.marks.x).toEqual({ flagged: false, zh: '新译', ts: 200 });
    const old = withMark(emptyDrillState(), 'x', { flagged: true, zh: '旧译' }, 50);
    expect(mergeDrillStates(old, s).merged.marks.x.zh).toBe('新译');
  });

  it('偏好整份比 ts', () => {
    const a = withPrefs(emptyDrillState(), { mode: 'word' }, 100);
    const b = withPrefs(emptyDrillState(), { roundSize: 50 }, 200);
    expect(mergeDrillStates(a, b).merged.prefs.roundSize).toBe(50);
    expect(mergeDrillStates(b, a).merged.prefs.roundSize).toBe(50);
  });
});

describe('drillNeedsPush', () => {
  it('本地有远端没有的键 → 要推；完全一样 → 不推', () => {
    const remote = withProgress(emptyDrillState(), 'audio', 'x', card(1), 100);
    expect(drillNeedsPush(remote, remote)).toBe(false);
    const local = withMark(remote, 'x', { flagged: true }, 150);
    expect(drillNeedsPush(local, remote)).toBe(true);
    expect(drillNeedsPush(remote, local)).toBe(false);
  });
});

describe('normalizeDrillState', () => {
  it('坏数据、老数据补成完整形状，不抛', () => {
    expect(normalizeDrillState(null)).toEqual(emptyDrillState());
    expect(normalizeDrillState('x')).toEqual(emptyDrillState());
    const partial = normalizeDrillState({ progress: { 'audio:a': { card: card(1), ts: 1 } }, prefs: { mode: 'word' } });
    expect(partial.custom).toEqual({});
    expect(partial.prefs.mode).toBe('word');
    expect(partial.prefs.roundSize).toBe(20);
  });
});

describe('withPrefs', () => {
  it('范围至少留一个 —— 全取消掉就是一个永远开不了轮的首页', () => {
    const s = withPrefs(emptyDrillState(), { categories: [] }, 1);
    expect(s.prefs.categories.length).toBeGreaterThan(0);
  });
});

describe('updateDrillState', () => {
  it('并发的两次更新都落库 —— 连着答两题不能互相覆盖', async () => {
    await Promise.all([
      updateDrillState((s) => withProgress(s, 'audio', 'a', card(1), 1)),
      updateDrillState((s) => withProgress(s, 'audio', 'b', card(2), 2)),
    ]);
    const s = await getDrillState();
    expect(Object.keys(s.progress).sort()).toEqual(['audio:a', 'audio:b']);
  });

  it('一次更新抛错不会卡死后面的', async () => {
    await expect(
      updateDrillState(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await updateDrillState((s) => withProgress(s, 'word', 'c', card(3), 3));
    expect((await getDrillState()).progress['word:c']).toBeDefined();
  });
});
