import { describe, it, expect, vi } from 'vitest';
import { pickFromBand, pickPresetWords } from './preset';
import type { DictDeck } from './types';

const deck = (id: number, words: string[]): DictDeck => ({
  id,
  label: `第 ${id} 档`,
  words: words.map((w, i) => ({ w, r: i + 1 })),
});

const B4 = deck(4, ['Zuneigung', 'Sehnsucht', 'erleiden', 'Versuchung']);
const B5 = deck(5, ['Umlaufbahn', 'Barmherzigkeit']);

describe('pickFromBand', () => {
  it('按档内名次顺序取，不随机', () => {
    expect(pickFromBand(B4, new Set(), 2).map((p) => p.w)).toEqual(['Zuneigung', 'Sehnsucht']);
  });

  it('跳过已在生词本里的词', () => {
    const taken = new Set(['zuneigung', 'erleiden']);
    expect(pickFromBand(B4, taken, 4).map((p) => p.w)).toEqual(['Sehnsucht', 'Versuchung']);
  });

  it('比的是归一化键 —— 大小写不同不算新词', () => {
    // 课上标过 `sehnsucht`（比如句首小写、或者用户手打的），
    // 预置词库不能因为大小写不同就再来一张。
    expect(pickFromBand(B4, new Set(['sehnsucht']), 4).map((p) => p.w)).not.toContain('Sehnsucht');
  });

  it('要的比档里剩下的多时给全部剩下的，不报错', () => {
    expect(pickFromBand(B4, new Set(), 99)).toHaveLength(4);
  });

  it('count <= 0 返回空', () => {
    expect(pickFromBand(B4, new Set(), 0)).toEqual([]);
    expect(pickFromBand(B4, new Set(), -3)).toEqual([]);
  });

  it('带上档号 —— VocabEntry.preset.band 要存它', () => {
    expect(pickFromBand(B4, new Set(), 1)[0]).toEqual({ w: 'Zuneigung', r: 1, band: 4 });
  });
});

describe('pickPresetWords', () => {
  const load = async (band: number) => ({ 4: B4, 5: B5 }[band] ?? null);

  it('一档取空了接着往下一档，不原地空转', async () => {
    const picks = await pickPresetWords([4, 5], new Set(), 6, load);
    expect(picks.map((p) => p.w)).toEqual([
      'Zuneigung',
      'Sehnsucht',
      'erleiden',
      'Versuchung',
      'Umlaufbahn',
      'Barmherzigkeit',
    ]);
    expect(picks.map((p) => p.band)).toEqual([4, 4, 4, 4, 5, 5]);
  });

  it('同一次调用内不重复给同一个词', async () => {
    // 两档里都有 `Sehnsucht` 时，第二档不该再给一次。
    const overlap = async (band: number) => ({ 4: B4, 5: deck(5, ['Sehnsucht', 'Umlaufbahn']) }[band] ?? null);
    const picks = await pickPresetWords([4, 5], new Set(), 6, overlap);
    expect(picks.filter((p) => p.w === 'Sehnsucht')).toHaveLength(1);
  });

  it('取到够数就不再取后面的档 —— 不白下文件', async () => {
    const spy = vi.fn(load);
    await pickPresetWords([4, 5], new Set(), 2, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(4);
  });

  it('某一档取不到（没部署/断网）跳过它，不整个失败', async () => {
    const flaky = async (band: number) => (band === 4 ? null : B5);
    const picks = await pickPresetWords([4, 5], new Set(), 2, flaky);
    expect(picks.map((p) => p.w)).toEqual(['Umlaufbahn', 'Barmherzigkeit']);
  });

  it('所有档都取空了就返回已有的，不无限循环', async () => {
    const picks = await pickPresetWords([4, 5], new Set(), 100, load);
    expect(picks).toHaveLength(6);
  });

  it('没报名任何档时返回空', async () => {
    expect(await pickPresetWords([], new Set(), 5, load)).toEqual([]);
  });

  it('只报了不相邻的档时，中间那档不发卡（FR-17.3 报名是集合，不是起点）', async () => {
    const spy = vi.fn(load);
    const picks = await pickPresetWords([5], new Set(), 99, spy);
    expect(picks.map((p) => p.band)).toEqual([5, 5]);
    expect(spy).not.toHaveBeenCalledWith(4);
  });

  it('档号乱序传进来也按档号从小到大发', async () => {
    const picks = await pickPresetWords([5, 4], new Set(), 6, load);
    expect(picks.map((p) => p.band)).toEqual([4, 4, 4, 4, 5, 5]);
  });
});
