// FR-9.13：本课生词候选 —— 把一课里「可能不认识」的词推出来，勾选后一次加一批。
//
// 判据全是**减法**：这一课的词按词元归并，减掉口语里常见的（词形在前一万名，或词元在牌组 1~3 档）、
// 生词本里已有的、标过「认识」的、专有名词和太短的。
//
// 「常见」为什么要两条：只看词元（牌组 / `f`）会漏掉最常见的一批名词 —— `Tag` `Arbeit` `Schule`
// 的词形有歧义（也是 tagen / arbeiten / schulen 的命令式），构建时频次整份丢掉了，
// 它们在词元那一侧「没有词频」，会被当成最生僻的词列在第一个（详见 scripts/build-common-forms.mjs）。
// 只看词形又会漏掉常见词元的少见变形（`gelaufen` 不在前一万个词形里，`laufen` 在牌组第 1 档）。剩下的不是「你不认识的词」，
// 是「按词频推出来可能不认识」—— 所以界面上不默认勾（FR-14.1 同一条分寸）。
//
// 查词依赖从外面注入：这里只管排版逻辑，单测不用去碰 256 个词典桶。

import { bucketHex, normalizeKey } from '@/dict/bucket';
import { tokenize, type Range } from './tokens';
import type { DictLookup } from '@/dict/types';
import type { Lesson, VocabEntry } from '@/types/models';

/** 牌组 1~3 档 = 口语词频前 3000 个词元。FR-17.4a：C1 的人基本全认识。 */
export const COMMON_BANDS = [1, 2, 3] as const;

export interface VocabCandidate {
  /** 词元键（词典查不到时是词形本身的键）。去重、「认识」都用它。 */
  key: string;
  /** 显示用词头：词典的 `w`；查不到时就是原文里的词形 */
  headword: string;
  /** 原文里的词形（挖空挖的是它） */
  surface: string;
  gender?: VocabEntry['gender'];
  /** 词典里的一行释义（德语优先，与 fieldsFromDict 同一个取法，但只取第一条） */
  meaning?: string;
  /** 口语词频。越小越难；没进词频表的是 undefined，排最前 */
  freq?: number;
  /** 挂在哪一句上：第一次出现且有时间戳的那一句（§3.3 R1） */
  sentenceIndex: number;
  ranges: Range[];
}

export interface CandidateResult {
  /** 词典里有的，按难度从难到易 */
  found: VocabCandidate[];
  /** 词典里没有的（多半是复合词，也可能是人名），按在课文里出现的顺序 */
  unknown: VocabCandidate[];
  /** 这一课有没有任何一句带时间戳 —— 没有的话候选挂不上去，界面要说明原因 */
  timed: boolean;
}

export interface CandidateDeps {
  lookup: (surface: string) => Promise<DictLookup | null>;
  /** 前 3000 名的词元键（牌组 1~3 档） */
  commonKeys: ReadonlySet<string>;
  /** 口语里前一万的词形（public/dict/common-forms.json），归一化过 */
  commonForms: ReadonlySet<string>;
  /** 生词本里已有的（vocabKey） */
  takenKeys: ReadonlySet<string>;
  /** Settings.knownWords */
  knownKeys: ReadonlySet<string>;
}

/** 词典查到的词短于这个就不列；查不到的要更长才列（短的查不到多半是缩写、口语词、错字） */
const MIN_FOUND = 3;
const MIN_UNKNOWN = 5;

interface Occurrence {
  surface: string;
  sentenceIndex: number;
  range: Range;
}

export async function findCandidates(lesson: Lesson, deps: CandidateDeps): Promise<CandidateResult> {
  const visible = lesson.sentences.filter((s) => !s.excluded);
  const timed = visible.some((s) => s.startTime !== undefined);

  // 每个词形第一次出现在有时间戳的句子里的位置。没有时间戳的句子上的词挂不上挖空，不收
  const firstBySurface = new Map<string, Occurrence>();
  for (const sentence of visible) {
    if (sentence.startTime === undefined) continue;
    // 已经挖了空的、DW 标过 Glossar 候选的，这一课里已经有它自己的入口了
    const taken: Range[] = [
      ...sentence.blanks.flatMap((b) => b.ranges),
      ...(lesson.glossary ?? []).filter((c) => c.sentenceIndex === sentence.index).flatMap((c) => c.ranges),
    ];
    for (const token of tokenize(sentence.text)) {
      if (!token.isWord || token.text.length < MIN_FOUND || /\d/.test(token.text)) continue;
      if (taken.some((r) => token.start < r.end && r.start < token.end)) continue;
      const k = normalizeKey(token.text);
      // 先按词形筛：一课里大多数词都在这一步走掉，省下查词典（一次一个 100KB 的桶）
      if (firstBySurface.has(k) || deps.commonForms.has(k)) continue;
      firstBySurface.set(k, { surface: token.text, sentenceIndex: sentence.index, range: { start: token.start, end: token.end } });
    }
  }

  // 按桶排序再查：词典的桶 LRU 只有 6 个，同桶的连着查才吃得到缓存
  const occurrences = [...firstBySurface.entries()]
    .sort(([a], [b]) => bucketHex(a).localeCompare(bucketHex(b)))
    .map(([, occ]) => occ);

  const byKey = new Map<string, { candidate: VocabCandidate; order: number; found: boolean }>();
  const order = new Map([...firstBySurface.values()].map((o, i) => [o, i]));
  for (const occ of occurrences) {
    const hit = await deps.lookup(occ.surface).catch(() => null);
    const key = normalizeKey(hit ? hit.entry.w : occ.surface);
    if (deps.commonKeys.has(key) || deps.takenKeys.has(key) || deps.knownKeys.has(key)) continue;
    if (!hit && occ.surface.length < MIN_UNKNOWN) continue;
    const senses = hit?.entry.s ?? [];
    if (hit && senses.length > 0 && senses.every((s) => s.p === 'propn')) continue;

    const at = order.get(occ) ?? 0;
    const existing = byKey.get(key);
    // 同一个词元的几种词形（`Plattform` / `Plattformen`）：留课文里最早出现的那一个
    if (existing && existing.order <= at) continue;
    const sense = senses.find((s) => s.de?.length || s.zh?.length) ?? senses[0];
    byKey.set(key, {
      order: at,
      found: !!hit,
      candidate: {
        key,
        headword: hit?.entry.w ?? occ.surface,
        surface: occ.surface,
        gender: sense?.g,
        meaning: sense?.de?.[0] ?? sense?.zh?.slice(0, 2).join('、') ?? sense?.en?.[0],
        freq: hit?.entry.f,
        sentenceIndex: occ.sentenceIndex,
        ranges: [occ.range],
      },
    });
  }

  const all = [...byKey.values()];
  const found = all
    .filter((c) => c.found)
    .sort((a, b) => (a.candidate.freq ?? 0) - (b.candidate.freq ?? 0) || a.order - b.order)
    .map((c) => c.candidate);
  const unknown = all
    .filter((c) => !c.found)
    .sort((a, b) => a.order - b.order)
    .map((c) => c.candidate);
  return { found, unknown, timed };
}
