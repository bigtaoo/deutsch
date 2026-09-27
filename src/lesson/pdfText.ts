// FR-1.6：把从 PDF 复制出来的文字整理回段落。
//
// PDF 里没有「段落」，只有一行一行摆好的字：复制出来每一行末尾都是硬换行，
// 行尾被折断的词带着连字符（`wissen-` / `schaftlich`），页码、页眉、页边的音轨号
// 散落在正文中间。而切句（FR-2）把换行当硬边界 —— 不整理的话，每一行都会变成一「句」。
//
// 规则全部是「保守的那一边」：拿不准是不是段落开头时就**另起一行**。多断一行的代价是
// 切句页上多点一次「与下一句合并」；少断一行则是把标题拼进了正文，被当成要对齐的字。
//
// 样本是 Klett 官网公开下载的 Aspekte neu C1 Lehrbuch Transkript（2026-09-26 看过真实格式）：
//   - 说话人是行首符号 `●` `○` `△`，前面常带一个空格
//   - 章节标题 `Kapitel 1 Alltägliches`，题目标题 `Modul 4 Aufgabe 2c` / `Auftakt Aufgabe 2a`
//   - 页码单独一行（`3`），页眉 `Transkript zum Lehrbuch`
//   - 音轨号单独一行（`1.12`），复制出来整堆挤在页尾，位置与正文无关
//   - 考试题里的 `Person 1` 小标题、`(Text wie Track 1.2-1.9)` 这类指向别处的占位

import { isSpeakerSymbol } from './speakers';

/**
 * FR-1.10：直接读 PDF 时（`pdfExtract.ts`）音轨号有了确切位置，写成单独一行 `[[2.15]]`，
 * 放在那一轨第一行正文前面。整理断行时它**不打断段落**：原样提到当前这一段的前面。
 * 粘贴进来的文字里不会有这种行。
 */
export const trackToken = (track: string) => `[[${track}]]`;
/** 课本文稿是 `2.15`（CD.轨），练习册文稿是整数 `12`（2026-09-27）。 */
export const TRACK_TOKEN_RE = /^\[\[(\d{1,2}(?:\.\d{1,2})?)\]\]$/;

/** 整行丢掉的：页码、页边音轨号、页眉页脚。 */
const NOISE_LINES: RegExp[] = [
  /^\d{1,3}$/, // 页码
  /^\d{1,2}[.:]\d{1,2}$/, // 页边音轨号 1.12
  /^Transkript(?:ion(?:en)?)? zu[mr]? (?:Lehrbuch|Arbeitsbuch|Übungsbuch|Kursbuch)$/i,
  /^©/,
];

// 标题行：自己单独一行，前后都不能并。
//
// 三种都要求「整行就是一个标题」，而不只是「以某个词开头」—— 正文里完全可能有一行
// 恰好从 `Kapitel 3 zeigt, …` 或 `Track 5 hat mir …` 开始（PDF 折行把它甩到了行首），
// 旧写法只看开头，会凭空开出一个假章节、把那句话劈成两半。判据是标题里没有逗号句号
// 这类正文标点，且题目标题必须以 `Aufgabe N` 或 `Übung N`（练习册，可带 `1a, b und c` 这种并列）收尾。剩下的歧义（`Kapitel 3 zeigt uns`
// 折行、下一行小写开头）由 unwrapPdfText 看下一行来排除。
// 章名里可以有逗号（Aspekte neu C1 的 `Kapitel 8 Du bist, was du bist`），但只在大写开头时 ——
// `Kapitel 3 zeigt, wie das …` 是正文折行。题目标题里一律不行。
const CHAPTER_RE = /^Kapitel\s+\d+(?:\s+(?:\p{Lu}[^.;:]{0,49}|[^.,;:]{1,50}))?$/u;
const TASK_RE =
  /^(?:Auftakt|Modul\s+\d+|Porträt|Aussprache|Film|Sprachtraining|Strategie)(?:\s+[^.,;:!?]{1,20})?\s+(?:Aufgabe|Übung)\s*\d+[a-z]?(?:(?:,\s*[a-z])*\s+und\s+[a-z])?$/u;
const TRACK_RE = /^(?:Track|Hörtext)\s+\d+(?:[.:]\d+)?(?:\s+[^.,;:]{1,40})?$/u;

export function isChapterHeading(line: string): boolean {
  return CHAPTER_RE.test(line);
}

export function isHeading(line: string): boolean {
  return CHAPTER_RE.test(line) || TASK_RE.test(line) || TRACK_RE.test(line);
}

/** 自成一行、前后都不并的：标题、`Person 3` 这种小标题、括号占位。 */
function isStandalone(line: string): boolean {
  return (
    isHeading(line) ||
    /^(?:Person|Sprecher(?:in)?|Teil|Beispiel)\s+\d+\s*$/u.test(line) ||
    /^\(.*\)$/.test(line)
  );
}

/**
 * 一段新话的开头。符号总是；`Name:` 只在上一段已经说完（句末标点收尾）时才算 ——
 * 否则 `… sehr wissen-` / `schaftlich: Die Pilze …` 这种折行会被当成新说话人，
 * 一句话从中间劈开。
 */
function startsBlock(line: string, previous: string): boolean {
  if (isSpeakerSymbol(line[0] ?? '')) return true;
  return (
    /[.!?…“”"»«)]$/u.test(previous) &&
    /^\p{Lu}[\p{L}.'’-]*(?: [\p{L}.'’-]+){0,2}\s*[:：]\s+\S/u.test(line)
  );
}

/** `Ein-` + `und Ausgang` 这种省略式并列里的连字符要留着，后面跟一个空格。 */
const ELLIPSIS_CONJUNCTIONS = /^(?:und|oder|bis|sowie|bzw\.?|als auch|wie)\b/u;

function joinLines(left: string, right: string): string {
  if (/\p{L}-$/u.test(left)) {
    const first = right[0] ?? '';
    if (ELLIPSIS_CONJUNCTIONS.test(right)) return `${left} ${right}`;
    // 下一行小写开头 = 被折断的一个词（`Gemeinschafts-` + `leben`），连字符是排版加的。
    // 大写开头 = 本来就带连字符的复合词（`Speisepilz-` + `Verein`），保留连字符、不加空格。
    if (/\p{Ll}/u.test(first)) return left.slice(0, -1) + right;
    return left + right;
  }
  return `${left} ${right}`;
}

export function unwrapPdfText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00ad/g, '') // 软连字符
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim());

  const out: string[] = [];
  let current: string | null = null;
  const flush = () => {
    if (current !== null) out.push(current);
    current = null;
  };

  /** 下一行有内容的行（跳过噪音行）以小写字母开头 = 这一行其实是一句话折了行 */
  const continuesLowercase = (from: number): boolean => {
    for (let j = from + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next.length === 0) return false;
      if (NOISE_LINES.some((re) => re.test(next)) || TRACK_TOKEN_RE.test(next)) continue;
      return /^\p{Ll}/u.test(next);
    }
    return false;
  };

  for (const [i, line] of lines.entries()) {
    if (line.length === 0) {
      flush(); // 空行本来就是段落边界
      continue;
    }
    if (NOISE_LINES.some((re) => re.test(line))) continue;
    if (TRACK_TOKEN_RE.test(line)) {
      // 下一行本来就另起一段（换说话人、标题）：先收掉当前段，轨号正好落在新段前面。
      // 否则是段落中间换了轨：current 先不收，轨号落在当前段前面，段落照样往下并。
      const next = lines.slice(i + 1).find((l) => l.length > 0 && !TRACK_TOKEN_RE.test(l));
      if (current !== null && next !== undefined && (isStandalone(next) || startsBlock(next, current))) flush();
      out.push(line);
      continue;
    }

    // 题目标题（以 Aufgabe / Übung N 收尾）后面跟小写行也照样是标题：练习册的发音题正文就是一串小写的词
    // （`Aussprache Übung 1d` / `die Gesetzesänderungsentscheidungsvorlage`），而正文折行恰好整行是这种形状几乎不可能。
    if (isStandalone(line) && (TASK_RE.test(line) || !continuesLowercase(i))) {
      flush();
      out.push(line); // 标题自成一行，后面那行也不许并上来
      continue;
    }
    if (current === null || startsBlock(line, current)) {
      flush();
      current = line;
      continue;
    }
    current = joinLines(current, line);
  }
  flush();
  return out.join('\n');
}
