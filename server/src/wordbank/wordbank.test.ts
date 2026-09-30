import { describe, expect, it } from 'vitest';
import { assignIds, buildWordbank, DEFAULT_WORDBANK_DIR, loadWordbankDir, parseWordbankTsv } from './wordbank.ts';

describe('parseWordbankTsv', () => {
  it('五列解析，`-` 当空', () => {
    const { items, skipped } = parseWordbankTsv('wohnen', 'Kaution\tnoun\tf\t押金\t-\n');
    expect(skipped).toBe(0);
    expect(items).toEqual([{ w: 'Kaution', p: 'noun', g: 'f', zh: '押金', t: 'wohnen' }]);
  });

  it('词形里写了 sich 的挪进备注 —— 词形要能直接查词典、取发音', () => {
    const { items } = parseWordbankTsv('wohnen', 'sich einleben\tverb\t-\t适应新环境\t-\nsich einigen\tverb\t-\t达成一致\t~ auf + A.\n');
    expect(items[0]).toMatchObject({ w: 'einleben', n: 'sich ~' });
    expect(items[1]).toMatchObject({ w: 'einigen', n: 'sich ~；~ auf + A.' });
  });

  it('坏行跳过并计数，不拖垮整份：列不够、词性不认识、没中文', () => {
    const { items, skipped } = parseWordbankTsv('x', 'a\tnoun\n b\tfoo\t-\t中\t-\nc\tverb\t-\t-\t-\nd\tadj\t-\t好的\t-\n');
    expect(items.map((i) => i.w)).toEqual(['d']);
    expect(skipped).toBe(3);
  });
});

describe('assignIds', () => {
  it('同形同词性只留第一条；同形不同词性第二个加 #词性', () => {
    const items = assignIds([
      { w: 'Laufen', p: 'noun', g: 'n', zh: '跑步', t: 'a' },
      { w: 'laufen', p: 'verb', zh: '跑', t: 'a' },
      { w: 'LAUFEN', p: 'verb', zh: '重复', t: 'b' },
    ]);
    expect(items.map((i) => i.id)).toEqual(['laufen', 'laufen#verb']);
  });
});

describe('buildWordbank', () => {
  it('版本号只随内容变 —— 文件读入的顺序不影响它', () => {
    const a = { topic: 'a', text: 'X\tnoun\tm\t甲\t-\n' };
    const b = { topic: 'b', text: 'Y\tnoun\tm\t乙\t-\n' };
    expect(buildWordbank([a, b]).version).toBe(buildWordbank([b, a]).version);
    expect(buildWordbank([a]).version).not.toBe(buildWordbank([a, b]).version);
  });
});

describe('仓库里那份真词库', () => {
  // 这条守的是「推上去的 TSV 真能读」：一行笔误不会拖垮整份，但一个文件整个
  // 格式错了（比如被存成了逗号分隔）会让词库静默少掉一个主题。
  it('读得出来、超过 5000 个词、没有坏行、每个主题都在', () => {
    const wb = loadWordbankDir(DEFAULT_WORDBANK_DIR);
    expect(wb.skipped).toBe(0);
    expect(wb.count).toBeGreaterThan(5000);
    const items = (JSON.parse(wb.json) as { items: { t: string; id: string }[] }).items;
    const topics = new Set(items.map((i) => i.t));
    for (const t of ['wohnen', 'gesundheit', 'konsum', 'unterwegs', 'miteinander', 'beruf', 'projekt', 'wirtschaft', 'entwicklung', 'infrastruktur', 'gesellschaft', 'ausdruck', 'kommunikation', 'daten']) {
      expect(topics.has(t)).toBe(true);
    }
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
});
