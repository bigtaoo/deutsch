// 从预置词库里挑下一批要学的词（FR-17）。
//
// 挑词这件事拆成一个纯函数，是因为它有三条容易搞错的规则，而它们值得被测：
//   ① 已经在生词本里的词不能再来一次 —— 用**词元键**比，不是 surface。
//      不然「课上标过 Plattformen、预置词库又给一张 Plattform」会出现两张同义卡，
//      而 FR-9.3 存在的全部意义就是别让这种事发生。
//   ② 按档内名次顺序取，不随机 —— 名次就是「先学哪个」的唯一依据。
//   ③ 一档取完要能接着往下一档走，而不是原地空转。

import { normalizeKey } from './bucket';
import type { DictDeck } from './types';

export interface PresetPick {
  w: string;
  /** 档内名次。存进 VocabEntry.preset.rank，用来「接着上次往下取」。 */
  r: number;
  band: number;
}

/**
 * 从一个档里挑 `count` 个还没学过的词。
 *
 * @param taken 已在生词本里的**归一化词元键**集合
 */
export function pickFromBand(deck: DictDeck, taken: ReadonlySet<string>, count: number): PresetPick[] {
  if (count <= 0) return [];
  const out: PresetPick[] = [];
  for (const { w, r } of deck.words) {
    if (out.length >= count) break;
    if (taken.has(normalizeKey(w))) continue;
    out.push({ w, r, band: deck.id });
  }
  return out;
}

/**
 * 跨档挑：从 `startBand` 开始，一档取空了就往下一档。
 *
 * `loadBand` 传进来而不是直接 import loadDeck，是为了让这个函数在测试里
 * 不需要一个假的 fetch —— 它要测的是挑选规则，不是取文件。
 */
export async function pickPresetWords(
  startBand: number,
  taken: ReadonlySet<string>,
  count: number,
  loadBand: (band: number) => Promise<DictDeck | null>,
  maxBand = 6,
): Promise<PresetPick[]> {
  const picked: PresetPick[] = [];
  const seen = new Set(taken);
  for (let band = startBand; band <= maxBand && picked.length < count; band++) {
    const deck = await loadBand(band);
    if (!deck) continue; // 这一档没部署或取失败 —— 跳过，不要整个失败
    const batch = pickFromBand(deck, seen, count - picked.length);
    for (const p of batch) seen.add(normalizeKey(p.w));
    picked.push(...batch);
  }
  return picked;
}
