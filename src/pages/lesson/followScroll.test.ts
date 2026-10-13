import { describe, expect, it } from 'vitest';
import { FOLLOW_MARGIN, LIFT_THRESHOLD, followScrollTarget, pageLiftTarget } from './followScroll';

// iPhone 13：60vh ≈ 506px
const BOX = 506;

describe('followScrollTarget', () => {
  it('普通行：换行时当前行中点停在框高三分之一处', () => {
    const top = followScrollTarget({
      boxHeight: BOX,
      scrollTop: 0,
      rowTop: 1000,
      rowHeight: 60,
      word: { top: 1010, height: 24 },
      lineChanged: true,
    });
    expect(top).toBe(1000 - BOX / 3 + 30);
  });

  it('普通行：同一行里换词不滚', () => {
    expect(
      followScrollTarget({
        boxHeight: BOX,
        scrollTop: 900,
        rowTop: 1000,
        rowHeight: 60,
        word: { top: 1030, height: 24 },
        lineChanged: false,
      }),
    ).toBeNull();
  });

  it('高段落：换到这一行时行首贴顶，而不是按中点对齐把行首推出框外', () => {
    const rowTop = 1000;
    const top = followScrollTarget({
      boxHeight: BOX,
      scrollTop: 0,
      rowTop,
      rowHeight: 900,
      word: { top: rowTop + 4, height: 24 },
      lineChanged: true,
    })!;
    expect(top).toBe(rowTop - FOLLOW_MARGIN);
    // 旧算法的结果：行首落在框顶之上（看不见）
    const old = rowTop - BOX / 3 + 900 / 2;
    expect(old).toBeGreaterThan(rowTop);
    expect(top).toBeLessThanOrEqual(rowTop);
  });

  it('高段落：念到框底之外就翻一页，当前词放到三分之一处', () => {
    const scrollTop = 988;
    const wordTop = scrollTop + BOX - 10; // 已经压到框底
    expect(
      followScrollTarget({
        boxHeight: BOX,
        scrollTop,
        rowTop: 1000,
        rowHeight: 900,
        word: { top: wordTop, height: 24 },
        lineChanged: false,
      }),
    ).toBe(wordTop - BOX / 3);
  });

  it('高段落：当前词还在可视区内就不动', () => {
    expect(
      followScrollTarget({
        boxHeight: BOX,
        scrollTop: 988,
        rowTop: 1000,
        rowHeight: 900,
        word: { top: 1200, height: 24 },
        lineChanged: false,
      }),
    ).toBeNull();
  });

  it('高段落：从中间跳进来（点词/拖进度）时直接看到当前词，而不是行首', () => {
    const top = followScrollTarget({
      boxHeight: BOX,
      scrollTop: 0,
      rowTop: 1000,
      rowHeight: 900,
      word: { top: 1700, height: 24 },
      lineChanged: true,
    });
    expect(top).toBe(1700 - BOX / 3);
  });

  it('高段落但没有词级时间戳：行首贴顶，之后不再动', () => {
    const base = { boxHeight: BOX, rowTop: 1000, rowHeight: 900, word: null };
    expect(followScrollTarget({ ...base, scrollTop: 0, lineChanged: true })).toBe(1000 - FOLLOW_MARGIN);
    expect(followScrollTarget({ ...base, scrollTop: 988, lineChanged: false })).toBeNull();
  });
});

describe('pageLiftTarget', () => {
  it('框在半屏以下：整页往上推到框顶贴着导航下沿', () => {
    expect(pageLiftTarget({ boxTop: 420, topInset: 100, scrollY: 0 })).toBe(420 - 100 - FOLLOW_MARGIN);
  });

  it('已经滑过一些：在当前位置上接着推', () => {
    expect(pageLiftTarget({ boxTop: 300, topInset: 100, scrollY: 150 })).toBe(150 + 300 - 100 - FOLLOW_MARGIN);
  });

  it('差得不多就不动，免得页面抖一下', () => {
    expect(pageLiftTarget({ boxTop: 100 + FOLLOW_MARGIN + LIFT_THRESHOLD, topInset: 100, scrollY: 0 })).toBeNull();
  });

  it('框已经在上面（人滑到下面看笔记去了）：不往回拉', () => {
    expect(pageLiftTarget({ boxTop: -400, topInset: 100, scrollY: 900 })).toBeNull();
  });
});
