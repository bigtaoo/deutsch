// 查词面板的显示模型（FR-9.5）。
//
// 一次查词有**两个来源**，而用户要的是一个答案：
//   · 内置词典（`public/dict/`，离线、快、带中译与英译，但只有牌组词带例句）
//   · de.wiktionary（要网络、带例句/同义词/反义词/词源，没有中译）
//
// 合并规则只有一条：**内置优先，在线只补内置没有的东西。** 这与 FR-16.4 里
// 「DW Glossar 优先、词典只补空」是同一条判断 —— 结构化那一份字段更整齐，
// 而覆盖它的唯一后果是把更好的那份换掉。
//
// 义项列表**不做两边混排**：内置的义项是按词性从 WikDict 拼出来的，在线的是
// 页面上的词类小节，两边的编号和切分对不上（这正是 FR-16.9 决定「例句挂记录级、
// 不挂义项级」的原因）。混排的症状是名词的例句配到动词义项上 —— 那比少几条释义糟得多。
// 所以：义项整份取一边，例句/同义词/词源这些**记录级**的东西才合并。

import type { DictEntry, DictLookup, DictPos } from './types';
import type { OnlineEntry } from './online';
import { wiktionaryUrl } from './online';

export interface LookupSense {
  /** 义项自己的词头，只在与记录级词头不同时才有（`Laufen` 名词 / `laufen` 动词）。 */
  head?: string;
  pos?: DictPos;
  /** 在线那份的小节标题原文（`Substantiv, f`）。比我们的词性枚举细，所以原样留着。 */
  posLabel?: string;
  gender?: 'm' | 'f' | 'n';
  plural?: string;
  /** 并列的其它复数形式（`Mädchen` 还有口语的 `Mädchens`）。 */
  plural2?: string[];
  /** 动词的 Präteritum / Partizip II、形容词的比较级。**只有在线那份有**。 */
  forms?: string;
  ipa?: string;
  de: string[];
  en: string[];
  zh: string[];
}

export interface LookupResult {
  /** 用户输入的那个词，原样。 */
  query: string;
  /** 词头。可能与 `query` 不同 —— 查 `Plattformen` 得到的是 `Plattform`。 */
  head: string;
  /** 经词形还原绕过去的（`gelaufen` → `laufen`）。面板要说出来，否则看着像查错了词。 */
  viaForm: boolean;
  senses: LookupSense[];
  examples: string[];
  synonyms: string[];
  antonyms: string[];
  origin?: string;
  /** 哪几份来源真的给了东西。面板如实标出来 —— 离线时用户要知道自己看的是哪一份。 */
  from: { builtin: boolean; online: boolean };
  /** 维基词典页面。解析器总会漏东西（变格表、构词、译文），留一个出口。 */
  url: string;
}

function sensesFromDict(entry: DictEntry): LookupSense[] {
  return entry.s.map((s) => ({
    head: s.w,
    pos: s.p,
    gender: s.g,
    plural: s.pl,
    plural2: s.pl2,
    ipa: s.ipa,
    de: s.de ?? [],
    en: s.en ?? [],
    zh: s.zh ?? [],
  }));
}

function sensesFromOnline(entry: OnlineEntry): LookupSense[] {
  return entry.senses.map((s) => ({
    pos: s.p,
    posLabel: s.heading,
    gender: s.g,
    plural: s.pl,
    forms: s.forms,
    ipa: s.ipa,
    de: s.de,
    en: [],
    zh: [],
  }));
}

/**
 * 去重并保序。
 *
 * **比的时候要去掉引号**：牌组词的例句和在线那份来自同一个 Wiktionary 页面，
 * 而构建脚本（FR-16.9）把外层的 `„…“` 洗掉了、在线这份没洗 —— 不归一化的话
 * 同一句话会并排出现两遍，看着像词典坏了。保留先出现的那一条（内置那份更干净）。
 */
function uniq(lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of lists.flat()) {
    const text = item.trim();
    const key = text.replace(/[„“”"«»]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export function buildLookupResult(
  query: string,
  local: DictLookup | null,
  online: OnlineEntry | null,
): LookupResult | null {
  if (!local && !online) return null;

  const senses = local ? sensesFromDict(local.entry) : sensesFromOnline(online!);

  // 逐义项补两个字段：**IPA**（内置词典只在 WikDict 有的时候才有，而这个应用的痛点
  // 就是听觉识别）与**变形**（动词的 Partizip II、形容词的比较级，内置词典完全没有）。
  //
  // 对应关系按**词性**找，不按位置猜：两边的 `p` 是同一个枚举，所以「名词对名词」
  // 是明确的。按位置配的话，名词的 Partizip II 会配到动词义项上 ——
  // FR-16.9 决定「例句挂记录级、不挂义项级」防的就是这件事。
  const byPos = new Map((online?.senses ?? []).map((s) => [s.p ?? '?', s]));
  const anyIpa = online?.senses.find((s) => s.ipa)?.ipa;
  for (const s of senses) {
    const o = s.pos ? byPos.get(s.pos) : undefined;
    s.ipa ??= o?.ipa ?? anyIpa;
    s.forms ??= o?.forms;
  }

  return {
    query: query.trim(),
    head: local?.entry.w ?? online?.w ?? query.trim(),
    viaForm: local?.via === 'form',
    senses,
    examples: uniq([local?.entry.ex ?? [], online?.senses.flatMap((s) => s.ex) ?? []]).slice(0, 4),
    synonyms: uniq([online?.senses.flatMap((s) => s.syn) ?? []]).slice(0, 6),
    antonyms: uniq([online?.senses.flatMap((s) => s.ant) ?? []]).slice(0, 6),
    origin: online?.senses.find((s) => s.origin)?.origin,
    from: { builtin: Boolean(local), online: Boolean(online) },
    url: wiktionaryUrl(local?.entry.w ?? online?.w ?? query),
  };
}
