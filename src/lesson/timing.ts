// FR-4.4：endTime 规则 —— 显式标记优先；未显式标记时取**下一个有 startTime 的句子**的 startTime；
// 若无后续标注则取音频总时长。
//
// 注意「下一个有 startTime 的句子」而不是「下一句」：打点是稀疏的（§3.3），
// 标了第 3 句和第 40 句，第 3 句的终点就该是第 40 句的起点 —— 中间那 36 句根本没被标注，
// 拿第 4 句（无时间戳）当终点会得到 undefined，整句变成播不了。

import type { Sentence } from '@/types/models';

export interface Range {
  start: number;
  end: number;
  /** true = 显式标记的终点（UI 画实线），false = 推断出来的（画虚线） */
  explicitEnd: boolean;
}

export function resolveRange(
  sentences: Sentence[],
  index: number,
  audioDuration: number | undefined,
): Range | null {
  const sentence = sentences[index];
  if (!sentence || sentence.startTime === undefined) return null;

  if (sentence.endTimeExplicit && sentence.endTime !== undefined) {
    return { start: sentence.startTime, end: sentence.endTime, explicitEnd: true };
  }

  for (let i = index + 1; i < sentences.length; i++) {
    const next = sentences[i];
    if (next.startTime !== undefined) {
      return { start: sentence.startTime, end: next.startTime, explicitEnd: false };
    }
  }

  // 没有后续标注：退到音频总时长。总时长也不知道时给一个保底 10 秒，
  // 好过返回 null 让 UI 出现「点了重播却没有声音」的死角（§3.3 R3）。
  const end = audioDuration && audioDuration > sentence.startTime ? audioDuration : sentence.startTime + 10;
  return { start: sentence.startTime, end, explicitEnd: false };
}

/** 跟读/听写的可用队列：已标注 + 未排除。顺序按 index，不按 startTime —— 打点可以乱序，但朗读顺序是文本顺序。 */
export function annotatedSentences(sentences: Sentence[]): Sentence[] {
  return sentences.filter((s) => !s.excluded && s.startTime !== undefined);
}

/** FR-5.2：通听时高亮当前句。只在已标注句上高亮，未标注句不做假装的伪同步。 */
export function sentenceIndexAt(
  sentences: Sentence[],
  time: number,
  audioDuration: number | undefined,
): number | null {
  for (const sentence of annotatedSentences(sentences)) {
    const range = resolveRange(sentences, sentence.index, audioDuration);
    if (range && time >= range.start && time < range.end) return sentence.index;
  }
  return null;
}
