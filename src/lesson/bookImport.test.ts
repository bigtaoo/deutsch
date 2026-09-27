// FR-1.8：整份文稿按题目切段、音轨按顺序分给勾上的题。

import { describe, expect, it } from 'vitest';
import { assignByTrackNumber, assignTracks, parseBookSections, sectionTitle, sortByName, trackOfFile } from './bookImport';
import { unwrapPdfText } from './pdfText';

const BOOK = [
  'Inhalt', // 第一个标题之前的东西不属于任何一题
  'Kapitel 1 Alltägliches',
  'Modul 2 Aufgabe 2a',
  'Sie hören jetzt Aussagen von acht Personen.',
  'Person 1',
  'Ich bin 43 Jahre alt.',
  'Person 2',
  'Ich bin 24 Jahre alt.',
  'Modul 2 Aufgabe 2b',
  'Sie hören die Personen jetzt ein zweites Mal.',
  '(Text wie Track 1.2-1.9)',
  'Kapitel 2 Hast du Worte?',
  'Auftakt Aufgabe 2a',
  '● Haha, ja, der ist gut …',
  'Kapitel 10 Erinnerungen',
  'Modul 3 Aufgabe 1',
  '○ Erinnerst du dich?',
].join('\n');

describe('parseBookSections', () => {
  const sections = parseBookSections(BOOK);

  it('按题目标题切段，每段记着自己所在的章', () => {
    expect(sections.map((s) => [s.chapter, s.heading])).toEqual([
      ['Kapitel 1 Alltägliches', 'Modul 2 Aufgabe 2a'],
      ['Kapitel 1 Alltägliches', 'Modul 2 Aufgabe 2b'],
      ['Kapitel 2 Hast du Worte?', 'Auftakt Aufgabe 2a'],
      ['Kapitel 10 Erinnerungen', 'Modul 3 Aufgabe 1'],
    ]);
  });

  it('正文不含标题行；第一个标题之前的东西被丢掉', () => {
    expect(sections[0].body.startsWith('Sie hören jetzt')).toBe(true);
    expect(sections.some((s) => s.body.includes('Inhalt'))).toBe(false);
  });

  it('`(Text wie Track …)` 占位不进正文（它不念），照原文记下给人看', () => {
    expect(sections[1].body).toBe('Sie hören die Personen jetzt ein zweites Mal.');
    expect(sections[1].references).toEqual(['(Text wie Track 1.2-1.9)']);
  });

  it('`Person 1~N` 这种题默认用 N 轨，其余默认 1 轨', () => {
    expect(sections.map((s) => s.suggestedTracks)).toEqual([2, 1, 1, 1]);
  });

  it('没有任何标题时一段都切不出来（界面据此提示去用单课导入）', () => {
    expect(parseBookSections('Ein ganz normaler Text.\nOhne Überschrift.')).toEqual([]);
  });

  it('正文里以 `Kapitel 3 …` 开头的一句不会开出一个假章节', () => {
    const sections = parseBookSections(
      ['Kapitel 1 Alltägliches', 'Modul 2 Aufgabe 2a', 'Hallo.', 'Kapitel 3 zeigt, wie das geht.', 'Tschüss.'].join('\n'),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].chapter).toBe('Kapitel 1 Alltägliches');
    expect(sections[0].body).toBe('Hallo.\nKapitel 3 zeigt, wie das geht.\nTschüss.');
  });

  it('`Track 1.05` 形式的标题也认', () => {
    expect(parseBookSections('Track 1.05\nHallo.').map((s) => s.heading)).toEqual(['Track 1.05']);
  });
});

describe('sectionTitle', () => {
  it('章只留编号：章名在分组里已经够长了', () => {
    const [first] = parseBookSections(BOOK);
    expect(sectionTitle(first)).toBe('Kapitel 1 · Modul 2 Aufgabe 2a');
  });

  it('不在任何一章里的题就只有题目标题', () => {
    expect(sectionTitle(parseBookSections('Track 1.05\nHallo.')[0])).toBe('Track 1.05');
  });
});

describe('sortByName', () => {
  it('自然排序：2 在 10 前面', () => {
    const names = sortByName([{ name: 'Track 10.mp3' }, { name: 'Track 2.mp3' }, { name: 'Track 1.mp3' }]).map((f) => f.name);
    expect(names).toEqual(['Track 1.mp3', 'Track 2.mp3', 'Track 10.mp3']);
  });

  it('不改原数组', () => {
    const input = [{ name: 'b' }, { name: 'a' }];
    sortByName(input);
    expect(input.map((f) => f.name)).toEqual(['b', 'a']);
  });
});

describe('assignTracks', () => {
  it('按顺序依次分：第一题拿前 n₁ 个，第二题接着拿', () => {
    const { assigned, leftover } = assignTracks(
      [
        { id: 3, tracks: 2 },
        { id: 7, tracks: 1 },
      ],
      ['a', 'b', 'c', 'd'],
    );
    expect(assigned.get(3)).toEqual(['a', 'b']);
    expect(assigned.get(7)).toEqual(['c']);
    expect(leftover).toEqual(['d']);
  });

  it('文件不够时后面的题分不到（仍然可以先导入）', () => {
    const { assigned, leftover } = assignTracks(
      [
        { id: 1, tracks: 2 },
        { id: 2, tracks: 1 },
      ],
      ['a'],
    );
    expect(assigned.get(1)).toEqual(['a']);
    expect(assigned.get(2)).toEqual([]);
    expect(leftover).toEqual([]);
  });

  it('没选文件时每题都是空的', () => {
    expect(assignTracks([{ id: 1, tracks: 3 }], []).assigned.get(1)).toEqual([]);
  });
});

// FR-1.10：从 PDF 文件读进来的文稿带 `[[2.15]]` 行（pdfExtract.ts），每题知道自己是哪几轨。
const TRACKED = [
  'Kapitel 7 Arbeit und Beruf',
  'Modul 2 Aufgabe 3a',
  '[[2.17]]',
  '● Guten Tag, ich',
  'möchte fragen …',
  'Modul 4 Aufgabe 3',
  '[[2.20]]',
  '(Text wie Track 2.21-2.24)',
  '[[2.21]]',
  'Person 1',
  'Ich arbeite gern.',
  '[[2.22]]',
  'Person 2',
  'Ich nicht.',
].join('\n');

describe('音轨号（FR-1.10）', () => {
  const sections = parseBookSections(unwrapPdfText(TRACKED));

  it('轨号记到它所在的题上，不进正文；轨号在段落中间也不把话劈开', () => {
    expect(sections.map((s) => s.tracks)).toEqual([['2.17'], ['2.20', '2.21', '2.22']]);
    expect(sections[0].body).toBe('● Guten Tag, ich möchte fragen …');
    expect(sections[1].body).not.toContain('[[');
  });

  it('占位所在的那一轨是重放轨；默认轨数把它扣掉', () => {
    expect(sections[1].replayTracks).toEqual(['2.20']);
    expect(sections[1].suggestedTracks).toBe(2);
    expect(sections[0].replayTracks).toEqual([]);
  });

  it('粘贴的文字没有轨号：tracks 为空，照旧按 Person 数给默认值', () => {
    const pasted = parseBookSections(BOOK);
    expect(pasted.every((s) => s.tracks.length === 0 && s.replayTracks.length === 0)).toBe(true);
    expect(pasted[0].suggestedTracks).toBe(2);
  });
});

describe('trackOfFile', () => {
  it.each([
    ['605038_LB_CD2 (15).mp3', '2.15'],
    ['605037_LB_CD1 (2).mp3', '1.2'],
    ['CD03_Track05.mp3', '3.5'],
    ['1_02.mp3', '1.2'],
    ['Track 1.12.mp3', '1.12'],
    ['1-12 Modul 4.mp3', '1.12'],
  ])('%s → %s', (name, track) => {
    expect(trackOfFile(name)).toBe(track);
  });

  it.each(['605038_AB_38.mp3', 'Lied.mp3', 'Track 7.mp3'])('%s 认不出', (name) => {
    expect(trackOfFile(name)).toBeNull();
  });
});

describe('assignByTrackNumber', () => {
  const f = (name: string) => ({ name });

  it('每题按自己的轨号顺序拿文件，与文件选进来的顺序无关；练习册的剩下', () => {
    const files = [f('605038_LB_CD2 (22).mp3'), f('605038_AB_30.mp3'), f('605038_LB_CD2 (17).mp3'), f('605038_LB_CD2 (21).mp3')];
    const { assigned, missing, leftover } = assignByTrackNumber(
      [
        { id: 0, tracks: ['2.17'] },
        { id: 1, tracks: ['2.21', '2.22'] },
      ],
      files,
    );
    expect(assigned.get(0)!.map((x) => x.name)).toEqual(['605038_LB_CD2 (17).mp3']);
    expect(assigned.get(1)!.map((x) => x.name)).toEqual(['605038_LB_CD2 (21).mp3', '605038_LB_CD2 (22).mp3']);
    expect(missing.get(1)).toEqual([]);
    expect(leftover.map((x) => x.name)).toEqual(['605038_AB_30.mp3']);
  });

  it('找不到的轨号报出来，其余照配', () => {
    const { assigned, missing } = assignByTrackNumber([{ id: 5, tracks: ['3.1', '3.2'] }], [f('605038_LB_CD3 (1).mp3')]);
    expect(assigned.get(5)!.map((x) => x.name)).toEqual(['605038_LB_CD3 (1).mp3']);
    expect(missing.get(5)).toEqual(['3.2']);
  });

  it('同一轨号两个文件：用排序靠前的那个，另一个算剩下', () => {
    const { assigned, leftover } = assignByTrackNumber([{ id: 0, tracks: ['1.2'] }], [f('b/1_02.mp3'), f('a/1_02.mp3')]);
    expect(assigned.get(0)!.map((x) => x.name)).toEqual(['a/1_02.mp3']);
    expect(leftover.map((x) => x.name)).toEqual(['b/1_02.mp3']);
  });
});
