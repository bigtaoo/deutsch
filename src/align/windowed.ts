// 长音频的分段对齐驱动。
//
// 为什么不能一把梭：forcedAlign 的 trellis 是 frames × (2T+1)。
// 一期 Alltagsdeutsch 是 6 分 16 秒 = 18800 帧，整篇稿件罗马化后约 4000 个 token，
// 于是 S = 8001，格子数 1.5 亿。回溯指针哪怕只用 1 字节也是 150MB，
// 在手机 WebView 里就是直接崩。所以按锚点向前滑窗，每窗独立对齐。
//
// ── 滑窗为什么是「宁少喂 token」而不是「多喂再砍」 ──
// 一个窗口拿到的 token 数只能靠估（token/帧 的平均速率），估错两个方向不对称：
//   · 喂少了：这些 token 确实都在这段音频里说完了，对齐器把它们放对，
//     剩下的音频由 blank 吸收 —— 完全无害。
//   · 喂多了：多出来的 token 在这段音频里根本没被念到，对齐器只能把它们硬塞进窗口尾部，
//     产生一串挤在一起的假边界。
// 所以速率上乘一个 <1 的系数故意低估，再额外丢掉窗尾一小段不提交。
// 两道保险叠起来，代价只是多滑几窗。
//
// ── 单调推进不可回退 ──
// 提交过的锚点不再修改。这意味着第一窗错了后面会一路漂，所以每句都带 confidence，
// 由 UI 把低分句挑出来人工校对（§3.3 的一贯态度：把要改的从 37 句降到 3 句，不假装降到 0）。

import { forcedAlign, type AlignResult, type TokenSpan } from './viterbi';

export interface WindowedOptions {
  /** 每窗音频帧数。50 帧/秒，默认 30 秒 */
  windowFrames?: number;
  /** 速率低估系数：实际估出的 token 数再乘这个 */
  rateSlack?: number;
  /** 窗尾不提交的比例 */
  tailDiscard?: number;
  /** 格子数低于这个值就不滑窗，整段一把对齐（结果更优） */
  fullAlignCells?: number;
  onProgress?: (fraction: number) => void;
}

const DEFAULTS = {
  windowFrames: 30 * 50,
  rateSlack: 0.75,
  tailDiscard: 0.15,
  fullAlignCells: 32_000_000,
};

export function alignWindowed(
  logProbs: Float32Array,
  frames: number,
  vocabSize: number,
  targets: Int32Array,
  opts: WindowedOptions = {},
): AlignResult {
  const { windowFrames, rateSlack, tailDiscard, fullAlignCells } = { ...DEFAULTS, ...opts };
  const T = targets.length;
  if (T === 0) return { spans: [], score: 0 };

  if (frames * (2 * T + 1) <= fullAlignCells) {
    opts.onProgress?.(1);
    return forcedAlign(logProbs, frames, vocabSize, targets);
  }

  const spans: TokenSpan[] = [];
  let scoreSum = 0;
  let scoreFrames = 0;
  let frameCursor = 0;
  let tokenCursor = 0;

  while (tokenCursor < T) {
    const remainingFrames = frames - frameCursor;
    const remainingTokens = T - tokenCursor;

    // 剩下的音频已经装得下整段 trellis，或者剩下的 token 本来就不多 —— 收尾，一把对完。
    const isLast =
      remainingFrames <= windowFrames ||
      remainingFrames * (2 * remainingTokens + 1) <= fullAlignCells;

    let winFrames = isLast ? remainingFrames : windowFrames;
    let winTokens = remainingTokens;
    if (!isLast) {
      const rate = remainingTokens / remainingFrames;
      winTokens = Math.min(remainingTokens, Math.max(1, Math.floor(rate * winFrames * rateSlack)));
      // 低估之后如果反而覆盖了全部 token，那就是收尾窗，把剩余音频全给它，
      // 否则末尾的 token 会被挤在窗口边界上。
      if (winTokens === remainingTokens) winFrames = remainingFrames;
    }

    const { result: window, aligned } = alignWindowSafely(
      logProbs,
      frameCursor,
      winFrames,
      vocabSize,
      targets.subarray(tokenCursor, tokenCursor + winTokens),
    );
    // 退让过的话，这一窗实际只对上了 aligned 个 token，剩下的下一窗重排。
    winTokens = aligned;

    const isFinalWindow = tokenCursor + winTokens >= T;
    // 窗尾丢掉一小段不提交（收尾窗除外 —— 它没有下一窗可以补）。
    const commit = isFinalWindow
      ? winTokens
      : Math.max(1, Math.floor(winTokens * (1 - tailDiscard)));

    for (let i = 0; i < commit; i++) {
      const s = window.spans[i];
      spans.push({
        startFrame: s.startFrame + frameCursor,
        endFrame: s.endFrame + frameCursor,
        score: s.score,
      });
    }
    scoreSum += window.score * winFrames;
    scoreFrames += winFrames;

    const nextFrame = frameCursor + window.spans[commit - 1].endFrame;
    tokenCursor += commit;
    // 音频游标必须真的前进，否则死循环。提交了 token 却没前进一帧是不可能的
    // （每个 token 至少占一帧），这里只是把不变量写下来。
    if (nextFrame <= frameCursor && tokenCursor < T) {
      throw new Error(`滑窗未推进：帧 ${frameCursor}，token ${tokenCursor}/${T}`);
    }
    frameCursor = nextFrame;
    opts.onProgress?.(tokenCursor / T);
  }

  return { spans, score: scoreFrames > 0 ? scoreSum / scoreFrames : 0 };
}

/**
 * 万一速率估歪到「窗口帧数放不下这些 token」，退一步砍掉尾部 token 重试，
 * 而不是让整篇对齐失败。砍掉的 token 会在下一窗重新排队，所以要把实际对上的个数
 * 一起返回 —— 调用方的 commit 是按它算的，用原始 winTokens 会越界。
 */
function alignWindowSafely(
  logProbs: Float32Array,
  frameStart: number,
  winFrames: number,
  vocabSize: number,
  targets: Int32Array,
): { result: AlignResult; aligned: number } {
  const slice = logProbs.subarray(frameStart * vocabSize, (frameStart + winFrames) * vocabSize);
  let n = targets.length;
  for (;;) {
    try {
      return { result: forcedAlign(slice, winFrames, vocabSize, targets.subarray(0, n)), aligned: n };
    } catch (err) {
      if (n <= 1) throw err;
      n = Math.floor(n / 2);
    }
  }
}
