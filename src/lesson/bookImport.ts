// FR-1.8：整份教材文稿 → 一课一个 Aufgabe。
//
// 输入是 `unwrapPdfText` 整理过的文字：标题各占一行、每段话一行。
// 这里只做两件事：按标题切段，以及把一堆音频文件按顺序分给勾选的那几段。
//
// **为什么以 Aufgabe 为单位而不是以音轨为单位**：音轨号印在页边，复制出来挤在页尾，
// 和正文的位置关系已经丢了；Aufgabe 的标题行却是正文的一部分，位置可靠。
// 一个 Aufgabe 跨几轨由人在预览里定（默认 1，`Person 1~8` 这种题按小标题数给默认值），
// 那几轨按顺序拼成一个音频（`audio/concat.ts`）。

import { isChapterHeading, isHeading } from './pdfText';

export interface BookSection {
  /** 在全文里的顺序号，界面上当 key 用 */
  id: number;
  /** `Kapitel 1 Alltägliches`；标题出现在任何「Kapitel」之前时为空串 */
  chapter: string;
  /** `Modul 4 Aufgabe 2c` */
  heading: string;
  /** 这一段的正文（不含标题行、不含占位行），每段话一行 */
  body: string;
  /** `(Text wie Track 1.2-1.9)` 这类占位：这一段的录音在别处，照原文记下给人看 */
  references: string[];
  /** 默认用几轨 */
  suggestedTracks: number;
}

const PLACEHOLDER_RE = /^\((?:Text )?(?:wie|siehe|s\.) .*\)$/iu;

export function parseBookSections(text: string): BookSection[] {
  const sections: BookSection[] = [];
  let chapter = '';
  let current: { heading: string; lines: string[]; references: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    const persons = current.lines.filter((l) => /^Person\s+\d+\s*$/u.test(l)).length;
    sections.push({
      id: sections.length,
      chapter,
      heading: current.heading,
      body,
      references: current.references,
      suggestedTracks: persons >= 2 ? persons : 1,
    });
    current = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (isChapterHeading(line)) {
      flush();
      chapter = line;
      continue;
    }
    if (isHeading(line)) {
      flush();
      current = { heading: line, lines: [], references: [] };
      continue;
    }
    if (!current) continue; // 第一个标题之前的东西（封面、目录）不属于任何一题
    if (PLACEHOLDER_RE.test(line)) {
      current.references.push(line);
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return sections;
}

/** 课程标题：`Kapitel 1 · Modul 4 Aufgabe 2c`。章名省掉 —— 它在分组里已经很长了，放进标题手机上一行放不下。 */
export function sectionTitle(section: BookSection): string {
  const chapterNo = /^Kapitel\s+(\d+)/u.exec(section.chapter)?.[1];
  return chapterNo ? `Kapitel ${chapterNo} · ${section.heading}` : section.heading;
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** 文件名自然排序：`Track 2` 在 `Track 10` 前面。 */
export function sortByName<T extends { name: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * 按顺序把文件分给各段：第一段拿前 n₁ 个，第二段拿接下来 n₂ 个……
 * 文件不够时后面几段分不到（仍可导入，之后再补音频）；多出来的原样返回给界面报数。
 */
export function assignTracks<T>(
  counts: ReadonlyArray<{ id: number; tracks: number }>,
  files: readonly T[],
): { assigned: Map<number, T[]>; leftover: T[] } {
  const assigned = new Map<number, T[]>();
  let cursor = 0;
  for (const { id, tracks } of counts) {
    const take = files.slice(cursor, cursor + Math.max(0, tracks));
    cursor += take.length;
    assigned.set(id, take);
  }
  return { assigned, leftover: files.slice(cursor) };
}
