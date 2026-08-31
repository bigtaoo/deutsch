// FR-2.1 / FR-2.2 / §7.1：句子切分。
//
// Intl.Segmenter 初切 → 按序应用合并规则。规则只是把「需要手工修的句子」从 30 句降到 3 句，
// 手工修正（FR-2.3）永远是必须的，不要试图把规则堆到「不用改」为止。
//
// 换行是硬边界：manuscript 里 <br /> → \n、</p> → \n\n，跨行合并一定是错的，
// 所以先按行切开，规则只在行内生效。

export interface RawSegment {
  text: string;
  /** 在原始 plainText 中的 offset（已去掉首尾空白） */
  charStart: number;
  charEnd: number;
}

/** §7.1 缩写表。同时匹配带空格与不带空格的变体，匹配前会把空白折掉。 */
export const ABBREVIATIONS = [
  'z. B.', 'u. a.', 'd. h.', 'bzw.', 'usw.', 'evtl.', 'ggf.', 'ca.', 'vgl.', 'bspw.',
  'i. d. R.', 'z. T.', 'v. a.', 'o. Ä.', 'u. Ä.', 'Dr.', 'Prof.', 'Nr.', 'Abb.', 'S.',
  'Jh.', 'Mio.', 'Mrd.', 'St.', 'Str.',
];

/**
 * 把 `z. B.` 展开成 `z.` 和 `z.B.` 两个尾巴。
 * Segmenter 可能在缩写的任意一个点后面断开（`z.` | `B. Der ...`），
 * 只匹配完整形式会漏掉前半截那次误断。
 */
function expandAbbreviationTails(abbreviations: string[]): string[] {
  const tails = new Set<string>();
  for (const abbr of abbreviations) {
    const compact = abbr.replace(/\s+/g, '');
    let cursor = 0;
    while (cursor < compact.length) {
      const dot = compact.indexOf('.', cursor);
      if (dot === -1) break;
      tails.add(compact.slice(0, dot + 1));
      cursor = dot + 1;
    }
  }
  return [...tails];
}

/**
 * 每个尾巴编译成一条正则：点后允许空白（`z. B.` 与 `z.B.` 同时命中），
 * 且要求前面是非字母，避免 `Bahnhofs.` 撞上缩写 `S.`。
 * 不能先把空白折掉再比较 —— 那样 `leben z. B.` 会变成 `lebenz.B.`，词边界跟着消失。
 * 缩写表里只有字母，所以拼正则时不需要转义。
 */
const ABBREVIATION_PATTERNS = expandAbbreviationTails(ABBREVIATIONS).map((tail) => {
  const body = tail.split('.').filter(Boolean).join('\\.\\s*');
  return new RegExp(`(?:^|[^\\p{L}])${body}\\.\\s*$`, 'u');
});

/** R-abbr：本片以已知缩写结尾。 */
export function endsWithAbbreviation(text: string): boolean {
  return ABBREVIATION_PATTERNS.some((pattern) => pattern.test(text));
}

/** R-ordinal：`am 3. Oktober`、`im 19. Jahrhundert` —— 靠大小写判断不了，Jahrhundert 本就大写。 */
function endsWithOrdinal(text: string): boolean {
  return /\d+\.\s*$/.test(text);
}

/** R-initial：`A. Merkel` —— 单个大写字母 + 点。 */
function endsWithInitial(text: string): boolean {
  return /(^|[^\p{L}])\p{Lu}\.\s*$/u.test(text);
}

/** R-lower：下一片以小写字母开头。德语名词全大写、句首必大写，小写开头几乎一定是误切。 */
function startsWithLowercase(text: string): boolean {
  const first = text.trimStart()[0];
  return first !== undefined && /\p{Ll}/u.test(first);
}

const QUOTE_PAIRS: Array<[open: string, close: string]> = [
  ['„', '“'], // „ … "  德语引号
  ['«', '»'], // « … »
  ['‹', '›'], // ‹ … ›
  ['(', ')'],
  ['[', ']'],
];

/** R-quote：引号或括号未闭合 → 与下一片合并。直引号 `"` 按奇偶判断。 */
export function hasUnclosedQuote(text: string): boolean {
  for (const [open, close] of QUOTE_PAIRS) {
    let depth = 0;
    for (const ch of text) {
      if (ch === open) depth++;
      else if (ch === close) depth = Math.max(0, depth - 1);
    }
    if (depth > 0) return true;
  }
  const straight = [...text].filter((ch) => ch === '"').length;
  return straight % 2 === 1;
}

/** Intl.Segmenter 不可用时的兜底：按句末标点 + 空白粗切。规则层照常跑。 */
function fallbackSegments(line: string): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  const re = /[^.!?…]*[.!?…]+[\s]*|[^.!?…]+$/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (match[0].length === 0) break;
    out.push({ text: match[0], index: match.index });
  }
  return out;
}

function rawSegmentsOfLine(line: string): Array<{ text: string; index: number }> {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) return fallbackSegments(line);
  const segmenter = new Segmenter('de', { granularity: 'sentence' });
  return [...segmenter.segment(line)].map((s) => ({ text: s.segment, index: s.index }));
}

function applyMergeRules(pieces: Array<{ text: string; index: number }>): Array<{ text: string; index: number }> {
  const merged: Array<{ text: string; index: number }> = [];
  for (const piece of pieces) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      (startsWithLowercase(piece.text) ||
        endsWithAbbreviation(previous.text) ||
        endsWithOrdinal(previous.text) ||
        endsWithInitial(previous.text) ||
        hasUnclosedQuote(previous.text))
    ) {
      previous.text += piece.text;
      continue;
    }
    merged.push({ ...piece });
  }
  return merged;
}

/**
 * 切分整篇纯文本。返回的 offset 直接对应 `Sentence.charStart` / `charEnd`（FR-2.4），
 * 是 plainText 里的绝对位置，不含首尾空白。
 */
export function segmentSentences(plainText: string): RawSegment[] {
  const out: RawSegment[] = [];
  let lineStart = 0;

  for (const line of plainText.split('\n')) {
    if (line.trim().length > 0) {
      for (const piece of applyMergeRules(rawSegmentsOfLine(line))) {
        const leading = piece.text.length - piece.text.trimStart().length;
        const text = piece.text.trim();
        if (text.length === 0) continue;
        const charStart = lineStart + piece.index + leading;
        out.push({ text, charStart, charEnd: charStart + text.length });
      }
    }
    lineStart += line.length + 1; // +1 = 被 split 吃掉的 \n
  }

  return out;
}
