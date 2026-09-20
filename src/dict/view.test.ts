import { describe, it, expect } from 'vitest';
import { buildLookupResult } from './view';
import type { DictLookup } from './types';
import type { OnlineEntry } from './online';

// 这里测的是「两个来源、一个答案」那条合并规则（FR-9.5）。
// 解析本身在 online.test.ts / lookup.test.ts 里测过，所以这里的固件是手写的最小形状。

const local: DictLookup = {
  via: 'exact',
  entry: {
    w: 'Plattform',
    s: [
      {
        p: 'noun',
        g: 'f',
        pl: 'Plattformen',
        ipa: 'platˈfɔʁm',
        de: ['ebene, erhöhte Fläche'],
        zh: ['平台'],
        en: ['platform'],
      },
    ],
  },
};

const online: OnlineEntry = {
  w: 'Plattform',
  senses: [
    {
      heading: 'Substantiv, f',
      p: 'noun',
      g: 'f',
      pl: 'Plattformen',
      ipa: 'platˈfɔʁm',
      de: ['ebene, erhöhte Fläche', 'Betriebssystem als Grundlage'],
      ex: ['Der Zug hält an der Plattform.'],
      syn: ['Bühne', 'Podest'],
      ant: [],
      origin: 'von französisch plate-forme',
    },
  ],
};

describe('buildLookupResult', () => {
  it('两边都没有 → null（面板据此走「没查到」那一支）', () => {
    expect(buildLookupResult('xyzzy', null, null)).toBeNull();
  });

  it('只有内置词典：义项、中译、英译都在，from 只标内置', () => {
    const r = buildLookupResult('Plattform', local, null)!;
    expect(r.head).toBe('Plattform');
    expect(r.senses[0].zh).toEqual(['平台']);
    expect(r.senses[0].en).toEqual(['platform']);
    expect(r.from).toEqual({ builtin: true, online: false });
    expect(r.examples).toEqual([]);
  });

  it('只有在线：义项来自在线，例句/同义词/词源都在', () => {
    const r = buildLookupResult('Plattform', null, online)!;
    expect(r.senses[0].posLabel).toBe('Substantiv, f');
    expect(r.senses[0].de).toHaveLength(2);
    expect(r.examples).toEqual(['Der Zug hält an der Plattform.']);
    expect(r.synonyms).toEqual(['Bühne', 'Podest']);
    expect(r.origin).toMatch(/plate-forme/);
    expect(r.from).toEqual({ builtin: false, online: true });
  });

  it('两边都有：义项整份取内置（不混排），例句与词源从在线补', () => {
    const r = buildLookupResult('Plattform', local, online)!;
    // 内置那份只有一条释义，在线有两条 —— 取内置的，因为它带中译且字段整齐
    expect(r.senses).toHaveLength(1);
    expect(r.senses[0].de).toEqual(['ebene, erhöhte Fläche']);
    expect(r.senses[0].zh).toEqual(['平台']);
    // 记录级的东西才合并
    expect(r.examples).toEqual(['Der Zug hält an der Plattform.']);
    expect(r.origin).toMatch(/plate-forme/);
    expect(r.from).toEqual({ builtin: true, online: true });
  });

  it('IPA 与变形按**词性**补上去，不按位置猜', () => {
    const twoSenses: DictLookup = {
      via: 'exact',
      entry: {
        w: 'Laufen',
        s: [
          { p: 'noun', g: 'n', de: ['das Laufen'] }, // 没有 IPA、也没有变形
          { p: 'verb', de: ['sich schnell bewegen'] },
        ],
      },
    };
    const onlineTwo: OnlineEntry = {
      w: 'laufen',
      senses: [
        {
          heading: 'Verb',
          p: 'verb',
          ipa: 'ˈlaʊ̯fn̩',
          forms: 'Präteritum: lief, Partizip II: gelaufen',
          de: [],
          ex: [],
          syn: [],
          ant: [],
        },
      ],
    };
    const r = buildLookupResult('laufen', twoSenses, onlineTwo)!;
    // 动词义项拿到变形
    expect(r.senses[1].forms).toBe('Präteritum: lief, Partizip II: gelaufen');
    // 名词义项**不**拿动词的变形（按位置配的话它会落到第一条上）
    expect(r.senses[0].forms).toBeUndefined();
    // IPA 是例外：没有同词性的那一份时退到「页面上任意一个读音」——
    // 同一个词头的读音在各词性间通常相同，而这个应用最需要的就是这一行。
    expect(r.senses[0].ipa).toBe('ˈlaʊ̯fn̩');
  });

  it('同一句例句只留一条 —— 内置那份洗掉了引号，在线那份没洗', () => {
    const withEx: DictLookup = {
      via: 'exact',
      entry: { ...local.entry, ex: ['Wo ist die Zuversicht?'] },
    };
    const onlineQuoted: OnlineEntry = {
      w: 'Plattform',
      senses: [
        {
          heading: 'Substantiv, f',
          p: 'noun',
          de: [],
          ex: ['„Wo ist die Zuversicht?“', 'Der Zug hält an der Plattform.'],
          syn: [],
          ant: [],
        },
      ],
    };
    const r = buildLookupResult('Plattform', withEx, onlineQuoted)!;
    expect(r.examples).toEqual(['Wo ist die Zuversicht?', 'Der Zug hält an der Plattform.']);
  });

  it('经词形还原时报出词头，例句两边重复只留一条', () => {
    const viaForm: DictLookup = {
      via: 'form',
      queried: 'Plattformen',
      entry: { ...local.entry, ex: ['Der Zug hält an der Plattform.'] },
    };
    const r = buildLookupResult('Plattformen', viaForm, online)!;
    expect(r.viaForm).toBe(true);
    expect(r.query).toBe('Plattformen');
    expect(r.head).toBe('Plattform');
    expect(r.examples).toEqual(['Der Zug hält an der Plattform.']);
    // 链接指向词头，不是用户输入的那个词形
    expect(r.url).toContain('Plattform');
  });
});
