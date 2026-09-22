// FR-9.11 / FR-9.12：把「这个词我没弄明白」交出去，再把答案接回来。
//
// **应用自己不解释词** —— 和 FR-19（译文）、FR-21.9（补中译）同一条立场、
// 同一套编号规则、同一个解析器（`parseTranslations`）。这里只做交接。
//
// ── 待办从两个口子进来，而它们是同一件事 ──
// ① **词典查不到的词**（`!meaning`）。查词面板上「照样收下这个词」收进来的那些 ——
//    多词搭配和生僻复合词内置词典和 de.wiktionary 两边都没有，而那恰恰是最值得记的
//    一类（§12.11）。它们进来时就是空的，除了外面没有别的地方能补。
// ② **人手点的标记**（`askAi`）。查到了，但那三五个中文字看不出 `Zuversicht` 和
//    `Vertrauen` 差在哪 —— 这件事机器分不出来，只能由人点。
//
// 两者的下一步完全一样（复制走 → 在外面问 → 粘回来），所以它们共用一个待办队列、
// 一个提示词、一屏对照预览。分成两块会让同一个动作在生词本页底部出现两次。
//
// ── 编号锚在哪 ──
// 和 FR-21.9 逐字相同：编号是**导出那一刻的序号**，顺序固定为 `createdAt` 升序。
// 期间新加的词排在末尾、不动前面的编号；**删过词就会整篇错位一格**。
// 挡住它的是保存前那一屏「德语词 → 解释」对照预览（§12.16）。

import type { VocabEntry } from '@/types/models';

/**
 * 跟着词表一起复制走的提示词。
 *
 * 三条要求里第二条是这里独有的：**不要空行**。`parseTranslations` 用空行
 * 结束一个条目的续行收集（那是为了不把「以上是全文翻译」吃进最后一句），
 * 于是一段分了三个自然段的解释只会留下第一段。写清楚比事后修解析器便宜。
 *
 * 同样刻意不用数字编号 —— 它们会和下面词表的编号混在一起。
 */
export const AI_PROMPT = [
  '请逐个讲解下面这些德语词（我是 C1 学习者，中文母语）。每个词要求：',
  '— 保留前面的编号，格式是「编号. 解释」，一个词从它的编号那一行开始；',
  '— 一个词的解释可以写好几行，但**中间不要空行**，下一个词另起编号；',
  '— 内容：准确的中文意思、和近义词的区别、常见搭配或固定用法；名词给性和复数，',
  '　动词给支配的介词/格；能给一个短例句最好；',
  '— 不要重复我给的德语释义，也不要写前言和结语。',
].join('\n');

/**
 * 还等着 AI 解释的词条，**按 createdAt 升序** —— 这个顺序就是编号的依据，
 * 所以它必须是确定的，而且新加的词只能排在末尾。
 *
 * 已经有 `note` 的词**不再进队列**，除非又被重新标记了一次
 * （`askAi` 在写入 note 时清掉，所以「再标一次」是一个明确的动作）。
 *
 * 暂停复习的词条也算，与 `pendingZh` 同一条理由：暂停的是调度，不是这个词条本身。
 */
export function pendingAi(entries: readonly VocabEntry[]): VocabEntry[] {
  return entries
    .filter((e) => e.askAi || (!e.meaning && !e.note))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 待办里「查不到、只能靠外面补」的那一半有几个 —— 面板的说明行要分开说。 */
export function countMissingMeaning(ordered: readonly VocabEntry[]): number {
  return ordered.filter((e) => !e.meaning).length;
}

/**
 * 复制到剪贴板的完整内容：提示词 + 空行 + 编号词表。
 *
 * 每一条带上**已有的全部线索**：德语释义、中译、原句。
 * 原句是这里最值钱的一项 —— `Zug` 没有语境时讲成「火车」还是「一步棋」全凭运气，
 * 而查不到的那些词多半是复合词或搭配，原句往往是它唯一的语境。
 */
export function aiRequest(ordered: readonly VocabEntry[]): string {
  const lines = ordered.map((e, i) => {
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
    const head = e.lemma ?? e.surface;
    const parts = [`${i + 1}. ${head}`];
    if (e.meaning) parts.push(`（词典：${flat(e.meaning)}）`);
    if (e.meaningZh) parts.push(`（中译：${flat(e.meaningZh)}）`);
    const sentence = e.contextSentence ?? e.examples?.[0];
    if (sentence) parts.push(`\n　　原句：${flat(sentence)}`);
    return parts.join('');
  });
  return `${AI_PROMPT}\n\n${lines.join('\n')}\n`;
}

/**
 * 切换「问 AI」标记。
 *
 * **取消标记要把字段删掉，不是置 `false`。** 留一个 `askAi: false` 在库里，
 * 和「从来没标记过」在数据上长得不一样 —— 而 `VocabEntry` 是整条 last-write-wins
 * 同步的（§2.4），凭空多出来的差异会让两台设备互相覆盖一次，换不来任何信息。
 *
 * 单独一个纯函数而不是写在 VocabPage 的 onClick 里：这条规则**错了不报错**，
 * 只是在某次跨设备合并里多覆盖一回，而那种事没人会追到这一行上来。
 */
export function toggleAskAi(entry: VocabEntry): VocabEntry {
  if (!entry.askAi) return { ...entry, askAi: true };
  const { askAi: _marked, ...rest } = entry;
  return rest;
}

export interface AiApplyResult {
  /** 只含真的变了的那些词条 —— 调用方拿它去落库，不必整表重写。 */
  updated: VocabEntry[];
  applied: number;
  /** 解析出来了、但落不到任何一个词上的编号（多半是导出之后删过词，或者贴错了表） */
  strayNumbers: number[];
}

/**
 * 按编号把解释写回词条，并**清掉 `askAi`** —— 标记的意思是「还没问」，
 * 答案回来了它就该消失，否则这个词会永远待在待办里。
 *
 * `ordered` 必须是**导出时用的那一份**（同一个 `pendingAi` 结果）—— 编号就是它的下标 + 1。
 *
 * 与 `applyZh` / `applyTranslations` 的两条一致：**这次没给到的词保留原样**
 * （一次贴一半是常事），落不到词上的编号**报出来而不是静默丢掉**。
 */
export function applyAiNotes(
  ordered: readonly VocabEntry[],
  byNumber: ReadonlyMap<number, string>,
): AiApplyResult {
  const updated: VocabEntry[] = [];
  const stray: number[] = [];
  const now = Date.now();

  for (const [n, raw] of byNumber) {
    const entry = ordered[n - 1];
    const text = raw.trim();
    if (!entry || !text) {
      if (!entry) stray.push(n);
      continue;
    }
    if (entry.note === text && !entry.askAi) continue;
    // `askAi` 是可选字段，要删不是要置 false —— 留一个 `askAi: false` 在库里，
    // 下次备份合并时它和「从来没标记过」长得不一样，白白多一份差异。
    const { askAi: _dropped, ...rest } = entry;
    updated.push({ ...rest, note: text, updatedAt: now });
  }

  return { updated, applied: updated.length, strayNumbers: stray.sort((a, b) => a - b) };
}

/** §12.16 的对照预览：一行一个「德语词 → 解释开头」。 */
export function aiPreview(
  ordered: readonly VocabEntry[],
  byNumber: ReadonlyMap<number, string>,
): Array<{ n: number; word: string; note: string }> {
  return [...byNumber.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([n]) => ordered[n - 1])
    .map(([n, note]) => ({
      n,
      word: ordered[n - 1].lemma ?? ordered[n - 1].surface,
      note: note.trim(),
    }));
}
