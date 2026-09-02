// FR-10.4：**评分由系统算，不让用户选。**
//
// 原来的复习页是 Anki 形状：翻面之后四个按钮（忘了 / 勉强 / 记得 / 太简单），
// 每个按钮下面还写着「3 天 / 1 个月」。那个形状被废掉的理由有两条，
// 都值得写在这里，因为它们决定了这个文件的形状：
//
//   ① **自评是元认知任务。** 「我对这个词的记忆强度是几档」不是学德语，
//      是对自己的记忆做一次估计 —— 每张卡都要做一次，一天十几次。
//   ② **手评和自动评分不能并存。** 两者喂给 FSRS 的评分分布不一样
//      （人手评的 Good 偏多，自动判的 Again 偏多），混着用会让 FSRS 的
//      难度/稳定度参数落在一个既不像手评也不像自动判的地方。所以旧按钮
//      是**删掉**，不是留一个高级入口。
//
// ── 为什么单独一个文件、而且是纯函数 ──
// 这里的阈值是**会被调**的（4s / 1.5s 是拍出来的，不是测出来的），
// 而它每改一次都会影响几个月后的复习间隔。放在组件里改一次要手点十几张卡才能验，
// 放在这里改一次跑一遍单测就知道有没有把某一档判没了。

import type { FSRSCard } from '@/types/models';
import type { ReviewRating } from './fsrs';

/** 一次作答。`elapsedMs` 从「音频开始播」算到「点下选项」。 */
export interface Answer {
  correct: boolean;
  /** 点了「没听清 / 不认识」。它与 correct=false 的区别见下面那段。 */
  gaveUp: boolean;
  elapsedMs: number;
}

/**
 * 阈值。
 *
 * `easyMs` 比 `hardMs` 小得多不是笔误：三档是「秒答 / 正常 / 犹豫」，
 * 而不是均匀切分。1.5 秒是「听到就知道」，4 秒以上是「在四个选项里推理」——
 * 后者在四选一里尤其要当成 Hard：选项本身提供了线索，能靠排除法做对的题
 * 不代表下次没有选项时也想得起来。
 */
export const GRADE_THRESHOLDS = {
  /** 答对且快于此 → 有资格拿 Easy（还要历史无错，见下） */
  easyMs: 1_500,
  /** 答对但慢于此 → Hard */
  hardMs: 4_000,
} as const;

/**
 * 把一次作答映射成 FSRS 的四档。
 *
 * ── Easy 为什么要加「历史无错」这个条件 ──
 * 四选一有 **25% 的瞎猜命中率**。只看用时的话，随手一点正好点对
 * （那必然很快）会被判成 Easy —— 而 Easy 在 FSRS 里是最长的那个间隔。
 * 一次幸运的乱点能把一张根本不会的卡推到一个月以后。所以 Easy 要求
 * `lapses === 0`：这张卡从来没错过，那么「快且对」更可能是真的会。
 *
 * ── gaveUp 为什么不判成比 Again 更差的东西 ──
 * FSRS 只有四档，Again 已经是最差。把「主动承认不认识」和「选错」区分开
 * 不是为了给不同的评分，而是为了**不让它进猜对的统计**（见 Easy 那条）
 * 以及让卡面直接展开（用户已经表示不知道，再让他看四个选项是浪费时间）。
 */
export function gradeFromAnswer(answer: Answer, card: FSRSCard): ReviewRating {
  if (answer.gaveUp || !answer.correct) return 'again';
  if (answer.elapsedMs >= GRADE_THRESHOLDS.hardMs) return 'hard';
  if (answer.elapsedMs < GRADE_THRESHOLDS.easyMs && card.lapses === 0 && card.reps > 0) return 'easy';
  return 'good';
}

/**
 * 答对时那条一闪而过的确认里要显示的词形（FR-10.11）。
 *
 * **名词必须带冠词。** 答对是主路径，而主路径不展开卡背 —— 如果这里也不给性，
 * 那么「德语名词不带性等于没记」（FR-7.4）这条立场就在最常走的那条路上
 * 被悄悄取消了。600ms 看不完一整个卡背，但看得完 `der Vorhang`。
 */
export function articled(surface: string, gender: 'm' | 'f' | 'n' | undefined): string {
  if (!gender) return surface;
  return `${{ m: 'der', f: 'die', n: 'das' }[gender]} ${surface}`;
}
