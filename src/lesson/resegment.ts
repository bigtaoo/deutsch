// FR-1.5：重新编辑原文后重新切句，**保留已有 startTime/blanks 的句子**（按文本内容匹配），
// 无法匹配的句子列出来让用户确认丢弃。
//
// 为什么按文本而不是按 offset 匹配：编辑原文时插入/删除任意一段，后面所有 offset 全变，
// offset 匹配会整体错位；而句子文本本身在多数编辑里是不动的。
//
// 匹配是**一对一**的：同一个旧句只能被认领一次，否则一篇里重复出现的短句（"Ja."）
// 会把同一份标注复制到好几个位置。

import type { Sentence } from '@/types/models';
import type { RawSegment } from './segment';
import { createSentences } from './sentences';

/** 有标注 = 值得抢救。没标注的旧句丢了无所谓，重切一遍就有。 */
export function hasAnnotations(sentence: Sentence): boolean {
  return (
    sentence.startTime !== undefined ||
    sentence.blanks.length > 0 ||
    sentence.markedDifficult ||
    sentence.excluded
  );
}

/** 匹配用的归一化：折叠空白 —— 换行改成空格这类编辑不该让标注作废。 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface ResegmentResult {
  sentences: Sentence[];
  /** 新句 index → 它继承自哪个旧句 index */
  carriedOver: Map<number, number>;
  /** 有标注但在新文稿里找不到对应句子的旧句 —— UI 必须列出来让用户确认（FR-1.5） */
  orphaned: Sentence[];
}

export function resegment(previous: Sentence[], segments: RawSegment[]): ResegmentResult {
  const fresh = createSentences(segments);

  // 归一化文本 → 还没被认领的旧句下标队列。
  const pool = new Map<string, number[]>();
  previous.forEach((s, i) => {
    const key = normalize(s.text);
    const bucket = pool.get(key);
    if (bucket) bucket.push(i);
    else pool.set(key, [i]);
  });

  const claimed = new Set<number>();
  const carriedOver = new Map<number, number>();

  const sentences = fresh.map((next) => {
    const bucket = pool.get(normalize(next.text));
    const oldIndex = bucket?.shift();
    if (oldIndex === undefined) return next;

    claimed.add(oldIndex);
    carriedOver.set(next.index, previous[oldIndex].index);
    const old = previous[oldIndex];
    return {
      ...next,
      // 文本与 offset 用新的（原文可能整体前后移动了），标注用旧的。
      // blanks 的 ranges 是句内 offset，文本一致就依然对得上。
      startTime: old.startTime,
      endTime: old.endTime,
      endTimeExplicit: old.endTimeExplicit,
      // FR-15：来源和置信度必须跟着时间戳一起搬。漏了这两条，
      // 重新切句会把「机器给的、还没校过」洗成「看起来人工确认过」—— 静默丢掉待办。
      timingSource: old.timingSource,
      timingConfidence: old.timingConfidence,
      blanks: old.blanks,
      markedDifficult: old.markedDifficult,
      excluded: old.excluded,
    };
  });

  const orphaned = previous.filter((s, i) => !claimed.has(i) && hasAnnotations(s));

  return { sentences, carriedOver, orphaned };
}
