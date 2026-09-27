// FR-1.10：PDF 排版 → 行。坐标仿 Aspekte neu C1 Transkript 实测：
// A4 宽 595，左栏正文 x≈57、右栏 x≈305，页边轨号 x≈35 / 549，轨号基线比正文第一行高 5~9pt；
// 正文 10pt、题目标题 12pt、章标题 15pt、轨号 7pt。

import { describe, expect, it } from 'vitest';
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
