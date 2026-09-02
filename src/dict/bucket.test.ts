import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DICT_BUCKETS, bucketHex, bucketOf, normalizeKey } from './bucket';

// 这个文件的全部目的：**让「构建脚本与运行时的分桶函数不一致」变成一次红灯，
// 而不是「某些词莫名查不到」。** 那种症状极难查 —— 词典看着是好的，
// 只有落在改动过的那些桶里的词消失了。

describe('normalizeKey', () => {
  it('大小写归一 —— 名词 Laufen 与动词 laufen 落同一个键', () => {
    expect(normalizeKey('Laufen')).toBe('laufen');
    expect(normalizeKey('LAUFEN')).toBe('laufen');
  });

  it('NFC 归一 —— 分解写法的 ä 与单码位的 ä 视为同一个词', () => {
    // DW 的文稿里两种写法都出现过。不归一的话 `Mädchen` 有一半时候查不到。
    const composed = 'Mädchen'; // U+00E4
    const decomposed = 'Mädchen'; // a + U+0308
    expect(composed).not.toBe(decomposed);
    expect(normalizeKey(composed)).toBe(normalizeKey(decomposed));
    expect(bucketOf(composed)).toBe(bucketOf(decomposed));
  });

  it('ß 不被折成 ss —— Straße 和 Strasse 是两个键', () => {
    // 听写那边「去变音符写法」算转写等价（§7.4），但查词不能这么放宽：
    // 词典里的键就是 `straße`，折成 `strasse` 会一个也查不到。
    expect(normalizeKey('Straße')).toBe('straße');
    expect(normalizeKey('Straße')).not.toBe('strasse');
  });
});

describe('bucketOf', () => {
  // ⚠️ 这些数字是**契约**，不是实现细节。
  // 它们必须与 scripts/build-dict.mjs 里的 bucketOf 产出一致。
  // 任何一个变了，就意味着 public/dict/ 里已有的产物全部失效，必须重跑 build:dict。
  const PINNED: Array<[string, number]> = [
    ['Zuversicht', 2],
    ['zuversicht', 2],
    ['laufen', 122],
    ['Laufen', 122],
    ['gelaufen', 54],
    ['Mädchen', 36],
    ['Wald', 173],
    ['abwägen', 57],
    ['Plattformen', 117],
    ['straße', 67],
    ['Straße', 67],
    ['ß', 238],
    ['', 197],
    ['a', 44],
  ];

  it.each(PINNED)('%s → 第 %i 号桶', (word, expected) => {
    expect(bucketOf(word)).toBe(expected);
  });

  it('桶号始终落在 [0, BUCKETS)', () => {
    for (const [word] of PINNED) {
      expect(bucketOf(word)).toBeGreaterThanOrEqual(0);
      expect(bucketOf(word)).toBeLessThan(DICT_BUCKETS);
    }
  });

  it('bucketHex 是两位小写十六进制 —— 就是磁盘上的文件名', () => {
    expect(bucketHex('Zuversicht')).toBe('02');
    expect(bucketHex('Wald')).toBe('ad');
    expect(bucketHex('ß')).toBe('ee');
  });
});

// jsdom 环境下 import.meta.url 是 http: 的，new URL(...) 拿不到文件路径。
// vitest 的 cwd 就是项目根，直接用相对路径。
const SCRIPT = 'scripts/build-dict.mjs';

describe('与构建脚本的一致性', () => {
  it('scripts/build-dict.mjs 里的 bucketOf 与这里逐字相同', () => {
    // 直接把脚本读出来比源码，比「两边都跑一遍看结果」更早报警：
    // 结果比对只在被测词恰好落进改动过的桶时才会红。
    const script = readFileSync(SCRIPT, 'utf8');
    const body = /function bucketOf\(key\) \{([\s\S]*?)\n\}/.exec(script)?.[1];
    expect(body, 'build-dict.mjs 里找不到 bucketOf —— 改名了就把这个测试一起改').toBeTruthy();
    const normalized = (body ?? '').replace(/\s+/g, ' ').trim();
    expect(normalized).toBe(
      "let h = 0x811c9dc5; const norm = normalizeKey(key); for (let i = 0; i < norm.length; i++) { h ^= norm.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h % BUCKETS;",
    );
  });

  it('BUCKETS 两边相同', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const n = /const BUCKETS = (\d+);/.exec(script)?.[1];
    expect(Number(n)).toBe(DICT_BUCKETS);
  });
});
