// 把对齐结果写回 Sentence[]。纯函数，与浏览器 API 无关，所以能完整单测。
//
// ── 为什么要给终点补一点尾巴 ──
// CTC 对齐给出的止帧就是最后一个音素的最后一帧。按它切，跟读时会听到句子被削掉尾音
// （德语句尾的 -t/-en 释放、自然衰减都在那之后）。所以统一往后放一点，
// 但不许越过下一句的起点 —— 宁可短一点，也不能把下一句的头音混进来（§跟读时那是直接听错）。
//
// ── 为什么不覆盖人工标注 ──
// 自动对齐可以反复重跑（换模型、改了切句），但人工打过的点是不可重建的劳动。
// 默认只填 timingSource !== 'manual' 的句子；要全量重算得显式传 overwriteManual。

import type { Sentence } from '@/types/models';
import type { SentenceTiming } from './target';

/** 起点向前让一点，避免削掉起音。 */
export const LEAD_SECONDS = 0.05;
/** 终点向后放一点，避免削掉尾音。 */
export const TAIL_SECONDS = 0.15;

export interface ApplyOptions {
  /** 音频总时长，用来夹住最后一句的终点 */
  audioDuration?: number;
  /** 连人工标注过的句子一起覆盖。默认 false */
  overwriteManual?: boolean;
}

export interface ApplyResult {
  sentences: Sentence[];
  /** 实际被写入时间戳的句子数 */
  applied: number;
  /** 因为已有人工标注而跳过的句子数 */
  skippedManual: number;
}

/**
 * 这一句的时间戳是不是人手来的。
 *
 * **timingSource 缺失且有 startTime = 人手来的。** FR-15 之前打的点根本没有这个字段，
 * 只判 `=== 'manual'` 会把它们当成机器给的，一次自动打点就静默覆盖掉几十分钟的劳动 ——
 * 而打点是这个应用里最不可重建的东西（§6）。新数据一定带 timingSource，
 * 所以这条兼容判断只会命中老数据。
 */
export function isManual(sentence: Sentence): boolean {
  if (sentence.timingSource === 'manual') return true;
  return sentence.timingSource === undefined && sentence.startTime !== undefined;
}

export function applyTimings(
  sentences: Sentence[],
  timings: SentenceTiming[],
  options: ApplyOptions = {},
): ApplyResult {
  const { audioDuration, overwriteManual = false } = options;
  const byIndex = new Map(timings.map((t) => [t.index, t]));

  // 夹住终点用的「下一句起点」要按 timings 自己的顺序找，不能按 sentences ——
  // 中间可能夹着排除句和无时间戳的句子。
  const ordered = [...timings].sort((a, b) => a.start - b.start);
  const nextStart = new Map<number, number>();
  for (let i = 0; i < ordered.length - 1; i++) {
    nextStart.set(ordered[i].index, ordered[i + 1].start);
  }

  let applied = 0;
  let skippedManual = 0;

  const out = sentences.map((sentence) => {
    const timing = byIndex.get(sentence.index);
    if (!timing) return sentence;
    if (!overwriteManual && isManual(sentence)) {
      skippedManual++;
      return sentence;
    }

    const start = Math.max(0, timing.start - LEAD_SECONDS);
    // 上界依次是：下一句**挪过 LEAD 之后**的起点、音频总时长。两个都没有就只放 TAIL_SECONDS。
    // 夹下一句的原始起点是不够的 —— 下一句自己也向前让了 LEAD，
    // 那样两句会正好重叠一个 LEAD，下一句的头音就混进上一句尾巴里了。
    const next = nextStart.get(timing.index);
    const ceiling = next !== undefined ? Math.max(0, next - LEAD_SECONDS) : audioDuration ?? Infinity;
    const end = Math.min(timing.end + TAIL_SECONDS, ceiling);

    applied++;
    return {
      ...sentence,
      startTime: start,
      // 终点是显式的（就是最后一个音素的止帧），否则 FR-4.4 会让最后一句一直播到
      // 音频结束，把片尾音乐也念进去。「还没人校过」由 timingSource 表达，不占这个字段。
      endTime: Math.max(start, end),
      endTimeExplicit: true,
      timingSource: 'auto' as const,
      timingConfidence: timing.confidence,
    };
  });

  return { sentences: out, applied, skippedManual };
}

/**
 * 人工在打点页改了某句 —— 把它从「机器给的」升级成「我确认过的」。
 * 置信度一并清掉：留着会让 UI 继续把这句排进待校对列表。
 */
export function markManual(sentences: Sentence[], index: number): Sentence[] {
  return sentences.map((s) =>
    s.index === index ? { ...s, timingSource: 'manual' as const, timingConfidence: undefined } : s,
  );
}

/**
 * 「明显比本课典型水平差」的差距，单位是每 token 的平均 log-prob。
 *
 * 这个数是**实测标定**的，不是拍的：在一期真实 Alltagsdeutsch（6:16，38 句自动对齐）上，
 * 置信度分布是 中位数 -1.11 / 最好 -0.31 / 最差 -3.50 / p25 -1.45。
 * 取 0.8 的差距会挑出最差的四五句 —— 正好是 §3.3 想要的「从 37 句降到 3 句」那个量级。
 * 一开始按感觉写的绝对阈值 -0.6 会把 37/38 句全标黄，等于没标。
 */
export const REVIEW_MARGIN = 0.8;

/** 灾难性阈值：整课都很差时也要把最烂的挑出来，不能因为「大家都差」而一句不报。 */
export const REVIEW_FLOOR = -2.5;

/**
 * 待校对队列：自动对齐过、且明显比本课典型水平差的句子，最差的排最前。
 *
 * 用**相对**基准（本课中位数）而不是绝对阈值，是因为绝对值随模型和语言漂：
 * MMS-FA 吃的是罗马化文本（丢了 ä/ö/ü 的区分、丢了数字标点），每 token
 * 平均 -1.1 是正常水平而不是「差」。换成 config.ts 里说的那种德语专用模型，
 * 整条分布会整体上移，绝对阈值当场失效，相对基准不会。
 *
 * DW 素材里真正会出问题的地方是固定的几类 —— 台标音乐、播音员交替、英语借词
 * （„Working Holiday Visum"）、被丢掉的数字（"zwischen 18 und 30"）——
 * 它们都表现为这一句的平均 log-prob 明显掉下来。实测最差那三句正是这几类。
 */
export function reviewQueue(sentences: Sentence[]): Sentence[] {
  const auto = sentences.filter(
    (s) => !s.excluded && s.timingSource === 'auto' && s.timingConfidence !== undefined,
  );
  if (auto.length === 0) return [];

  const sorted = [...auto].sort((a, b) => a.timingConfidence! - b.timingConfidence!);
  const median = sorted[Math.floor(sorted.length / 2)].timingConfidence!;
  const threshold = Math.max(median - REVIEW_MARGIN, REVIEW_FLOOR);

  return sorted.filter((s) => s.timingConfidence! < threshold);
}
