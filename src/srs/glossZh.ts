// FR-21.9：给生词本里缺中译的词补上中文。**应用自己不翻译**，
// 只做交接 —— 与 FR-19 的逐句译文是同一条立场、同一套解析规则。
//
// 为什么非补不可：词典里的中译只覆盖约 60%（德语释义 99.9%，FR-10.9 实测），
// 而 60% 凑不齐一道四选一。补齐之前中文只出现在卡背上。
//
// ── 这里唯一的难点：编号锚在什么上 ──
// FR-19 的编号是句子的**显示号**，它跟着课文走、稳定。词条没有这样的东西 ——
// 于是这里的编号是**导出那一刻的序号**。顺序固定为 createdAt 升序，
// 所以期间新加的词排在末尾、不会挪动前面的编号；**删过词就会整篇错位一格**。
// 那一步由人眼挡住：保存前有一屏「德语词 → 中文」对照预览（§12.14），
// `Vorhang` 对着「过程」这种事，看一眼就发现了。

import type { VocabEntry } from '@/types/models';

/**
 * 跟着词表一起复制走的提示词。
 *
 * 三条要求与 FR-19 的那三条一一对应，**同样刻意不用数字编号** ——
 * 它们会和下面词表的编号混在一起，解析器会把提示词本身当成前三个词的译文。
 */
export const ZH_PROMPT = [
  '请把下面这些德语词翻译成中文。要求：',
  '— 保留每个词前面的编号，格式是「编号. 中文」，一行一个；',
  '— 只给中文意思，不要重复德语词，也不要加解释；',
  '— 编号必须和下面一一对应，不要合并、跳过或重排。',
].join('\n');

/**
 * 还缺中译的词条，**按 createdAt 升序** —— 这个顺序就是编号的依据，
 * 所以它必须是确定的，而且新加的词只能排在末尾。
 *
 * 暂停复习的词条也算：暂停的是调度，不是这个词条本身，
 * 而补中译这件事恰恰是「以后可能会重新开始学它」的准备。
 */
export function pendingZh(entries: readonly VocabEntry[]): VocabEntry[] {
  return entries.filter((e) => !e.meaningZh).sort((a, b) => a.createdAt - b.createdAt);
}

/** 复制到剪贴板的完整内容：提示词 + 空行 + 编号词表。 */
export function zhRequest(ordered: readonly VocabEntry[]): string {
  const lines = ordered.map((e, i) => {
    const head = e.lemma ?? e.surface;
    // 带上德语释义当语境：`Zug` 没有语境时译成「火车」还是「一步棋」全凭运气。
    // 没有释义的词条（手动建的空卡）就只给词形 —— 那也比不给强。
    return e.meaning ? `${i + 1}. ${head} — ${e.meaning.replace(/\s+/g, ' ').trim()}` : `${i + 1}. ${head}`;
  });
  return `${ZH_PROMPT}\n\n${lines.join('\n')}\n`;
}

export interface ZhApplyResult {
  /** 只含真的变了的那些词条 —— 调用方拿它去落库，不必整表重写。 */
  updated: VocabEntry[];
  applied: number;
  /** 解析出来了、但落不到任何一个词上的编号（多半是导出之后删过词，或者贴错了表） */
  strayNumbers: number[];
}

/**
 * 按编号把中文写回词条。
 *
 * `ordered` 必须是**导出时用的那一份**（同一个 pendingZh 结果）—— 编号就是它的下标 + 1。
 *
 * 与 applyTranslations 的两条一致：**这次没给到的词保留原样**（一次贴一半是常事），
 * 落不到词上的编号**报出来而不是静默丢掉**。
 */
export function applyZh(
  ordered: readonly VocabEntry[],
  byNumber: ReadonlyMap<number, string>,
): ZhApplyResult {
  const updated: VocabEntry[] = [];
  const stray: number[] = [];
  const now = Date.now();

  for (const [n, zh] of byNumber) {
    const entry = ordered[n - 1];
    const text = zh.trim();
    if (!entry || !text) {
      if (!entry) stray.push(n);
      continue;
    }
    if (entry.meaningZh === text) continue;
    updated.push({ ...entry, meaningZh: text, updatedAt: now });
  }

  return { updated, applied: updated.length, strayNumbers: stray.sort((a, b) => a - b) };
}

/** §12.14 的对照预览：一行一个「德语词 → 中文」。 */
export function zhPreview(
  ordered: readonly VocabEntry[],
  byNumber: ReadonlyMap<number, string>,
): Array<{ n: number; word: string; zh: string }> {
  return [...byNumber.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([n]) => ordered[n - 1])
    .map(([n, zh]) => ({ n, word: ordered[n - 1].lemma ?? ordered[n - 1].surface, zh: zh.trim() }));
}
