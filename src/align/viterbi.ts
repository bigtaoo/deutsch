// CTC 强制对齐：给定帧级 log-prob 与已知的 token 序列，求最优单调对齐路径。
//
// 这就是 torchaudio.functional.forced_align 做的事，只是搬到 TS 里，
// 因为 §3.1.1 R-1 让这个项目不能有后端，对齐必须在浏览器里跑。
//
// ── 状态展开 ──
// CTC 的合法路径是「在 blank 与目标 token 之间单调前进」，标准做法是把长度 T 的目标
// 展开成长度 2T+1 的状态序列 [blank, t0, blank, t1, blank, ..., blank]。
// 偶数位是 blank，奇数位是第 (i-1)/2 个 token。三种转移：
//   1. 停在原状态
//   2. 从前一个状态来
//   3. 跳过一个 blank（从 s-2 来）—— **仅当 t[s] != t[s-2]**
// 第 3 条的限制是 CTC 的全部精髓所在：`hallo` 里两个 l 之间必须夹一个 blank，
// 否则解码时会被折叠成一个 l。少了这个条件，所有含双写字母的德语词（alle/immer/kommen，
// 满篇都是）边界都会错。
//
// ── 数值 ──
// 全程在 log 域做加法，不做 exp。float32 的 -Infinity 参与 Math.max 是安全的。
//
// ── 内存 ──
// trellis 是 frames × (2T+1)。6 分钟音频 = 18800 帧，整篇稿件 ≈ 5000 字符 → 1.88 亿格，
// float32 存不下。所以这里只提供**窗口内**的对齐，长音频由 align.ts 用锚点滑窗切开调用。
// 回溯指针用 Uint8Array（只有 3 种转移，够了），是这里唯一按 frames×states 分配的数组。

/** 一个 token 占据的帧区间，右开：[startFrame, endFrame)。 */
export interface TokenSpan {
  startFrame: number;
  endFrame: number;
  /** 该 token 在其占据帧上的平均 log-prob，越接近 0 越可信 */
  score: number;
}

export interface AlignResult {
  spans: TokenSpan[];
  /** 整条路径的平均 log-prob，用来判断这段对齐值不值得信 */
  score: number;
}

/**
 * @param logProbs 帧优先的扁平数组，长度 frames * vocabSize，已做过 log-softmax
 * @param targets  目标 token id 序列（不含 blank）
 */
export function forcedAlign(
  logProbs: Float32Array,
  frames: number,
  vocabSize: number,
  targets: ArrayLike<number>,
  blankId = 0,
): AlignResult {
  const T = targets.length;
  if (T === 0) return { spans: [], score: 0 };
  // 每个 token 至少占 1 帧，且相邻同字之间还要塞一个 blank 帧。
  // 帧数不够时不存在合法路径，与其返回一条假路径，不如让调用方知道。
  let minFrames = T;
  for (let i = 1; i < T; i++) if (targets[i] === targets[i - 1]) minFrames++;
  if (frames < minFrames) {
    throw new Error(`帧数不足：${frames} 帧放不下 ${T} 个 token（至少需要 ${minFrames}）`);
  }

  const S = 2 * T + 1;
  const stateToken = new Int32Array(S);
  for (let s = 0; s < S; s++) stateToken[s] = s % 2 === 0 ? blankId : targets[(s - 1) / 2];

  const NEG = -Infinity;
  let prev = new Float32Array(S).fill(NEG);
  let cur = new Float32Array(S).fill(NEG);
  // 0 = 停留, 1 = 来自 s-1, 2 = 来自 s-2
  const back = new Uint8Array(frames * S);

  const emit = (t: number, s: number) => logProbs[t * vocabSize + stateToken[s]];

  // 起点只能是 state 0（blank）或 state 1（第一个 token）。
  prev[0] = emit(0, 0);
  if (S > 1) prev[1] = emit(0, 1);
  back[0] = 0;
  if (S > 1) back[1] = 1;

  for (let t = 1; t < frames; t++) {
    cur.fill(NEG);
    const rowBase = t * S;
    // 剪枝：t 帧最多只可能走到 state 2t+1，也最少必须走到 S-2*(frames-t)。
    // 不剪也对，但这让每帧的工作量正比于「还剩多少路要走」而不是 S。
    const lo = Math.max(0, S - 2 * (frames - t));
    const hi = Math.min(S - 1, 2 * t + 1);
    for (let s = lo; s <= hi; s++) {
      let best = prev[s];
      let from: 0 | 1 | 2 = 0;
      if (s >= 1 && prev[s - 1] > best) {
        best = prev[s - 1];
        from = 1;
      }
      // 跳 blank：目标状态必须是 token（奇数位），且与前一个 token 不同字
      if (s >= 2 && s % 2 === 1 && stateToken[s] !== stateToken[s - 2] && prev[s - 2] > best) {
        best = prev[s - 2];
        from = 2;
      }
      if (best === NEG) continue;
      cur[s] = best + emit(t, s);
      back[rowBase + s] = from;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }

  // 终点只能是最后一个 token（S-2）或它后面那个 blank（S-1）。
  let state = prev[S - 1] >= prev[S - 2] ? S - 1 : S - 2;
  if (prev[state] === NEG) throw new Error('对齐失败：没有合法路径到达终点');
  const total = prev[state];

  // 回溯：记录每一帧落在哪个 state。
  const path = new Int32Array(frames);
  for (let t = frames - 1; t >= 0; t--) {
    path[t] = state;
    if (t > 0) state -= back[t * S + state];
  }

  // 折叠成 token 区间。只有奇数 state 是 token；blank 帧不归任何 token。
  const spans: TokenSpan[] = [];
  for (let i = 0; i < T; i++) spans.push({ startFrame: -1, endFrame: -1, score: 0 });
  for (let t = 0; t < frames; t++) {
    const s = path[t];
    if (s % 2 === 0) continue;
    const i = (s - 1) / 2;
    const span = spans[i];
    if (span.startFrame === -1) span.startFrame = t;
    span.endFrame = t + 1;
    span.score += logProbs[t * vocabSize + stateToken[s]];
  }
  for (const span of spans) {
    const n = span.endFrame - span.startFrame;
    span.score = n > 0 ? span.score / n : NEG;
  }
  return { spans, score: total / frames };
}
