// 在线补齐：内置词典查不到时，问一次 de.wiktionary（FR-16.5）。
//
// ── 这一条为什么存在 ──
// 内置词典裁掉了「只有 IPA、既无释义也无性」的 8.3 万条，也裁掉了词形条目；
// 加上 WikDict 本身对生僻复合词的覆盖有限，而 Alltagsdeutsch 满篇都是复合词。
// 所以内置词典管日常，在线管长尾。查到的东西一旦被写进 VocabEntry 就是标注层的了，
// 之后不再依赖网络。
//
// ── 为什么是 Wiktionary 而不是 DWDS / PONS ──
// 实测（2026-09-02）：
//   · `de.wiktionary.org/w/api.php` 带 `origin=*` 回 `access-control-allow-origin: *`，
//     浏览器可直连，符合 §3.1.1 R-1（请求从用户设备发出，无任何中转）。
//   · DWDS 的 API 回 200 但**不带任何 CORS 头**，浏览器里用不了；
//     而 R-1 禁止自建代理，所以这条路是死的，不是「以后再做」。
//   · PONS / DeepL 要 API key，客户端里放 key 等于公开它。
//
// ── 解析的是纯文本 extract，不是 wikitext ──
// extract 的结构靠标题行和 `键: 值` 行，比 wikitext 的模板嵌套稳得多；
// 代价是 `exlimit` 实际只允许一页，所以这里只能单个词查 —— 而这正好是它的用途
// （用户点一个词的时候查一个词），批量预取那条路走的是 audio.ts 里的 generator。

import type { DictEntry, DictSense } from './types';

const API = 'https://de.wiktionary.org/w/api.php';

const GENDER: Record<string, 'm' | 'f' | 'n'> = { m: 'm', f: 'f', n: 'n' };

const POS_BY_HEADING: Array<[RegExp, DictSense['p']]> = [
  [/^Substantiv/i, 'noun'],
  [/^Verb/i, 'verb'],
  [/^Adjektiv/i, 'adj'],
  [/^Adverb/i, 'adv'],
  [/^Partizip/i, 'ptcp'],
  [/^Abkürzung/i, 'abbr'],
  [/^Interjektion/i, 'intj'],
  [/^Numerale/i, 'num'],
  [/^Präposition/i, 'prep'],
  [/^Konjunktion|^Subjunktion/i, 'conj'],
  [/^Artikel/i, 'art'],
  [/pronomen/i, 'pron'],
];

/**
 * 从 `=== Substantiv, f ===` 这样的小节标题里抠词性和性。
 * 德语维基词典的标题格式是 `词类[, 性][, 变化类型]`。
 */
function parseHeading(heading: string): { p?: DictSense['p']; g?: 'm' | 'f' | 'n' } {
  const out: { p?: DictSense['p']; g?: 'm' | 'f' | 'n' } = {};
  for (const [re, pos] of POS_BY_HEADING) {
    if (re.test(heading)) {
      out.p = pos;
      break;
    }
  }
  const g = /,\s*(m|f|n)\b/.exec(heading)?.[1];
  if (g && GENDER[g]) out.g = GENDER[g];
  return out;
}

/** `Zu·ver·sich·ten` → `Zuversichten`。分隔点是 Worttrennung 的音节点。 */
const stripSyllableDots = (s: string) => s.replace(/[·‧]/g, '').trim();

/**
 * 解析一份 `explaintext` 的 extract。
 *
 * extract 长这样（真实样本，Zuversicht）：
 *
 *   == Zuversicht (Deutsch) ==
 *   === Substantiv, f ===
 *   Worttrennung:
 *   Zu·ver·sicht, Plural: Zu·ver·sich·ten
 *   Aussprache:
 *   IPA: [ˈt͡suːfɛɐ̯ˌzɪçt]
 *   Bedeutungen:
 *   [1] der feste Glaube daran, dass etwas Positives geschehen wird
 *
 * 只取 `(Deutsch)` 那一节：同一个页面可能同时有其他语言的同形词。
 */
export function parseExtract(word: string, extract: string): DictEntry | null {
  const lines = extract.split('\n');

  /**
   * 标题行 → { 级别, 文本 }。
   *
   * **必须数 `=` 的个数**，不能用 `/^==\s*(.+?)\s*==$/` 那种写法：
   * 它对 `=== Substantiv, f ===` 也匹配（前两个 `=` 吃掉，`(.+?)` 捕到
   * `= Substantiv, f =`），于是二级的语言小节刚开始就被三级的词类小节判成结束，
   * 结果每个词都解析出空 —— 而且是**静默**的空，返回 null 看起来像「Wiktionary 上没这个词」。
   */
  function heading(line: string): { level: number; text: string } | null {
    const m = /^(=+)\s*(.*?)\s*(=+)$/.exec(line);
    if (!m || m[1].length !== m[3].length || m[1].length < 2) return null;
    return { level: m[1].length, text: m[2] };
  }

  // 找德语那一节的范围。`== Wort (Deutsch) ==`，二级。
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const h = heading(lines[i].trim());
    if (!h || h.level !== 2) continue;
    if (start < 0 && /\(Deutsch\)/.test(h.text)) start = i;
    else if (start >= 0) {
      end = i;
      break;
    }
  }
  if (start < 0) return null;

  const senses: DictSense[] = [];
  let cur: DictSense | null = null;
  /** 上一行是哪个「键:」—— extract 把值放在键的下一行。 */
  let pending: string | null = null;

  const flush = () => {
    if (cur && (cur.de?.length || cur.g || cur.ipa || cur.pl)) senses.push(cur);
  };

  for (let i = start + 1; i < end; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const h = heading(line);
    if (h) {
      flush();
      // 三级是词类小节（`=== Substantiv, f ===`）。四级及更深是
      // `==== Übersetzungen ====` 这类附属小节 —— 不开新义项，但要停止收集。
      cur = h.level === 3 ? { ...parseHeading(h.text) } : null;
      pending = null;
      continue;
    }
    if (!cur) continue;

    const label = /^([A-ZÄÖÜ][A-Za-zÄÖÜäöüß ]*):$/.exec(line);
    if (label) {
      pending = label[1];
      continue;
    }

    if (pending === 'Worttrennung') {
      const plural = /Plural(?:\s*\d*)?:\s*([^,;]+)/.exec(line)?.[1];
      if (plural) cur.pl = stripSyllableDots(plural);
      pending = null;
      continue;
    }
    if (pending === 'Aussprache' || line.startsWith('IPA:')) {
      const ipa = /IPA:\s*\[?([^\]\n]+)\]?/.exec(line)?.[1];
      if (ipa && !cur.ipa) cur.ipa = ipa.split(',')[0].trim().replace(/[[\]]/g, '');
      if (line.startsWith('IPA:')) continue;
    }
    if (pending === 'Bedeutungen') {
      // `[1] der feste Glaube daran, …`；也有不带编号的。
      const text = line.replace(/^\[\d+[a-z]?\]\s*/, '').trim();
      if (text && !/^Beispiele|^Herkunft/i.test(text)) {
        cur.de ??= [];
        if (cur.de.length < 3) cur.de.push(text);
      }
      continue;
    }
    // 碰到别的小节（Beispiele / Herkunft / Synonyme …）就停止收释义。
    if (/^(Beispiele|Herkunft|Synonyme|Gegenwörter|Oberbegriffe|Unterbegriffe|Redewendungen|Wortbildungen|Übersetzungen)/i.test(line)) {
      pending = null;
    }
  }
  flush();

  if (senses.length === 0) return null;
  return { w: word, s: senses };
}

/**
 * 在线查一个词。查不到、断网、被墙都返回 null —— 调用方的处置一样：
 * 让用户自己填（FR-7.4 本来就允许手填）。
 */
export async function lookupOnline(word: string): Promise<DictEntry | null> {
  const trimmed = word.trim();
  if (!trimmed) return null;

  const u = new URL(API);
  u.searchParams.set('action', 'query');
  u.searchParams.set('format', 'json');
  u.searchParams.set('formatversion', '2');
  u.searchParams.set('origin', '*');
  u.searchParams.set('prop', 'extracts');
  u.searchParams.set('explaintext', '1');
  u.searchParams.set('redirects', '1'); // 变形常常是到词头的重定向
  u.searchParams.set('titles', trimmed);

  try {
    const res = await fetch(u);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      query?: { pages?: Array<{ title: string; extract?: string; missing?: boolean }> };
    };
    const page = json.query?.pages?.[0];
    if (!page || page.missing || !page.extract) return null;
    return parseExtract(page.title, page.extract);
  } catch {
    return null;
  }
}
