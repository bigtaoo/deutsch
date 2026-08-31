// FR-8.3 / §7.4：听写校验分级 —— 正确 / 转写等价 / 仅大小写错 / 错误。
//
// 一处实现期的判断（写回 SPEC 用）：§7.4 把「转写等价」定义为
// `ae/oe/ue/ss ↔ ä/ö/ü/ß`，但 §10 验收清单要求把 `Hauser`（对 `Häuser`）判为转写等价 ——
// 而 `Hauser` 既不是 `Häuser` 也不是 `Haeuser`，它是**去掉变音符**的写法。
// 两者取并集：`ä` 同时接受 `ae` 和 `a`。理由跟规则本身的理由是同一个 ——
// 「照顾没有德语键盘的场景」，而没有德语键盘的人打出来的正是 `Hauser`。
// 代价是 `schon` / `schön` 这类真实对立也会被放过，但它仍然给出「注意变音符」提示，
// 只是不惩罚。相比之下把它判成全错、丢进 Again，惩罚要重得多。

export type DictationVerdict = 'correct' | 'transliteration' | 'case' | 'wrong';

export interface DictationResult {
  verdict: DictationVerdict;
  /** 展示给用户的一句话 */
  message: string;
  /** verdict === 'wrong' 时的字符级 diff（FR-8.4） */
  diff: DiffPart[];
}

/** 归一化：trim + 折叠连续空白。§7.4 的第一步。 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 变音符写成双字母的规范形：ä→ae、ß→ss。 */
function toDigraphs(text: string): string {
  return text
    .replace(/ä/g, 'ae').replace(/Ä/g, 'Ae')
    .replace(/ö/g, 'oe').replace(/Ö/g, 'Oe')
    .replace(/ü/g, 'ue').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss');
}

/** 干脆去掉变音符的写法：ä→a。没有德语键盘的人打出来的就是这个。 */
function stripDiacritics(text: string): string {
  return text
    .replace(/ä/g, 'a').replace(/Ä/g, 'A')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O')
    .replace(/ü/g, 'u').replace(/Ü/g, 'U')
    .replace(/ß/g, 'ss');
}

function equivalent(a: string, b: string): boolean {
  return toDigraphs(a) === toDigraphs(b) || stripDiacritics(a) === stripDiacritics(b);
}

export interface CheckOptions {
  /** FR-12 / §7.4：关掉后大小写错误按正确处理 */
  strictCase: boolean;
}

export function checkAnswer(
  expected: string,
  actual: string,
  opts: CheckOptions = { strictCase: true },
): DictationResult {
  const want = normalizeWhitespace(expected);
  const got = normalizeWhitespace(actual);

  if (want === got) return { verdict: 'correct', message: '正确', diff: [] };

  if (equivalent(want, got)) {
    return { verdict: 'transliteration', message: '算对 —— 注意变音符：正确写法是 ' + want, diff: [] };
  }

  const caseInsensitiveMatch =
    want.toLowerCase() === got.toLowerCase() || equivalent(want.toLowerCase(), got.toLowerCase());

  if (caseInsensitiveMatch) {
    return opts.strictCase
      ? { verdict: 'case', message: '注意大写：正确写法是 ' + want, diff: [] }
      : { verdict: 'correct', message: '正确（已关闭大小写严格模式）', diff: [] };
  }

  return { verdict: 'wrong', message: '错误，正确答案是 ' + want, diff: diffChars(want, got) };
}

/** FR-8.6：错误或「我不会」→ Again；仅大小写错 → Hard；正确/转写等价 → Good。 */
export function verdictToRating(verdict: DictationVerdict): 'again' | 'hard' | 'good' {
  switch (verdict) {
    case 'correct':
    case 'transliteration':
      return 'good';
    case 'case':
      return 'hard';
    case 'wrong':
      return 'again';
  }
}

export interface DiffPart {
  type: 'same' | 'missing' | 'extra';
  text: string;
}

/**
 * 字符级 diff（FR-8.4）。LCS 动态规划 —— 单词级别的长度（几十个字符），
 * O(n·m) 完全够用，换个更快的算法只会让这段更难读。
 */
export function diffChars(expected: string, actual: string): DiffPart[] {
  const n = expected.length;
  const m = actual.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        expected[i] === actual[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (type: DiffPart['type'], ch: string) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += ch;
    else parts.push({ type, text: ch });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (expected[i] === actual[j]) { push('same', expected[i]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { push('missing', expected[i]); i++; }
    else { push('extra', actual[j]); j++; }
  }
  while (i < n) push('missing', expected[i++]);
  while (j < m) push('extra', actual[j++]);

  return parts;
}
