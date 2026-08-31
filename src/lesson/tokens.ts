// FR-7.1 / FR-7.2：把句子切成可点击的 token，并把选中的 token 折成 Blank.ranges。
//
// 全程带着**句内 offset**：Blank.ranges 是句内 offset，听写要靠它把词抠掉再填回去。
// 用 split(' ') 之类的做法会把标点和原位置一起弄丢。

export interface Token {
  text: string;
  /** 句内 offset */
  start: number;
  end: number;
  /** 标点与空白不可选 —— 挖掉一个逗号没有意义 */
  isWord: boolean;
}

// 德语词内可以有连字符和撇号（`Work-and-Travel`、`geht's`），它们不该把词切开。
const WORD_RE = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  for (const match of text.matchAll(WORD_RE)) {
    const start = match.index;
    if (start > cursor) {
      tokens.push({ text: text.slice(cursor, start), start: cursor, end: start, isWord: false });
    }
    tokens.push({ text: match[0], start, end: start + match[0].length, isWord: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    tokens.push({ text: text.slice(cursor), start: cursor, end: text.length, isWord: false });
  }
  return tokens;
}

export interface Range {
  start: number;
  end: number;
}

/**
 * 把一组选中的 token 折成尽量少的区间：相邻（中间只隔空白）的合并成一段，
 * 隔着别的词的保持分开 —— 这正是 `hing ... ab` 需要的两段式 Blank（FR-7.2）。
 */
export function toRanges(text: string, selected: Token[]): Range[] {
  const sorted = [...selected].sort((a, b) => a.start - b.start);
  const ranges: Range[] = [];
  for (const token of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && text.slice(last.end, token.start).trim() === '') last.end = token.end;
    else ranges.push({ start: token.start, end: token.end });
  }
  return ranges;
}

/** Blank.surface：多区间用 ` ... ` 连接，一眼看出这是个不连续搭配。 */
export function surfaceOf(text: string, ranges: Range[]): string {
  return ranges.map((r) => text.slice(r.start, r.end)).join(' ... ');
}

export function isSelected(ranges: Range[], token: Token): boolean {
  return ranges.some((r) => token.start >= r.start && token.end <= r.end);
}

/** 听写题面：把挖空处换成下划线占位符。返回片段列表，UI 在空位插输入框。 */
export interface ClozeSegment {
  type: 'text' | 'blank';
  text: string;
  /** type === 'blank' 时是该空在 blanks 数组里的下标 */
  blankIndex?: number;
}

export function toClozeSegments(text: string, blanksRanges: Range[][]): ClozeSegment[] {
  const flat = blanksRanges
    .flatMap((ranges, blankIndex) => ranges.map((r) => ({ ...r, blankIndex })))
    .sort((a, b) => a.start - b.start);

  const segments: ClozeSegment[] = [];
  let cursor = 0;
  for (const range of flat) {
    // 同一个 Blank 的第二个区间也会各占一个空位：`hing ___ ... ___ ab` 两个都要填。
    if (range.start > cursor) segments.push({ type: 'text', text: text.slice(cursor, range.start) });
    segments.push({ type: 'blank', text: text.slice(range.start, range.end), blankIndex: range.blankIndex });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
  return segments;
}

/**
 * FR-9.4：单个常见词的轻提示。「考虑连搭配一起标记」——
 * `sich einer Sache bewusst sein` 比 `bewusst` 有用得多。不强制，只提示。
 */
const COMMON_SHORT_WORDS = new Set([
  'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'aber', 'ist', 'sind', 'war', 'waren',
  'hat', 'haben', 'wird', 'werden', 'nicht', 'auch', 'noch', 'schon', 'sehr', 'man', 'sich',
  'es', 'in', 'an', 'auf', 'für', 'mit', 'von', 'zu', 'bei', 'als', 'wie', 'so', 'dass',
]);

export function shouldSuggestCollocation(surface: string): boolean {
  const words = surface.split(/\s+/).filter((w) => w !== '...');
  if (words.length > 1) return false;
  const word = words[0]?.toLowerCase() ?? '';
  return COMMON_SHORT_WORDS.has(word) || word.length <= 4;
}
