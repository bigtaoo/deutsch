// FR-1.10：PDF 排版 → 行。坐标仿 Aspekte neu C1 Transkript 实测：
// A4 宽 595，左栏正文 x≈57、右栏 x≈305，页边轨号 x≈35 / 549，轨号基线比正文第一行高 5~9pt；
// 正文 10pt、题目标题 12pt、章标题 15pt、轨号 7pt。

import { describe, expect, it, vi } from 'vitest';
import { layoutPage, type PdfItem } from './pdfExtract';

const W = 595;
const body = (str: string, y: number, x = 57): PdfItem => ({ str, x, y, width: str.length * 5, size: 10 });
const marker = (str: string, y: number, x = 35): PdfItem => ({ str, x, y, width: 10, size: 7 });

describe('layoutPage', () => {
  it('先左栏从上到下，再右栏从上到下', () => {
    const lines = layoutPage(
      [body('rechts oben', 700, 305), body('links unten', 600), body('links oben', 700), body('rechts unten', 600, 305)],
      W,
    );
    expect(lines).toEqual(['links oben', 'links unten', 'rechts oben', 'rechts unten']);
  });

  it('轨号插在它下面第一行正文前面，不管它在 item 列表里排在哪', () => {
    const lines = layoutPage(
      [marker('2.16', 607), body('eins', 700), body('zwei', 650), body('drei', 600), body('vier', 550)],
      W,
    );
    expect(lines).toEqual(['eins', 'zwei', '[[2.16]]', 'drei', 'vier']);
  });

  it('右页边的轨号归右栏；栏里它下面没有正文了就放到栏尾', () => {
    const lines = layoutPage(
      [body('links', 700), body('rechts', 700, 305), marker('2.20', 707, 549), marker('2.21', 100, 549)],
      W,
    );
    expect(lines).toEqual(['links', '[[2.20]]', 'rechts', '[[2.21]]']);
  });

  it('同一行拆成几个 item：按 x 拼回去，有空隙才补空格', () => {
    const lines = layoutPage(
      [
        { str: 'Hallo', x: 70, y: 700, width: 25, size: 10 },
        { str: '●', x: 57, y: 700.8, width: 6, size: 10 },
        { str: 'zusammen', x: 95.5, y: 700, width: 40, size: 10 },
        { str: 'Welt', x: 140, y: 700, width: 20, size: 10 },
      ],
      W,
    );
    expect(lines).toEqual(['● Hallozusammen Welt']);
  });

  it('折成两行的大字号标题并回一行；正文字号的两行不并', () => {
    const lines = layoutPage(
      [
        { str: 'Kapitel 9 Die schöne Welt', x: 57, y: 760, width: 180, size: 15 },
        { str: 'der Künste', x: 57, y: 742, width: 70, size: 15 },
        { str: 'Modul 1 Aufgabe 2', x: 57, y: 720, width: 100, size: 12 },
        body('Das ist der erste Satz und', 700),
        body('hier geht er weiter.', 688),
        body('Noch mehr Text, damit 10pt der Fließtext bleibt.', 676),
      ],
      W,
    );
    expect(lines).toEqual([
      'Kapitel 9 Die schöne Welt der Künste',
      'Modul 1 Aufgabe 2',
      'Das ist der erste Satz und',
      'hier geht er weiter.',
      'Noch mehr Text, damit 10pt der Fließtext bleibt.',
    ]);
  });

  it('正文里的小数（不在页边、混在一行里）不当轨号', () => {
    expect(layoutPage([body('Es kostet', 700), { str: '2.50', x: 110, y: 700, width: 20, size: 10 }], W)).toEqual([
      'Es kostet 2.50',
    ]);
  });
});

// extractPdfText 本身：pdf.js 换成假的，只验「pdf.js 的 item → PdfItem」这一层接得对不对。
// （pdf.js 真的能在构建产物里跑，由 e2e/book.spec.ts 那条手搓 PDF 的用例守。）
const pdfjsMock = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist', () => pdfjsMock);
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.test.mjs' }));

type FakeItem = { str: string; transform: number[]; width: number } | { type: string };
function fakeDoc(pages: FakeItem[][], opts: { failOnPage?: number } = {}) {
  const destroy = vi.fn(async () => {});
  const doc = {
    numPages: pages.length,
    destroy,
    getPage: vi.fn(async (p: number) => {
      if (p === opts.failOnPage) throw new Error('kaputt');
      return { view: [0, 0, 595, 842], getTextContent: async () => ({ items: pages[p - 1] }) };
    }),
  };
  pdfjsMock.getDocument.mockReturnValue({ promise: Promise.resolve(doc) });
  return { doc, destroy };
}
const t = (str: string, size: number, x: number, y: number): FakeItem => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5 });

describe('extractPdfText', () => {
  it('设好 worker 地址；字号取 transform 的纵向缩放；多页按页拼接', async () => {
    const { extractPdfText } = await import('./pdfExtract');
    fakeDoc([
      [t('Kapitel 1 Alltägliches', 15, 57, 780), t('1.2', 7, 35, 737), t('Hallo.', 10, 57, 730)],
      [t('Tschüss.', 10, 57, 780)],
    ]);
    const text = await extractPdfText(new Blob([new Uint8Array([1, 2, 3])]));
    expect(pdfjsMock.GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.test.mjs');
    expect(pdfjsMock.getDocument).toHaveBeenCalledWith({ data: new Uint8Array([1, 2, 3]) });
    expect(text).toBe('Kapitel 1 Alltägliches\n[[1.2]]\nHallo.\nTschüss.');
  });

  it('旋转过的 transform 也取得到字号：折行标题照样按字号并回', async () => {
    const { extractPdfText } = await import('./pdfExtract');
    // [a, b, c, d]：旋转 90° 时 d = 0，纵向缩放是 hypot(c, d)，只看 d 会当成 0 号字
    const skew = (str: string, y: number): FakeItem => ({ str, transform: [0, 15, -15, 0, 57, y], width: 100 });
    fakeDoc([[skew('Kapitel 9 Die schöne Welt', 780), skew('der Künste', 762), t('Ein langer Satz im Fließtext, der länger ist als der Titel.', 10, 57, 730)]]);
    expect(await extractPdfText(new Blob([]))).toBe('Kapitel 9 Die schöne Welt der Künste\nEin langer Satz im Fließtext, der länger ist als der Titel.');
  });

  it('跳过 marked-content 这类没有 str 的项', async () => {
    const { extractPdfText } = await import('./pdfExtract');
    fakeDoc([[{ type: 'beginMarkedContent' }, t('Hallo.', 10, 57, 700), { type: 'endMarkedContent' }]]);
    expect(await extractPdfText(new Blob([]))).toBe('Hallo.');
  });

  it('读到一半出错：错误抛给调用方，文档照样释放', async () => {
    const { extractPdfText } = await import('./pdfExtract');
    const { destroy } = fakeDoc([[t('a', 10, 57, 700)], [t('b', 10, 57, 700)]], { failOnPage: 2 });
    await expect(extractPdfText(new Blob([]))).rejects.toThrow('kaputt');
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('layoutPage · 轨号的几个边角', () => {
  it('右页边的轨号恰好和左栏某行同一高度：仍是轨号（「独占一行」只看同一栏）', () => {
    expect(layoutPage([body('links', 700), body('rechts', 693, 305), marker('2.20', 700, 549)], W)).toEqual([
      'links',
      '[[2.20]]',
      'rechts',
    ]);
  });

  it('两个轨号落在同一行前面：按从上到下的顺序排', () => {
    expect(layoutPage([marker('1.3', 705), marker('1.2', 708), body('kurz', 700)], W)).toEqual([
      '[[1.2]]',
      '[[1.3]]',
      'kurz',
    ]);
  });

  it('空白 item 不成行、不影响拼接', () => {
    expect(layoutPage([body('   ', 720), body('Hallo', 700), { str: ' ', x: 90, y: 700, width: 3, size: 10 }], W)).toEqual([
      'Hallo',
    ]);
  });
});
