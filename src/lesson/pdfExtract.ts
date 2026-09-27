// FR-1.10：直接读教材的 Transkript PDF，把页边的音轨号贴回它那一轨的第一行正文前面。
//
// 为什么不能靠「从 PDF 复制出来的文字」：音轨号印在页边，复制时一整页的轨号挤成一团，
// 常常落到下一题、甚至下一章里（Aspekte neu C1 实测：Kap. 7 最后一题的 2.23 / 2.24 出现在 Kap. 8 的第一题下面）。
// 直接读 PDF 就有坐标：轨号与它那一轨第一行正文**同一高度、同一栏的页边**，位置关系是确定的。
//
// 输出仍然是「每行一行」的纯文本，和复制出来的样子一致（后面照旧交给 unwrapPdfText 合行），
// 只多一种行：`[[2.15]]`，单独一行，放在它那一轨的第一行正文前面。

import { trackToken } from './pdfText';

/** pdf.js 的 text item 只取这几样；抽出来是为了排版逻辑能脱离 pdf.js 单测。 */
export interface PdfItem {
  str: string;
  /** 左下角坐标（PDF 坐标系：y 向上） */
  x: number;
  y: number;
  width: number;
  /** 字号（transform 的纵向缩放）。缺省当正文 */
  size?: number;
}

const MARKER_RE = /^\d{1,2}\.\d{1,2}$/;
/** 同一行的判据：基线差在这以内。 */
const SAME_LINE = 2.5;
/** 轨号往下这么多点以内的正文行算它的第一行（实测轨号基线比正文高 5~9pt）。 */
const MARKER_REACH = 4;
/** 比正文大这么多倍的字算标题字号（实测正文 10pt、题目标题 12pt、章标题 15pt）。 */
const HEADING_RATIO = 1.3;

interface Line {
  y: number;
  size: number;
  text: string;
}

function joinLine(items: PdfItem[]): string {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let out = '';
  let end = -Infinity;
  for (const it of sorted) {
    // 同一行被切成几个 item（字距、换字体、说话人符号单独一个）：有空隙才补空格
    if (out && it.x - end > 1 && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' ';
    out += it.str;
    end = it.x + it.width;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function groupLines(items: PdfItem[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const lines: Array<{ y: number; items: PdfItem[] }> = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= SAME_LINE) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  return lines
    .map((l) => ({ y: l.y, size: Math.max(...l.items.map((i) => i.size ?? 0)), text: joinLine(l.items) }))
    .filter((l) => l.text.length > 0);
}

/** 出现得最多的字号 = 正文字号。 */
function bodySize(items: readonly PdfItem[]): number {
  const counts = new Map<number, number>();
  for (const it of items) {
    const s = Math.round(it.size ?? 0);
    counts.set(s, (counts.get(s) ?? 0) + it.str.length);
  }
  let best = 0;
  let most = -1;
  for (const [s, n] of counts) if (n > most) [best, most] = [s, n];
  return best;
}

/**
 * 标题折成两行（`Kapitel 9 Die schöne Welt` / `der Künste`）：同一字号、都比正文大的相邻两行并成一行。
 * 不并的话第二行小写开头，整理断行时会把标题当成一句话的前半截、并进正文。
 */
function mergeHeadingLines(lines: Line[], body: number): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    const big = body > 0 && line.size >= body * HEADING_RATIO;
    if (big && last && Math.abs(last.size - line.size) < 0.5 && last.y - line.y < line.size * 2) {
      last.text = `${last.text} ${line.text}`;
      continue;
    }
    out.push({ ...line });
  }
  return out;
}

/**
 * 一页 → 若干行（阅读顺序：左栏从上到下，再右栏从上到下）。
 * 两栏按页宽的一半分；单栏的页只会落进左栏，结果一样。
 * 轨号按它在哪半边归栏（左页边的归左栏，右页边的归右栏），插在该栏里第一条
 * 「基线不高于轨号 + MARKER_REACH」的正文行前面；那一栏里它下面没有正文了就放在栏尾。
 */
export function layoutPage(items: readonly PdfItem[], pageWidth: number): string[] {
  const half = pageWidth / 2;
  const markers: PdfItem[] = [];
  const cols: PdfItem[][] = [[], []];
  const kept = items.filter((it) => it.str.trim());
  // 轨号独占一行：和同一栏里别的字在同一高度的 `2.50` 是正文里的数，不是页边的轨号
  const alone = (m: PdfItem) =>
    !kept.some(
      (o) => o !== m && !MARKER_RE.test(o.str.trim()) && o.x < half === m.x < half && Math.abs(o.y - m.y) <= SAME_LINE,
    );
  for (const it of kept) {
    if (MARKER_RE.test(it.str.trim()) && alone(it)) markers.push(it);
    else cols[it.x < half ? 0 : 1].push(it);
  }
  const body = bodySize(cols.flat());

  const out: string[] = [];
  for (const [c, colItems] of cols.entries()) {
    const lines = mergeHeadingLines(groupLines(colItems), body);
    const before = new Map<number, string[]>();
    const tail: string[] = [];
    const mine = markers.filter((m) => (m.x < half ? 0 : 1) === c).sort((a, b) => b.y - a.y);
    for (const m of mine) {
      const at = lines.findIndex((l) => l.y <= m.y + MARKER_REACH);
      const token = trackToken(m.str.trim());
      if (at === -1) tail.push(token);
      else before.set(at, [...(before.get(at) ?? []), token]);
    }
    for (const [i, line] of lines.entries()) {
      out.push(...(before.get(i) ?? []), line.text);
    }
    out.push(...tail);
  }
  return out;
}

/** 读整份 PDF。pdf.js 几百 KB 加一个 1.4MB 的 worker，只有这一页用，按需加载。 */
export async function extractPdfText(file: Blob): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      const plain: PdfItem[] = [];
      for (const it of items) {
        if (!('str' in it)) continue;
        const [a, , c, d, x, y] = it.transform as number[];
        plain.push({ str: it.str, x, y, width: it.width, size: Math.hypot(c, d) || Math.abs(a) });
      }
      pages.push(layoutPage(plain, page.view[2] - page.view[0]).join('\n'));
    }
    return pages.join('\n');
  } finally {
    void doc.destroy();
  }
}
