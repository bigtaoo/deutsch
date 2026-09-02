// FR-5.2 的实现层：把「句子 + 词级时间戳」摊成可以逐词高亮的行，
// 并回答「此刻读到哪一行、哪一个词」。纯函数，不碰 React 也不碰音频，所以能完整单测。
//
// ── 为什么不直接用 Sentence.words 当渲染单位 ──
// 它的坐标是罗马化之后的产物（见 align/vocab.ts）：ä→a、ß→ss、标点和数字被丢掉，
// 词边界也和肉眼看到的不一样（`Work-and-Travel` 在那边是三个词）。
// 拿它当渲染单位，屏幕上就会出现「Work」「and」「Travel」三块各自闪烁的碎片，
// 而且数字、引号这些没有 token 的字符会整个消失。
// 所以渲染单位一律用 tokens.ts 的 tokenize()（挖空、听写用的也是它，坐标同一套），
// 时间戳只是**贴上去**的属性：一个显示词覆盖到的所有 wordTiming 取并集。
//
// ── 桥接：没有时间戳的词 ──
// 罗马化会丢掉纯数字（`18`、`1950er` 的数字部分），它们在音频里明明有声音却没有 token。
// 如果原样留空，「zwischen 18 und 30」在高亮走到中间时会整整一秒没有任何词亮着。
// 所以这里补一条：前后两侧都有真实时间戳时，把它们之间那段空档给中间这些词。
// 这**不是** FR-5.2 反对的「伪同步」—— 伪同步是在没有任何时间戳的地方按字数瞎猜，
// 这里的两个端点都是对齐器给出的真值，中间那段声音也确实属于这几个字符。

import { resolveRange } from './timing';
import { tokenize } from './tokens';
import type { Sentence, WordSpan } from '@/types/models';

export interface TimeSpan {
  start: number;
  end: number;
}

export interface KaraokeToken {
  text: string;
  /** 句内 offset，与 Blank.ranges 同一套坐标 */
  start: number;
  end: number;
  /** 标点与空白不参与高亮，也不可点 */
  isWord: boolean;
  /** 这个词在音频里的位置。追不到真实时间戳时没有这个字段 */
  time?: TimeSpan;
  /** true = 时间来自前后两个真锚点之间的空档（见文件头「桥接」） */
  bridged?: boolean;
}

export interface KaraokeLine {
  /** Sentence.index，不是数组下标 */
  index: number;
  text: string;
  excluded: boolean;
  /** 句级时间范围（FR-4.4 的规则）。没有时间戳的句子是 null，此时它永远不高亮 */
  range: TimeSpan | null;
  tokens: KaraokeToken[];
  /** 这一句有没有词级时间戳。没有就只做整句高亮 */
  hasWords: boolean;
}

/** 一个显示词覆盖到的所有 WordSpan 的并集。都追不到时返回 undefined。 */
function spanOf(timings: readonly WordSpan[], start: number, end: number): TimeSpan | undefined {
  let span: TimeSpan | undefined;
  for (const t of timings) {
    // 半开区间相交：只要有一个字符重合就算这个词的一部分
    if (t.charStart >= end || t.charEnd <= start) continue;
    span = span
      ? { start: Math.min(span.start, t.start), end: Math.max(span.end, t.end) }
      : { start: t.start, end: t.end };
  }
  return span;
}

/**
 * 桥接没有时间戳的词：向前找最近的已知终点，向后找最近的已知起点，两边都有才填。
 * 句级 range 的两端也算锚点 —— 句首的数字（`1950er-Jahre`）就是靠它接住的。
 */
function bridge(tokens: KaraokeToken[], range: TimeSpan | null): void {
  const words = tokens.filter((t) => t.isWord);
  // 锚点判定必须先算完：桥接出来的时间不许再当下一次桥接的锚点，
  // 否则连着两个无 token 的词时，第一个会吞掉整个空档、第二个什么都拿不到。
  const anchored = words.map((t) => t.time !== undefined);

  let i = 0;
  while (i < words.length) {
    if (anchored[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < words.length && !anchored[j]) j++;

    const from = i > 0 ? words[i - 1].time!.end : range?.start;
    const to = j < words.length ? words[j].time!.start : range?.end;
    if (from !== undefined && to !== undefined && to > from) {
      // 一段空档摊给这一串词，按字符数分。`1950 1960` 这种连号才用得上，
      // 单个词（绝大多数情况）算下来就是整段空档本身。
      const total = words.slice(i, j).reduce((n, t) => n + (t.end - t.start), 0);
      let cursor = from;
      for (let k = i; k < j; k++) {
        const share = total > 0 ? ((to - from) * (words[k].end - words[k].start)) / total : 0;
        words[k].time = { start: cursor, end: cursor + share };
        words[k].bridged = true;
        cursor += share;
      }
    }
    i = j;
  }
}

export function buildKaraoke(sentences: Sentence[], audioDuration?: number): KaraokeLine[] {
  return sentences.map((sentence, i) => {
    const range = resolveRange(sentences, i, audioDuration);
    const timings = sentence.words ?? [];
    const tokens: KaraokeToken[] = tokenize(sentence.text).map((token) => ({
      text: token.text,
      start: token.start,
      end: token.end,
      isWord: token.isWord,
      // 没有句级时间戳的句子连词级也不给：那一句在音频里的位置本来就是未知的
      time: token.isWord && range ? spanOf(timings, token.start, token.end) : undefined,
    }));
    // **至少要有一个真锚点才允许桥接。** 一句词级时间戳全缺（老数据、或者那一句罗马化后
    // 一个 token 都不剩）时，桥接的两端会双双退到句子自己的首尾 —— 于是每个词都拿到整句的区间，
    // 高亮永远停在最后一个词上。那才是 FR-5.2 点名要避免的伪同步，宁可整句只做句级高亮。
    const hasWords = tokens.some((t) => t.time !== undefined);
    if (range && hasWords) bridge(tokens, range);

    return {
      index: sentence.index,
      text: sentence.text,
      excluded: sentence.excluded,
      range: range ? { start: range.start, end: range.end } : null,
      tokens,
      hasWords,
    };
  });
}

export interface Active {
  /** KaraokeLine.index */
  line: number;
  /** 当前行里第几个 token（数组下标）。追不到词时为 null */
  token: number | null;
  /**
   * true  = 播放位置就落在这一句的时间范围内。
   * false = 落在两句之间的空档（台标音乐、换播音员、长停顿），
   *         这时仍然把**刚读完**的那一句标出来 —— 让高亮消失才是更糟的选择：
   *         人会以为对齐坏了，而实际上只是那半秒没人说话。
   */
  inside: boolean;
}

/**
 * 此刻读到哪里。线性扫一遍：一课几十句，60fps 下也是白噪音，
 * 换成二分要先假设 range 单调，而排除句、乱序标注都能破坏这个前提。
 */
export function activeAt(lines: KaraokeLine[], time: number): Active | null {
  let inside: KaraokeLine | null = null;
  let last: KaraokeLine | null = null;
  for (const line of lines) {
    if (!line.range) continue;
    if (time >= line.range.start && time < line.range.end) {
      inside = line;
      break;
    }
    if (line.range.end <= time && (!last || line.range.end > last.range!.end)) last = line;
  }

  const line = inside ?? last;
  if (!line) return null;
  return {
    line: line.index,
    token: inside ? activeTokenAt(inside, time) : null,
    inside: inside !== null,
  };
}

/**
 * 行内哪一个词。取「起点已经过去的最后一个词」而不是「时间落在其区间内的词」：
 * 词间总有几十毫秒的静音，按区间判会让高亮在每个词之间闪一下黑。
 * 亮着的词一直亮到下一个词开口，这也正是卡拉OK和 Spotify 的行为。
 */
export function activeTokenAt(line: KaraokeLine, time: number): number | null {
  let found: number | null = null;
  for (let i = 0; i < line.tokens.length; i++) {
    const span = line.tokens[i].time;
    if (span && span.start <= time) found = i;
  }
  return found;
}
