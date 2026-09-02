// 内置词典的数据形状（FR-16）。**由 scripts/build-dict.mjs 产出**，
// 改这里必须同时改那个脚本 —— 字段名刻意都是一两个字母，13 万条词条里
// 每个字段名都要重复 13 万遍，`gender` 写成 `g` 省下来的是 MB 级。
//
// 这一整层属于 §2.3 的**缓存层**：它可由构建脚本从公开数据重建，
// 所以既不进备份、也不进 ShareablePackage。词典查出来的东西一旦被
// 写进 VocabEntry（性、复数、释义），那一份才是标注层的、要备份的。

/** 词性。`ptcp` 分词 / `propn` 专有名词 / `affix` 词缀 等只在查词时出现，不进牌组。 */
export type DictPos =
  | 'noun'
  | 'verb'
  | 'adj'
  | 'adv'
  | 'ptcp'
  | 'propn'
  | 'abbr'
  | 'intj'
  | 'num'
  | 'prep'
  | 'conj'
  | 'ptcl'
  | 'art'
  | 'pron'
  | 'letter'
  | 'affix';

/** 一个义项。同一个词可能既是名词又是动词（`Laufen` / `laufen`），各占一条。 */
export interface DictSense {
  /**
   * 这个义项自己的词头，**只在与 DictEntry.w 不同时才有**。
   * 存在的唯一原因是大小写：`Laufen`（名词）和 `laufen`（动词）归一化后同键，
   * 记录级的 `w` 只能留一个。用户标了 `läuft` 却看到词头 `Laufen` 会以为查错了词。
   */
  w?: string;
  p?: DictPos;
  /** 名词的性。FR-7.4：名词不带性等于没记，所以这个字段是这本词典存在的主要理由之一。 */
  g?: 'm' | 'f' | 'n';
  /** 主格复数。源数据里同一个词可能列出两个，这里放最短的那个。 */
  pl?: string;
  /** 并列的其它复数形式（`Mädchen` 还有口语的 `Mädchens`）。 */
  pl2?: string[];
  ipa?: string;
  /** **德语**释义。对 C1 比中文释义有用 —— FR-14 在 DW 的 Glossar 上是同一个结论。 */
  de?: string[];
  en?: string[];
  zh?: string[];
}

export interface DictEntry {
  /** 词头的显示形式（带原大小写）。 */
  w: string;
  s: DictSense[];
  /** 口语语料里的累计词频。没有这个字段说明它没进词频表，也就不会进任何牌组。 */
  f?: number;
}

export interface DictAttribution {
  what: string;
  source: string;
  license: string;
  url: string;
}

export interface DictDeckMeta {
  id: number;
  /** 如「1501–3000」。**这是词频名次，不是 CEFR 等级** —— 见 FR-17.2。 */
  label: string;
  count: number;
}

export interface DictMeta {
  formatVersion: 1;
  buckets: number;
  words: number;
  forms: number;
  decks: DictDeckMeta[];
  /** CC BY-SA 要求署名，设置页把这段原样显示出来（FR-16.7）。 */
  attribution: DictAttribution[];
  note: string;
}

/** deck/band-N.json 的形状。 */
export interface DictDeck {
  id: number;
  label: string;
  words: Array<{ w: string; r: number }>;
}

/** 一次查词的结果。`via` 说明是直接命中还是经词形还原绕过去的。 */
export interface DictLookup {
  entry: DictEntry;
  /** 直接命中；或者查的是词形、经 f/ 索引还原到了这个词头。 */
  via: 'exact' | 'form';
  /** via==='form' 时，用户查的那个词形。 */
  queried?: string;
}
