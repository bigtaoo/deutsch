// FR-1.8：整份教材文稿 → 一课一个 Aufgabe。
//
// 输入是 `unwrapPdfText` 整理过的文字：标题各占一行、每段话一行。
// 这里只做两件事：按标题切段，以及把一堆音频文件按顺序分给勾选的那几段。
//
// **为什么以 Aufgabe 为单位而不是以音轨为单位**：音轨号印在页边，复制出来挤在页尾，
// 和正文的位置关系已经丢了；Aufgabe 的标题行却是正文的一部分，位置可靠。
// 一个 Aufgabe 跨几轨由人在预览里定（默认 1，`Person 1~8` 这种题按小标题数给默认值），
// 那几轨按顺序拼成一个音频（`audio/concat.ts`）。
//
// FR-1.10（2026-09-26 补）：直接选 PDF 文件时音轨号有了确切位置（`pdfExtract.ts`，写成 `[[2.15]]` 行），
// 每题就知道自己是哪几轨，音频按**文件名里的轨号**配对（`605038_LB_CD2 (15).mp3` ↔ `2.15`），不再数数。
// 粘贴进来的文字没有这种行，照旧走上面那套按顺序分。

import { isChapterHeading, isHeading, TRACK_TOKEN_RE } from './pdfText';

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
  /** 这一题的音轨号（`2.15`），按出现顺序；只有从 PDF 文件读进来的文稿才有 */
  tracks: string[];
  /**
   * 其中「重放」的那几轨：占位 `(Text wie 3.11-3.13)` 所在的那一轨。考试题「听两遍」时，
   * 文稿只印一遍，录音却在这一轨把整段先放一遍 —— 拼进去同一段话就出现两次，对齐会乱。
   * 默认不用（界面上能点回来）。实测 3.10 ≈ 3.11 + 3.12 + 3.13，1.10 ≈ 1.2 ~ 1.9。
   */
  replayTracks: string[];
}

const PLACEHOLDER_RE = /^\((?:Text )?(?:wie|siehe|s\.) .*\)$/iu;

export function parseBookSections(text: string): BookSection[] {
  const sections: BookSection[] = [];
  let chapter = '';
  let current: {
    heading: string;
    lines: string[];
    references: string[];
    tracks: string[];
    replayTracks: string[];
  } | null = null;

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
      suggestedTracks:
        current.tracks.length > 0
          ? Math.max(1, current.tracks.length - current.replayTracks.length)
          : persons >= 2
            ? persons
            : 1,
      tracks: current.tracks,
      replayTracks: current.replayTracks,
    });
    current = null;
  };

  // 轨号先攒着，看它后面第一行是什么再定归谁：轨号印在栏底、它那一轨从下一栏的新题开始时，
  // 排版出来轨号在新题标题**前面**（pdfExtract 把栏里找不到正文行的轨号放在栏尾）—— 那它属于新题。
  let pending: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const token = TRACK_TOKEN_RE.exec(line);
    if (token) {
      pending.push(token[1]);
      continue;
    }
    if (isChapterHeading(line)) {
      flush();
      chapter = line;
      continue;
    }
    if (isHeading(line)) {
      flush();
      current = { heading: line, lines: [], references: [], tracks: pending, replayTracks: [] };
      pending = [];
      continue;
    }
    if (current && pending.length > 0) {
      current.tracks.push(...pending);
      pending = [];
    }
    if (!current) continue; // 第一个标题之前的东西（封面、目录）不属于任何一题
    if (PLACEHOLDER_RE.test(line)) {
      current.references.push(line);
      const playing = current.tracks[current.tracks.length - 1];
      if (playing && !current.replayTracks.includes(playing)) current.replayTracks.push(playing);
      continue;
    }
    current.lines.push(line);
  }
  if (current && pending.length > 0) (current as { tracks: string[] }).tracks.push(...pending);
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

/**
 * 从文件名里认出音轨号，规整成 `CD.轨`（去掉前导零）：
 *   - `605038_LB_CD2 (15).mp3` → `2.15`（Klett 音频包的命名）
 *   - `1_02.mp3`、`Track 1.12.mp3`、`1-12 Modul 4.mp3` → `1.2` / `1.12` / `1.12`
 * 认不出返回 null。练习册的 `605038_AB_38.mp3` 认不出 —— 这正好：它本来就不属于课本的任何一题。
 */
export function trackOfFile(name: string): string | null {
  const base = name.replace(/\.[^.]+$/, '');
  const cd = /CD\s*0*(\d{1,2})\D{0,8}?0*(\d{1,2})\D*$/iu.exec(base);
  if (cd) return `${Number(cd[1])}.${Number(cd[2])}`;
  const pair = /(?:^|\D)0*(\d{1,2})[._\- ]0*(\d{1,2})(?:\D|$)/u.exec(base);
  return pair ? `${Number(pair[1])}.${Number(pair[2])}` : null;
}

/**
 * 按轨号配对：每题拿自己那几轨对应的文件（按题里的顺序），缺的轨号报出来；
 * 没被任何一题用到的文件原样返回给界面报数。同一个轨号有两个文件时用排序靠前的那个。
 */
export function assignByTrackNumber<T extends { name: string }>(
  sections: ReadonlyArray<Pick<BookSection, 'id' | 'tracks'>>,
  files: readonly T[],
): { assigned: Map<number, T[]>; missing: Map<number, string[]>; leftover: T[] } {
  const byTrack = new Map<string, T>();
  for (const f of sortByName(files)) {
    const t = trackOfFile(f.name);
    if (t && !byTrack.has(t)) byTrack.set(t, f);
  }
  const used = new Set<T>();
  const assigned = new Map<number, T[]>();
  const missing = new Map<number, string[]>();
  for (const s of sections) {
    const got: T[] = [];
    const lack: string[] = [];
    for (const t of s.tracks) {
      const f = byTrack.get(t);
      if (f) {
        got.push(f);
        used.add(f);
      } else lack.push(t);
    }
    assigned.set(s.id, got);
    missing.set(s.id, lack);
  }
  return { assigned, missing, leftover: files.filter((f) => !used.has(f)) };
}
