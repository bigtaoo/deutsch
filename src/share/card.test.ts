import { describe, expect, it } from 'vitest';
import { CARD_HEIGHT, CARD_WIDTH, fitLines, renderShareCard, wrapLines, type ShareCardData } from './card';
import { beforeEach, vi } from 'vitest';
import { quoteForDate } from './quotes';

/** 等宽假字体：德语字符 1 格，中日韩字符 2 格 —— 够测折行逻辑本身。 */
const measure = (width: number) => (text: string) =>
  [...text].reduce((sum, ch) => sum + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0) * width;

describe('wrapLines', () => {
  it('德语按空格断，不在词中间断开', () => {
    const lines = wrapLines(measure(1), 'Wer immer strebend sich bemüht', 14);
    expect(lines).toEqual(['Wer immer', 'strebend sich', 'bemüht']);
  });

  it('中文按字断 —— 整句没有空格，按空格断会溢出', () => {
    const lines = wrapLines(measure(1), '不懂外语的人对自己的母语也一无所知', 10);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('不懂外语的人对自己的母语也一无所知');
    for (const line of lines) expect(measure(1)(line)).toBeLessThanOrEqual(10);
  });

  it('中德混排在切换处也能断', () => {
    const lines = wrapLines(measure(1), 'Goethe 说：熟能生巧', 8);
    expect(lines.join('')).toContain('Goethe');
    for (const line of lines) expect(measure(1)(line)).toBeLessThanOrEqual(8);
  });

  it('装得下就只有一行', () => {
    expect(wrapLines(measure(1), 'Aller Anfang ist schwer.', 100)).toEqual([
      'Aller Anfang ist schwer.',
    ]);
  });

  it('空串给一行空的，不是空数组 —— 调用方总能安全地取 [0]', () => {
    expect(wrapLines(measure(1), '', 100)).toEqual(['']);
  });

  it('一个词就比整行还长时不吞字', () => {
    const lines = wrapLines(measure(1), 'Donaudampfschifffahrt ist', 10);
    expect(lines.join(' ')).toBe('Donaudampfschifffahrt ist');
  });
});

describe('fitLines', () => {
  const sizes = [10, 6, 4];
  const measureAt = (size: number) => measure(size);

  it('大字号放得下就用大字号', () => {
    const { fontSize, lines } = fitLines(measureAt, 'Aller Anfang', 200, sizes, 2);
    expect(fontSize).toBe(10);
    expect(lines).toHaveLength(1);
  });

  it('放不下就往下降一号，直到行数够', () => {
    const { fontSize, lines } = fitLines(
      measureAt,
      'Wer fremde Sprachen nicht kennt weiß nichts von seiner eigenen',
      200,
      sizes,
      2,
    );
    expect(fontSize).toBeLessThan(10);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('最小号仍然超行时宁可超行也不截断', () => {
    const { fontSize, lines } = fitLines(measureAt, 'a b c d e f g h i j k', 8, sizes, 1);
    expect(fontSize).toBe(4);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('a b c d e f g h i j k');
  });
});

// ── renderShareCard：名字、日期、数字真的画上去了吗（FR-18.4）────────────
//
// 写这一组的直接理由：用户报过「加一个输入名字的位置，然后在分享的图片上写上名字」，
// 而那个功能**本来就有** —— 也就是说，它坏掉的话没有任何人会发现，直到又有人
// 以为它没做。canvas 在 jsdom 里不存在，所以这里给一个只记账的假 2D 上下文：
// 断言的是「哪些字以什么坐标被画了出来」，而不是像素。

interface DrawnText {
  text: string;
  x: number;
  y: number;
  align: CanvasTextAlign;
}

function fakeCanvas(): { canvas: HTMLCanvasElement; drawn: DrawnText[] } {
  const drawn: DrawnText[] = [];
  const ctx = {
    font: '',
    fillStyle: '' as string | CanvasGradient,
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    save() {},
    restore() {},
    fillRect() {},
    drawImage() {},
    measureText: (text: string) => ({ width: text.length * 10 }) as TextMetrics,
    createLinearGradient: () => ({ addColorStop() {} }) as unknown as CanvasGradient,
    fillText(text: string, x: number, y: number) {
      drawn.push({ text, x, y, align: this.textAlign });
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx as unknown as CanvasRenderingContext2D,
  } as unknown as HTMLCanvasElement;
  return { canvas, drawn };
}

function data(extra: Partial<ShareCardData> = {}): ShareCardData {
  return {
    quote: quoteForDate('2026-09-22'),
    photoId: 'heide',
    name: '',
    dateText: '2026 年 9 月 22 日',
    todayText: '23 分钟',
    streakDays: 7,
    totalDays: 40,
    ...extra,
  };
}

beforeEach(() => {
  // 底图在 jsdom 里加载不出来，而 loadPhoto 只在 onload/onerror 上 resolve ——
  // 不打桩的话这个 Promise 永远不 settle，测试直接挂住。走 onerror 那条路
  // （底图退化成渐变）恰好也是要保的行为：**图没加载出来不该让分享这件事失败**。
  vi.stubGlobal(
    'Image',
    class {
      onerror: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => this.onerror?.(), 0);
      }
    },
  );
});

describe('renderShareCard', () => {
  it('设了名字就画在图上 —— 这一条坏掉没人会发现，直到又有人以为它没做', async () => {
    const { canvas, drawn } = fakeCanvas();
    await renderShareCard(canvas, data({ name: '王涛' }));
    expect(drawn.map((d) => d.text)).toContain('王涛');
  });

  it('名字留空就一个字都不印 —— 「特意留空」是一个合理的选择', async () => {
    const { canvas, drawn } = fakeCanvas();
    await renderShareCard(canvas, data({ name: '' }));
    expect(drawn.some((d) => d.text === '')).toBe(false);
    expect(drawn.map((d) => d.text)).toContain('2026 年 9 月 22 日');
  });

  it('有名字时日期靠右，没名字时日期换到左边', async () => {
    const withName = fakeCanvas();
    await renderShareCard(withName.canvas, data({ name: '王涛' }));
    const dateRight = withName.drawn.find((d) => d.text.includes('2026 年'))!;
    const nameLeft = withName.drawn.find((d) => d.text === '王涛')!;

    const without = fakeCanvas();
    await renderShareCard(without.canvas, data({ name: '' }));
    const dateAlone = without.drawn.find((d) => d.text.includes('2026 年'))!;

    // 否则那一行是左边一片空、右边贴边一行小字，看起来像排版出了错。
    expect(dateRight.align).toBe('right');
    expect(dateAlone.align).toBe('left');
    expect(dateAlone.x).toBe(nameLeft.x);
  });

  it('名字和日期在同一条基线上', async () => {
    const { canvas, drawn } = fakeCanvas();
    await renderShareCard(canvas, data({ name: '王涛' }));
    const name = drawn.find((d) => d.text === '王涛')!;
    const date = drawn.find((d) => d.text.includes('2026 年'))!;
    expect(name.y).toBe(date.y);
  });

  it('底部三个数字纹丝不动：句子长短不影响它们的位置', async () => {
    const short = fakeCanvas();
    await renderShareCard(short.canvas, data({ quote: { de: 'Kurz.', zh: '短。', author: null } }));
    const long = fakeCanvas();
    await renderShareCard(
      long.canvas,
      data({
        quote: {
          de: 'Wer fremde Sprachen nicht kennt, weiß nichts von seiner eigenen und noch viel weniger.',
          zh: '不懂外语的人对自己的母语也一无所知，而且知道得更少。',
          author: 'Goethe',
        },
      }),
    );
    const y = (list: DrawnText[], text: string) => list.find((d) => d.text === text)!.y;
    // 引文块从细线往上长（§12.8），所以句子变长是往上占照片，底部不动。
    for (const text of ['今天', '连续', '累计', '23 分钟', '7 天', '40 天']) {
      expect(y(short.drawn, text)).toBe(y(long.drawn, text));
    }
  });

  it('应用名画在左上角，且就是现在这个名字', async () => {
    const { canvas, drawn } = fakeCanvas();
    await renderShareCard(canvas, data());
    const app = drawn.find((d) => d.text === '努力学德语');
    expect(app).toBeDefined();
    expect(app!.y).toBeLessThan(CARD_HEIGHT / 2);
  });

  it('canvas 的像素尺寸由渲染函数自己定 —— 调用方给什么都不算数', async () => {
    const { canvas } = fakeCanvas();
    await renderShareCard(canvas, data());
    expect(canvas.width).toBe(CARD_WIDTH);
    expect(canvas.height).toBe(CARD_HEIGHT);
  });
});
