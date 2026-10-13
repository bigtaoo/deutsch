// FR-5 通听「跟随播放」：框该滚到哪儿。纯函数，量尺寸的活留给调用方。
//
// 普通的一句：当前行停在框高三分之一处（往下留出还没读到的那几句，往上留得下刚读过的一两句）。
// 但这条「以行的中点对齐」在**行比框高的三分之二还高**时会把行首推出框顶 —— 教材那种一大段
// 一行的课，在 iPhone 13 上（60vh ≈ 500px）一段就超过了，跟随播放时只看得见段尾，
// 正在念的开头反而在框外面。所以高行改成另一套：
//   - 换到这一行时，行首贴着框顶；
//   - 行内念到框外去了（当前词出了可视区），翻一页：当前词放到三分之一处。

/** 行首离框顶留的那一点空，免得行首正好压在边框上。 */
export const FOLLOW_MARGIN = 12;

export interface FollowInput {
  /** 框的可视高度（clientHeight） */
  boxHeight: number;
  /** 框现在滚到哪儿（scrollTop） */
  scrollTop: number;
  /** 当前行相对框内容顶部的位置与高度 */
  rowTop: number;
  rowHeight: number;
  /** 当前词（没有就是 null：只有句级时间戳、或者正落在两句之间） */
  word: { top: number; height: number } | null;
  /** 是不是刚换到这一行（或刚重新开始跟随）；false = 同一行里换了个词 */
  lineChanged: boolean;
}

/** 返回该滚到的 scrollTop；null = 不用动。 */
export function followScrollTarget(input: FollowInput): number | null {
  const { boxHeight, scrollTop, rowTop, rowHeight, word, lineChanged } = input;
  const fits = rowHeight <= (boxHeight * 2) / 3;
  if (fits) return lineChanged ? rowTop - boxHeight / 3 + rowHeight / 2 : null;

  const base = lineChanged ? rowTop - FOLLOW_MARGIN : scrollTop;
  if (word) {
    const visibleTop = base + FOLLOW_MARGIN;
    const visibleBottom = base + boxHeight - FOLLOW_MARGIN;
    if (word.top < visibleTop || word.top + word.height > visibleBottom) {
      // 不能翻过行首：跳进长段中间时，行首能看见就尽量让它看见
      return Math.max(rowTop - FOLLOW_MARGIN, word.top - boxHeight / 3);
    }
  }
  return lineChanged ? base : null;
}
