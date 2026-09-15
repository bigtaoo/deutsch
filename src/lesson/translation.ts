// FR-19 逐句译文：**应用自己不翻译**，只负责把一整篇译文切回一句一句。
//
// 动线是「复制走 → 在外面（Claude 之类）翻 → 粘回来」。这里的全部难点是最后一步：
// 一大段中文怎么对回这 48 句。
//
// **用编号当锚，不按行数猜。** 按行数对齐看起来更省事，但翻译工具多写一行说明、
// 少一个空行，整篇就错位一句 —— 而**错位的译文比没有译文更糟**：跟读时你看到的是
// 下一句的意思，还不知道自己被骗了。编号解析失败是显性的（「48 句认到 46 句」），
// 行数对齐失败是静默的。
//
// 编号用的是**界面上的显示号**（`displayNumbers`，排除句不占号），不是 `Sentence.index`：
// 排除的是 Glossar 这类不朗读的段落，没有翻译的必要，也不该在复制出去的文本里占一个号。

import type { Sentence } from '@/types/models';
import { displayNumbers } from './sentences';

/**
 * 跟着原文一起复制走的提示词。
 *
 * 三条要求都是针对解析器的：**保留编号**（锚）、**一条一行**（少歧义）、
 * **只要译文**（前言后记这里会被忽略，但少写一点就少一点噪声）。
 */
export const TRANSLATION_PROMPT = [
  '请把下面这篇德语课文逐句翻译成中文。要求：',
  // 这三条**不能用数字编号**：它们会和下面课文的编号混在一起，既容易让对方数错，
  // 也会让这个解析器把提示词本身当成前三句的译文（整段原样贴回来的时候）。
  '— 保留每句前面的编号，格式是「编号. 译文」，一句一行；',
  '— 不要合并或拆分句子，编号必须和原文一一对应；',
  '— 只输出译文，不要附加解释、原文或小标题。',
].join('\n');

/** 复制到剪贴板的完整内容：提示词 + 空行 + 编号原文。 */
export function translationRequest(sentences: Sentence[], title?: string): string {
  const numbers = displayNumbers(sentences);
  const lines: string[] = [];
  for (const sentence of sentences) {
    const n = numbers.get(sentence.index);
    if (n === undefined) continue; // 排除句：不朗读，也不翻译
    lines.push(`${n}. ${sentence.text.replace(/\s+/g, ' ').trim()}`);
  }
  const head = title ? `${TRANSLATION_PROMPT}\n\n课文标题：${title}` : TRANSLATION_PROMPT;
  return `${head}\n\n${lines.join('\n')}\n`;
}

/** 行首的列表符与加粗记号 —— 翻译工具很爱加，它们不该挡住编号。 */
const DECORATION = /^[\s>*\-–—•·]*(?:\*\*)?\s*/;
/**
 * `12. 译文` / `12、译文` / `12) 译文` / `12：译文`。
 * 分隔符两侧各允许一个加粗记号：`**12.**` 和 `**12**.` 两种写法都有人写。
 */
const NUMBERED = /^(\d{1,4})\s*(?:\*\*)?\s*[.、．)）:：]\s*(?:\*\*)?\s*(.*)$/;

/**
 * 解析粘回来的译文，得到「显示号 → 中文」。
 *
 * 宽容的地方：行首的 `-`/`*`/`>`、`**加粗**`、前后的寒暄（「好的，以下是翻译：」
 * 落不到任何编号上，自然被忽略）、以及一条译文占了好几行（续行接在上一条后面）。
 *
 * 严格的地方：**没有编号的行永远开不了一个新条目**。宁可少认几句让人看见
 * 「48 句认到 46 句」，也不能靠位置猜 —— 猜错是静默错位。
 *
 * 空行**结束**当前条目的续行收集：这样「1. 译文」之后空一行再写的收尾话
 * （「以上是全文翻译」）不会被吃进第 1 句里。
 */
export function parseTranslations(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let current: number | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current !== null) {
      const value = buffer.join('\n').trim();
      // 空条目（`12.` 后面什么都没有）不写进去 —— 它和「这句没翻」是一回事
      if (value) out.set(current, value);
    }
    current = null;
    buffer = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(DECORATION, '').trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const m = NUMBERED.exec(line);
    if (m) {
      flush();
      current = Number(m[1]);
      buffer = [m[2].replace(/\*\*$/, '').trim()];
    } else if (current !== null) {
      buffer.push(line.trim());
    }
    // current === null 且没有编号：前言、标题、分隔线 —— 丢掉
  }
  flush();
  return out;
}

export interface ApplyResult {
  sentences: Sentence[];
  /** 真的写进句子的条数 */
  applied: number;
  /** 解析出来了、但没有对应句子的编号（多半是贴错了课，或者贴完之后又重切过句） */
  strayNumbers: number[];
}

/**
 * 把解析结果按显示号写回句子。
 *
 * **这次没给到的句子保留原有译文**，不清空 —— 一篇太长分两次贴是常事。
 * 要全清有单独的出口（界面上的「清空译文」）。
 */
export function applyTranslations(
  sentences: Sentence[],
  byNumber: Map<number, string>,
): ApplyResult {
  const numbers = displayNumbers(sentences);
  const seen = new Set<number>();
  let applied = 0;

  const next = sentences.map((sentence) => {
    const n = numbers.get(sentence.index);
    if (n === undefined) return sentence;
    const translation = byNumber.get(n);
    if (translation === undefined) return sentence;
    seen.add(n);
    if (sentence.translation === translation) return sentence;
    applied += 1;
    return { ...sentence, translation };
  });

  const strayNumbers = [...byNumber.keys()].filter((n) => !seen.has(n)).sort((a, b) => a - b);
  return { sentences: next, applied, strayNumbers };
}

export function clearTranslations(sentences: Sentence[]): Sentence[] {
  return sentences.map((s) => (s.translation === undefined ? s : { ...s, translation: undefined }));
}

export interface Coverage {
  /** 有译文的句子数 */
  translated: number;
  /** 该有译文的句子数（排除句不算） */
  total: number;
}

export function translationCoverage(sentences: Sentence[]): Coverage {
  let translated = 0;
  let total = 0;
  for (const s of sentences) {
    if (s.excluded) continue;
    total += 1;
    if (s.translation) translated += 1;
  }
  return { translated, total };
}

export function hasTranslations(sentences: Sentence[]): boolean {
  return sentences.some((s) => !s.excluded && s.translation);
}
