// FR-1.7：说话人标记。样本形状取自 Aspekte neu C1 的真实文稿（行首 ● ○ △，前面常带一个空格）。

import { describe, expect, it } from 'vitest';
import { detectSpeakers, isSpeakerSymbol, matchSpeaker } from './speakers';
import { segmentSentences } from './segment';

describe('detectSpeakers', () => {
  it('符号按出现次数排，默认勾上', () => {
    const found = detectSpeakers(' ●  Hallo.\n ○  Ja.\n ●  Gut.\n △  Top 1');
    expect(found.map((c) => [c.label, c.count, c.suggested])).toEqual([
      ['●', 2, true],
      ['○', 1, true],
      ['△', 1, true],
    ]);
  });

  it('名字出现两次以上才默认勾上 —— 出现一次的多半是正文里的冒号', () => {
    const found = detectSpeakers('Moderatorin: Willkommen.\nHerr Weber: Danke.\nModeratorin: Bitte.\nDas Problem: niemand weiß es.');
    const byLabel = Object.fromEntries(found.map((c) => [c.label, c]));
    expect(byLabel['Moderatorin']).toMatchObject({ count: 2, suggested: true, kind: 'name' });
    expect(byLabel['Herr Weber']).toMatchObject({ count: 1, suggested: false });
    expect(byLabel['Das Problem']).toMatchObject({ count: 1, suggested: false });
  });

  it('不收带数字的「名字」：`1.000 Mitarbeitern:` 是折行碎片', () => {
    expect(detectSpeakers('1.000 Mitarbeitern: so viele.')).toEqual([]);
  });

  it('冒号后面没有东西的不算（那是标题或列表引子）', () => {
    expect(detectSpeakers('Zum Beispiel:')).toEqual([]);
  });
});

describe('matchSpeaker', () => {
  it('没给清单就永远不认 —— DW 与所有老课程的切句一个字都不变', () => {
    expect(matchSpeaker('● Hallo.', undefined)).toBeNull();
    expect(matchSpeaker('● Hallo.', [])).toBeNull();
  });

  it('只认清单里的：没勾的 `Das Problem:` 原样留在正文里', () => {
    expect(matchSpeaker('Das Problem: niemand.', ['Moderatorin'])).toBeNull();
    expect(matchSpeaker('Moderatorin: Hallo.', ['Moderatorin'])).toEqual({ speaker: 'Moderatorin', skip: 13 });
  });

  it('skip 包括标记前后的空白', () => {
    expect(matchSpeaker(' ●  Hallo.', ['●'])).toEqual({ speaker: '●', skip: 4 });
  });

  it('isSpeakerSymbol 只认单个符号', () => {
    expect(isSpeakerSymbol('●')).toBe(true);
    expect(isSpeakerSymbol('A')).toBe(false);
    expect(isSpeakerSymbol('●●')).toBe(false);
  });
});

describe('segmentSentences 带说话人清单', () => {
  const text = ' ●  Hallo, seid willkommen. Heute geht es um WGs.\n ○  Ja, genau.\nModeratorin: Und?';

  it('标记从正文里拿掉，只挂在这段话的第一句上', () => {
    const segs = segmentSentences(text, { speakers: ['●', '○', 'Moderatorin'] });
    expect(segs.map((s) => [s.speaker, s.text])).toEqual([
      ['●', 'Hallo, seid willkommen.'],
      [undefined, 'Heute geht es um WGs.'],
      ['○', 'Ja, genau.'],
      ['Moderatorin', 'Und?'],
    ]);
  });

  it('offset 仍然是 plainText 里的绝对位置（FR-2.4 的重切匹配靠它）', () => {
    for (const s of segmentSentences(text, { speakers: ['●', '○', 'Moderatorin'] })) {
      expect(text.slice(s.charStart, s.charEnd)).toBe(s.text);
    }
  });

  it('不给清单时结果与以前完全一样', () => {
    const plain = segmentSentences(text);
    expect(plain[0].text.startsWith('●')).toBe(true);
    expect(plain.every((s) => s.speaker === undefined)).toBe(true);
  });

  it('只有标记、没有话的一行不产出句子', () => {
    expect(segmentSentences('●\nHallo.', { speakers: ['●'] }).map((s) => s.text)).toEqual(['Hallo.']);
  });
});
