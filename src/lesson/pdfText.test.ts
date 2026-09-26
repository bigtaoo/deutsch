// FR-1.6：PDF 断行整理。样本的形状（不是内容）照 Aspekte neu C1 Lehrbuch Transkript 的真实版式。

import { describe, expect, it } from 'vitest';
import { isChapterHeading, isHeading, unwrapPdfText } from './pdfText';
import { segmentSentences } from './segment';

describe('unwrapPdfText', () => {
  it('把一段话被折开的几行合回一行', () => {
    expect(unwrapPdfText('Ich bin 43 Jahre alt, arbeite als \nIndustriekauffrau und sammle Pilze.')).toBe(
      'Ich bin 43 Jahre alt, arbeite als Industriekauffrau und sammle Pilze.',
    );
  });

  it('行尾连字符 + 小写开头 = 排版折断的一个词，连字符去掉', () => {
    expect(unwrapPdfText('das Gemeinschafts-\nleben im Dorf.')).toBe('das Gemeinschaftsleben im Dorf.');
  });

  it('行尾连字符 + 大写开头 = 本来就带连字符的复合词，连字符留着、不加空格', () => {
    expect(unwrapPdfText('kein Speisepilz-\nVerein!')).toBe('kein Speisepilz-Verein!');
  });

  it('省略式并列（`Ein- und Ausgang`）里的连字符留着，后面补空格', () => {
    expect(unwrapPdfText('am Ein-\nund Ausgang.')).toBe('am Ein- und Ausgang.');
  });

  it('页码、页眉、页边音轨号整行丢掉，被它们隔开的正文照样接上', () => {
    const raw = 'Die meisten wohnen\n1.10\n1.11\n\n3\nTranskript zum Lehrbuch\nin einer WG.';
    // 空行是段落边界，所以这里会断成两段 —— 保守的那一边
    expect(unwrapPdfText(raw)).toBe('Die meisten wohnen\nin einer WG.');
    expect(unwrapPdfText('Die meisten wohnen\n1.10\nTranskript zum Lehrbuch\nin einer WG.')).toBe(
      'Die meisten wohnen in einer WG.',
    );
  });

  it('说话人符号开一段新话；前面的空格去掉', () => {
    expect(unwrapPdfText(' ●  Gibt’s so was wie\ngoldene Regeln?\n ○  Ja, kann man sagen.')).toBe(
      '● Gibt’s so was wie goldene Regeln?\n○ Ja, kann man sagen.',
    );
  });

  it('标题自成一行，前后都不并', () => {
    expect(unwrapPdfText('Kapitel 1 Alltägliches\nModul 2 Aufgabe 2a\nSie hören jetzt\nAussagen.')).toBe(
      'Kapitel 1 Alltägliches\nModul 2 Aufgabe 2a\nSie hören jetzt Aussagen.',
    );
  });

  it('`Person 1` 这种小标题和括号占位也自成一行', () => {
    expect(unwrapPdfText('Person 1\nIch bin 43.\n(Text wie Track 1.2-1.9)\nModul 4 Aufgabe 2a')).toBe(
      'Person 1\nIch bin 43.\n(Text wie Track 1.2-1.9)\nModul 4 Aufgabe 2a',
    );
  });

  it('折行后行首碰巧是 `Wort:` 的，不当成新说话人 —— 上一行没说完', () => {
    expect(unwrapPdfText('Aber wir arbeiten sehr wissen-\nschaftlich: Die Pilze werden gesammelt.')).toBe(
      'Aber wir arbeiten sehr wissenschaftlich: Die Pilze werden gesammelt.',
    );
    expect(unwrapPdfText('Das ist die\nWirtschaft: groß.')).toBe('Das ist die Wirtschaft: groß.');
  });

  it('上一句说完了，`Name:` 才开新的一段', () => {
    expect(unwrapPdfText('Willkommen.\nModeratorin: Danke.')).toBe('Willkommen.\nModeratorin: Danke.');
  });

  it('Windows 换行与软连字符', () => {
    expect(unwrapPdfText('Gemein\u00adschaft ist\r\nschön.')).toBe('Gemeinschaft ist schön.');
  });

  it('整理之后切句不再一行一「句」', () => {
    const raw = ' ●  Hallo, seid wieder einmal herzlich \nwillkommen bei uns. Heute geht es\num WGs.';
    expect(segmentSentences(raw)).toHaveLength(4); // 不整理：换行是硬边界，三行切出四个半句
    expect(segmentSentences(unwrapPdfText(raw), { speakers: ['●'] }).map((s) => s.text)).toEqual([
      'Hallo, seid wieder einmal herzlich willkommen bei uns.',
      'Heute geht es um WGs.',
    ]);
  });
});

describe('isHeading / isChapterHeading —— 正文里碰巧以这些词开头的行不是标题', () => {
  it.each([
    'Kapitel 1 Alltägliches',
    'Kapitel 2 Hast du Worte?',
    'Kapitel 7 Recht so!',
    'Kapitel 10 Erinnerungen',
    'Modul 4 Aufgabe 2c',
    'Auftakt Aufgabe 1',
    'Porträt Aufgabe 3',
    'Track 1.05',
    'Hörtext 3',
  ])('标题：%s', (line) => {
    expect(isHeading(line)).toBe(true);
  });

  it.each([
    'Kapitel 3 zeigt, wie das geht.',
    'Kapitel 3 zeigt, wie das',
    'Text 2 ist kürzer als Text 1.',
    'Track 5 hat mir am besten gefallen.',
    'Modul 2 fand ich schwer, vor allem Aufgabe 3',
    'Modul 2 Aufgabe 3 war schwer.',
  ])('正文：%s', (line) => {
    expect(isHeading(line)).toBe(false);
  });

  it('章标题只认 Kapitel 那一种', () => {
    expect(isChapterHeading('Kapitel 1 Alltägliches')).toBe(true);
    expect(isChapterHeading('Modul 4 Aufgabe 2c')).toBe(false);
  });

  it('像标题、但下一行小写开头 = 其实是一句话折了行，照常并进去', () => {
    expect(unwrapPdfText('Das steht im Buch.\nKapitel 3 zeigt uns\nheute etwas.')).toBe(
      // 并进上一段正文里（它就是那段正文的一部分），切句照样按句号分开
      'Das steht im Buch. Kapitel 3 zeigt uns heute etwas.',
    );
  });
});
