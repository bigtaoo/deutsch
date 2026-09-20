// 在线查词：问一次 de.wiktionary（FR-16.5 的补齐 + FR-9.5 的「详细」那一半）。
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
//
// ── 一次解析，两个视图（FR-9.5 加的）──
// 解析器收的是**每个词类小节下的原始文本块**（`Bedeutungen` / `Beispiele` /
// `Herkunft` / …），再由两个函数各取所需：
//   · `parseOnlineEntry` → 查词面板要的全部（例句、同义词、反义词、词源）
//   · `parseExtract`     → 标记生词时 prefill 要的那五个字段（DictEntry 形状）
// 分两个函数而不是让面板直接吃 DictEntry：DictEntry 是**构建产物的形状**
// （scripts/build-dict.mjs 的输出），例句在那里是记录级、只给牌组词带，
// 而在线这一份是按义项来的、且是长尾词唯一的例句来源 —— 硬塞进同一个类型
// 会让「哪些词有例句」这件事在两个来源之间说不清。

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

/** `[1] der feste Glaube …` → `der feste Glaube …`；`[1a]`、`[2, 3]`、`[1–3]` 也去掉。 */
const stripSenseNumber = (s: string) => s.replace(/^\[[\d\s,a-z–-]+\]\s*/, '').trim();

/**
 * 同义词/反义词那几段是**逗号列表**（`[1, 2] fix, flink, flott, geschwind, …`），
 * 所以要拆开再计数 —— 不拆的话「最多 6 个」会变成「最多 6 行」，
 * 而一行可能就是十个词。
 */
function splitList(lines: string[]): string[] {
  return lines.flatMap((line) => line.split(/[,;]/).map((x) => x.trim())).filter(Boolean);
}

/**
 * Worttrennung 那一行里除词头与复数之外的变形：动词的 Präteritum / Partizip II、
 * 形容词的比较级与最高级。
 *
 * **这是内置词典完全没有的一类字段**，而对 C1 来说 `Partizip II` 往往比释义更要紧
 * （`abwägen → abgewogen` 猜不出来）。复数不在这里 —— 它已经单独成字段了。
 */
function otherForms(line: string | undefined): string | undefined {
  if (!line) return undefined;
  const parts = stripSyllableDots(line)
    .split(',')
    .map((p) => p.trim());
  const rest: string[] = [];
  let keep = false;
  for (const [i, part] of parts.entries()) {
    if (i === 0) continue; // 第一段是词头自己
    if (/^Plural/i.test(part)) {
      keep = false;
      continue;
    }
    if (part.includes(':')) {
      keep = true;
      rest.push(part);
    } else if (keep) {
      // 上一段的并列值（`Partizip II: ab·ge·wo·gen, ab·ge·wägt`）
      rest.push(part);
    }
  }
  return rest.length > 0 ? rest.join(', ') : undefined;
}

/**
 * 挑例句。规则跟 FR-16.9（构建期给牌组词挑例句）同一条：
 * **带引号的是书面文学引文，长且难，不适合当例句看**，所以在还有普通例句的时候先排除它们。
 * 实测 `schnell` 的 14 条例句里有 4 条是这种引文。
 */
function pickExamples(lines: string[], limit: number): string[] {
  const plain = lines.filter((l) => !l.startsWith('„'));
  return (plain.length >= 2 ? plain : lines).filter((l) => l.length <= 200).slice(0, limit);
}

/**
 * 「标签行」的两种写法。
 *
 * 纯标签（`Bedeutungen:` 单独一行，值在下面几行）是绝大多数；但 extract 里
 * 也有把值写在同一行的（`IPA: [ˈmɛːtçən]`、`Reime: -ɛːtçən`、`Hörbeispiele: … (Info)`）。
 * **行内那一种只认已知的标签名**：放开成「任何首字母大写的词 + 冒号」会把
 * `Übertragen: etwas` 这样的释义行也当成标签吃掉，而那是静默丢内容。
 */
const BARE_LABEL = /^([A-ZÄÖÜ][A-Za-zÄÖÜäöüß ]*):$/;
const INLINE_LABEL =
  /^(IPA|Reime|Hörbeispiele|Worttrennung|Aussprache|Bedeutungen|Beispiele|Herkunft|Synonyme|Sinnverwandte Wörter|Gegenwörter|Oberbegriffe|Unterbegriffe|Redewendungen|Wortbildungen|Übersetzungen):\s*(.+)$/;

/** 一个词类小节：标题原文 + 标签名到原始行的映射。 */
interface RawSection {
  heading: string;
  blocks: Map<string, string[]>;
}

/**
 * 把一份 extract 切成「德语那一节里的每个词类小节」。
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
function collectSections(extract: string): RawSection[] {
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
  if (start < 0) return [];

  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  /** 当前在哪个「标签:」底下 —— extract 把值放在标签的下一行。 */
  let label: string | null = null;

  const put = (name: string, value: string) => {
    if (!cur || !value) return;
    const list = cur.blocks.get(name) ?? [];
    list.push(value);
    cur.blocks.set(name, list);
  };

  for (let i = start + 1; i < end; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const h = heading(line);
    if (h) {
      // 三级是词类小节（`=== Substantiv, f ===`）。四级及更深是
      // `==== Übersetzungen ====` 这类附属小节 —— 不开新小节，但要停止收集。
      cur = h.level === 3 ? { heading: h.text, blocks: new Map() } : null;
      if (cur) sections.push(cur);
      label = null;
      continue;
    }
    if (!cur) continue;

    const bare = BARE_LABEL.exec(line);
    if (bare) {
      label = bare[1];
      continue;
    }
    const inline = INLINE_LABEL.exec(line);
    if (inline) {
      label = inline[1];
      put(label, inline[2].trim());
      continue;
    }
    if (label) put(label, line);
  }

  return sections;
}

function firstMatch(lines: string[] | undefined, re: RegExp): string | undefined {
  for (const line of lines ?? []) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** 一个词类小节，查词面板要的全部字段。 */
export interface OnlineSense {
  /** 小节标题原文，如 `Substantiv, f`。面板照原样显示 —— 它比我们的词性枚举细。 */
  heading: string;
  p?: DictSense['p'];
  g?: 'm' | 'f' | 'n';
  pl?: string;
  /** 动词的 Präteritum / Partizip II、形容词的比较级 —— 内置词典没有这一类。 */
  forms?: string;
  ipa?: string;
  de: string[];
  /**
   * 例句。**这是查词最值钱的一段**：内置词典只给 1.7 万个牌组词带例句（FR-16.9），
   * 而课上要查的词大多不在牌组里。
   */
  ex: string[];
  /** 同义词 / 近义词（`Synonyme` + `Sinnverwandte Wörter`）。 */
  syn: string[];
  /** 反义词（`Gegenwörter`）。形容词上最有用。 */
  ant: string[];
  /** 词源（`Herkunft`）。 */
  origin?: string;
}

export interface OnlineEntry {
  /** 页面词头。**可能与查询词不同** —— `redirects=1` 会把变形跳到词头页。 */
  w: string;
  senses: OnlineSense[];
}

/** 收多少条。上限不是省内存，是省屏幕：查一个词滚三屏和没查到一样难用。 */
const MAX = { de: 6, ex: 4, syn: 8, ant: 8, origin: 400 };

function toOnlineSense(section: RawSection): OnlineSense {
  const { blocks } = section;
  const take = (name: string, limit: number) =>
    (blocks.get(name) ?? [])
      .map(stripSenseNumber)
      .filter(Boolean)
      .slice(0, limit);

  const plural = firstMatch(blocks.get('Worttrennung'), /Plural(?:\s*\d*)?:\s*([^,;]+)/);
  // IPA 可能在自己的标签下（`IPA: [x]` 同一行），也可能在 `Aussprache:` 的块里。
  // 取到第一个 `]` 为止：一行两个读音时（`[ˈmɛːtçən], [ˈmeːtçən]`）只要第一个。
  const ipa =
    firstMatch(blocks.get('IPA'), /\[?([^\][\n]+)/) ??
    firstMatch(blocks.get('Aussprache'), /IPA:\s*\[?([^\][\n]+)/);

  return {
    heading: section.heading,
    ...parseHeading(section.heading),
    pl: plural ? stripSyllableDots(plural) : undefined,
    forms: otherForms(blocks.get('Worttrennung')?.[0]),
    // 一行两个读音（`[ˈmɛːtçən], [ˈmeːtçən]`）只取第一个。
    ipa: ipa ? ipa.split(',')[0].trim().replace(/[[\]]/g, '') : undefined,
    de: take('Bedeutungen', MAX.de),
    ex: pickExamples(take('Beispiele', 20), MAX.ex),
    syn: splitList([...take('Synonyme', 20), ...take('Sinnverwandte Wörter', 20)]).slice(0, MAX.syn),
    ant: splitList(take('Gegenwörter', 20)).slice(0, MAX.ant),
    origin: (blocks.get('Herkunft') ?? []).join(' ').slice(0, MAX.origin) || undefined,
  };
}

/** 有没有值得显示的东西。空壳小节（只有 `Übersetzungen`）不进结果。 */
function hasContent(s: OnlineSense): boolean {
  return s.de.length > 0 || s.ex.length > 0 || Boolean(s.g || s.ipa || s.pl || s.forms || s.origin);
}

export function parseOnlineEntry(word: string, extract: string): OnlineEntry | null {
  const senses = collectSections(extract).map(toOnlineSense).filter(hasContent);
  if (senses.length === 0) return null;
  return { w: word, senses };
}

/**
 * 摊成 DictEntry —— 标记生词时 prefill 要的那几个字段（FR-16.4）。
 * 释义在这里截到 3 条：它要变成 `VocabEntry.meaning` 的一行，不是一屏。
 */
export function toDictEntry(entry: OnlineEntry): DictEntry | null {
  const senses: DictSense[] = entry.senses.map((s) => ({
    p: s.p,
    g: s.g,
    pl: s.pl,
    ipa: s.ipa,
    de: s.de.length ? s.de.slice(0, 3) : undefined,
  }));
  if (senses.length === 0) return null;
  return { w: entry.w, s: senses };
}

/** 保留原签名：`parseExtract` 的调用方（prefill）只要 DictEntry。 */
export function parseExtract(word: string, extract: string): DictEntry | null {
  const parsed = parseOnlineEntry(word, extract);
  return parsed ? toDictEntry(parsed) : null;
}

/** 维基词典上这个词的页面地址。查不到时也给 —— 那一页上常常有我们没解析的东西。 */
export function wiktionaryUrl(word: string): string {
  return `https://de.wiktionary.org/wiki/${encodeURIComponent(word.trim())}`;
}

async function fetchExtract(word: string): Promise<{ title: string; extract: string } | null> {
  const u = new URL(API);
  u.searchParams.set('action', 'query');
  u.searchParams.set('format', 'json');
  u.searchParams.set('formatversion', '2');
  u.searchParams.set('origin', '*');
  u.searchParams.set('prop', 'extracts');
  u.searchParams.set('explaintext', '1');
  u.searchParams.set('redirects', '1'); // 变形常常是到词头的重定向
  u.searchParams.set('titles', word);

  try {
    const res = await fetch(u);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      query?: { pages?: Array<{ title: string; extract?: string; missing?: boolean }> };
    };
    const page = json.query?.pages?.[0];
    if (!page || page.missing || !page.extract) return null;
    return { title: page.title, extract: page.extract };
  } catch {
    return null;
  }
}

/**
 * 在线查一个词，**要全部字段**（FR-9.5 的查词面板）。
 * 查不到、断网、被墙都返回 null —— 面板照旧给一个「去维基词典看」的出口。
 */
export async function lookupOnlineEntry(word: string): Promise<OnlineEntry | null> {
  const trimmed = word.trim();
  if (!trimmed) return null;
  const page = await fetchExtract(trimmed);
  return page ? parseOnlineEntry(page.title, page.extract) : null;
}

/**
 * 在线查一个词，**只要 prefill 那几个字段**（FR-16.5）。
 * 查不到、断网、被墙都返回 null —— 调用方的处置一样：
 * 让用户自己填（FR-7.4 本来就允许手填）。
 */
export async function lookupOnline(word: string): Promise<DictEntry | null> {
  const entry = await lookupOnlineEntry(word);
  return entry ? toDictEntry(entry) : null;
}
