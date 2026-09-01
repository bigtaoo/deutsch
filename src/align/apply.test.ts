import { describe, expect, it } from 'vitest';
import { applyTimings, isManual, LEAD_SECONDS, reviewQueue, TAIL_SECONDS } from './apply';
import type { Sentence } from '@/types/models';
import type { SentenceTiming } from './target';

function sentence(index: number, over: Partial<Sentence> = {}): Sentence {
  return {
    index,
    text: `Satz ${index}`,
    charStart: 0,
    charEnd: 6,
    endTimeExplicit: false,
    blanks: [],
    markedDifficult: false,
    excluded: false,
    ...over,
  };
}

const timing = (index: number, start: number, end: number, confidence = -0.1): SentenceTiming => ({
  index,
  start,
  end,
  confidence,
});

describe('applyTimings', () => {
  it('写入起止时间、来源与置信度', () => {
    const { sentences, applied } = applyTimings([sentence(0)], [timing(0, 1, 2, -0.25)], {
      audioDuration: 10,
    });
    expect(applied).toBe(1);
    expect(sentences[0].startTime).toBeCloseTo(1 - LEAD_SECONDS);
    expect(sentences[0].endTime).toBeCloseTo(2 + TAIL_SECONDS);
    expect(sentences[0].endTimeExplicit).toBe(true);
    expect(sentences[0].timingSource).toBe('auto');
    expect(sentences[0].timingConfidence).toBeCloseTo(-0.25);
  });

  it('终点不许越过下一句的起点', () => {
    // 两句只隔 0.05 秒，比 TAIL_SECONDS 小
    const { sentences } = applyTimings(
      [sentence(0), sentence(1)],
      [timing(0, 1, 2), timing(1, 2.05, 3)],
      { audioDuration: 10 },
    );
    expect(sentences[0].endTime).toBeCloseTo(2.05 - LEAD_SECONDS);
    expect(sentences[0].endTime!).toBeLessThanOrEqual(sentences[1].startTime!);
  });

  it('最后一句的终点被音频时长夹住（否则会念进片尾音乐）', () => {
    const { sentences } = applyTimings([sentence(0)], [timing(0, 1, 9.95)], { audioDuration: 10 });
    expect(sentences[0].endTime).toBeCloseTo(10);
  });

  it('起点不会被 LEAD 拉到负数', () => {
    const { sentences } = applyTimings([sentence(0)], [timing(0, 0.01, 1)], { audioDuration: 10 });
    expect(sentences[0].startTime).toBe(0);
  });

  it('默认不覆盖人工标注', () => {
    const manual = sentence(0, { startTime: 5, endTime: 6, timingSource: 'manual' });
    const { sentences, applied, skippedManual } = applyTimings(
      [manual],
      [timing(0, 1, 2)],
      { audioDuration: 10 },
    );
    expect(applied).toBe(0);
    expect(skippedManual).toBe(1);
    expect(sentences[0].startTime).toBe(5);
  });

  it('overwriteManual 时才覆盖人工标注', () => {
    const manual = sentence(0, { startTime: 5, timingSource: 'manual' });
    const { sentences, applied } = applyTimings([manual], [timing(0, 1, 2)], {
      audioDuration: 10,
      overwriteManual: true,
    });
    expect(applied).toBe(1);
    expect(sentences[0].startTime).toBeCloseTo(1 - LEAD_SECONDS);
  });

  it('自动结果可以反复重跑：覆盖上一次的 auto 值', () => {
    const first = applyTimings([sentence(0)], [timing(0, 1, 2)], { audioDuration: 10 }).sentences;
    const second = applyTimings(first, [timing(0, 3, 4)], { audioDuration: 10 }).sentences;
    expect(second[0].startTime).toBeCloseTo(3 - LEAD_SECONDS);
  });

  it('没有 timing 的句子（排除句、纯数字句）原样不动', () => {
    const input = [sentence(0), sentence(1, { excluded: true }), sentence(2)];
    const { sentences } = applyTimings(input, [timing(0, 1, 2), timing(2, 3, 4)], {
      audioDuration: 10,
    });
    expect(sentences[1]).toBe(input[1]);
    expect(sentences[1].startTime).toBeUndefined();
  });

  it('夹终点时跳过中间没有时间戳的句子', () => {
    // 句 1 是排除句、无 timing；句 0 的终点该被句 2 的起点夹住
    const input = [sentence(0), sentence(1, { excluded: true }), sentence(2)];
    const { sentences } = applyTimings(input, [timing(0, 1, 2), timing(2, 2.02, 4)], {
      audioDuration: 10,
    });
    expect(sentences[0].endTime).toBeCloseTo(2.02 - LEAD_SECONDS);
  });

  it('终点永不早于起点', () => {
    // 病态输入：end < start
    const { sentences } = applyTimings([sentence(0)], [timing(0, 5, 1)], { audioDuration: 10 });
    expect(sentences[0].endTime!).toBeGreaterThanOrEqual(sentences[0].startTime!);
  });
});

describe('reviewQueue', () => {
  /** 按一批置信度造出 auto 句子。 */
  const withConfidences = (values: number[]) =>
    applyTimings(
      values.map((_, i) => sentence(i)),
      values.map((c, i) => timing(i, i * 2, i * 2 + 1, c)),
      {},
    ).sentences;

  it('在真实分布上只挑出最差的几句，而不是几乎全标', () => {
    // 取自一期真实 Alltagsdeutsch 的实测分布（中位数 -1.11、最好 -0.31、最差 -3.50）
    const real = [
      -3.5, -3.13, -2.4, -1.24, -1.11, -1.45, -0.92, -1.05, -0.31, -1.2,
      -1.35, -0.88, -1.02, -1.18, -0.75, -1.4, -1.09, -0.95, -1.3, -1.15,
    ];
    const queue = reviewQueue(withConfidences(real));
    // 关键性质：远少于总数。旧的绝对阈值 -0.6 会在这批数据上标出 19/20 句。
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.length).toBeLessThanOrEqual(5);
    // 最差的三句一定在里面
    expect(queue.slice(0, 3).map((s) => s.timingConfidence)).toEqual([-3.5, -3.13, -2.4]);
  });

  it('最差的排最前', () => {
    const queue = reviewQueue(withConfidences([-1, -1, -1, -1, -3, -2.2, -1]));
    expect(queue.map((s) => s.timingConfidence)).toEqual([-3, -2.2]);
  });

  it('整课都不错时一句不报', () => {
    expect(reviewQueue(withConfidences([-0.3, -0.35, -0.4, -0.32, -0.38]))).toHaveLength(0);
  });

  it('整课都很差时靠 floor 兜底，不会因为「大家都差」而一句不报', () => {
    // 中位数 -3.2，相对阈值会跑到 -4.0 —— 那样只有最极端的一句会被标。
    // floor 把阈值拉回 -2.5，于是差的都被标出来。
    const queue = reviewQueue(withConfidences([-3.0, -3.2, -3.4, -3.1, -3.6]));
    expect(queue.length).toBe(5);
  });

  it('相对基准让阈值随本课水平移动', () => {
    // 同一个 -1.6，在「整课都在 -1.5 左右」时不该报，在「整课都在 -0.4 左右」时该报
    const bad = withConfidences([-1.5, -1.45, -1.6, -1.55, -1.5]);
    expect(reviewQueue(bad).map((s) => s.timingConfidence)).not.toContain(-1.6);
    const good = withConfidences([-0.4, -0.35, -1.6, -0.45, -0.4]);
    expect(reviewQueue(good).map((s) => s.timingConfidence)).toContain(-1.6);
  });

  it('人工标注过的不再出现在队列里（老数据里还有这种句子）', () => {
    const auto = withConfidences([-3.5, -1, -1, -1, -1]);
    expect(reviewQueue(auto).map((s) => s.index)).toEqual([0]);
    const confirmed = auto.map((s) =>
      s.index === 0 ? { ...s, timingSource: 'manual' as const, timingConfidence: undefined } : s,
    );
    expect(reviewQueue(confirmed)).toHaveLength(0);
  });

  it('排除句不进队列', () => {
    const input = applyTimings([sentence(0, { excluded: true })], [timing(0, 1, 2, -9)], {}).sentences;
    expect(reviewQueue(input)).toHaveLength(0);
  });

  it('从未对齐过的句子不进队列', () => {
    expect(reviewQueue([sentence(0)])).toHaveLength(0);
  });
});

describe('isManual（FR-15 之前的老数据兼容）', () => {
  it('有 startTime 但没有 timingSource 的老数据算人工', () => {
    expect(isManual(sentence(0, { startTime: 12.3 }))).toBe(true);
  });

  it('从未标注过的句子不算人工', () => {
    expect(isManual(sentence(0))).toBe(false);
  });

  it('明确是 auto 的不算人工', () => {
    expect(isManual(sentence(0, { startTime: 1, timingSource: 'auto' }))).toBe(false);
  });

  it('自动打点不会覆盖 FR-15 之前手打的时间戳', () => {
    const legacy = sentence(0, { startTime: 12.3, endTime: 14, endTimeExplicit: true });
    const { sentences, skippedManual } = applyTimings([legacy], [timing(0, 1, 2)], {
      audioDuration: 100,
    });
    expect(skippedManual).toBe(1);
    expect(sentences[0].startTime).toBe(12.3);
  });
});
