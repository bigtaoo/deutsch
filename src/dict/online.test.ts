import { describe, it, expect } from 'vitest';
import { parseExtract, parseOnlineEntry } from './online';

// 固件是 de.wiktionary 的**真实** extract（2026-09-02 取，`prop=extracts&explaintext=1`）。
// 只保留到影响解析的那几节；例句和译文那一大坨对解析没有作用，删掉免得固件比测试还长。
//
// 自造固件在这里没有意义：这个解析器全部的难点就在真实页面的不规则处 ——
// `Plural 1:` / `Plural 2:` 两个并列复数、IPA 一行两个读音、
// `Anmerkung zum Genus:` 这种带空格又带小写的标签、以及 `Reime:` 那种
// 「看着像标签但不以冒号结尾」的行。

const ZUVERSICHT = `
== Zuversicht (Deutsch) ==


=== Substantiv, f ===

Worttrennung:
Zu·ver·sicht, Plural: Zu·ver·sich·ten
Aussprache:
IPA: [ˈt͡suːfɛɐ̯ˌzɪçt]
Hörbeispiele:  Zuversicht (Info)
Bedeutungen:
[1] der feste Glaube daran, dass etwas Positives geschehen wird
Herkunft:
mittelhochdeutsch zuoversiht, althochdeutsch zuofirsiht „ehrfurchtsvolles Aufschauen, Hoffen“
Sinnverwandte Wörter:
[1] Optimismus
Beispiele:
[1] Wir gehen mit großer Zuversicht in die Prüfungen.
`;

const MAEDCHEN = `
== Mädchen (Deutsch) ==


=== Substantiv, n ===

Anmerkung zum Genus:
Das grammatische Geschlecht von Mädchen ist sächlich, da es ein Diminutiv ist.
Anmerkung zum Plural:
Der s-Plural ist veraltet oder umgangssprachlich.
Worttrennung:
Mäd·chen, Plural 1: Mäd·chen, Plural 2: Mäd·chens
Aussprache:
IPA: [ˈmɛːtçən], [ˈmeːtçən]
Hörbeispiele:  Mädchen (Info),  Mädchen (Info)
Reime: -ɛːtçən
Bedeutungen:
[1] kleines Mädchen: weibliches Kind
[2] junges Mädchen: junge Frau
[3] veraltete Bedeutung: weibliche Hausangestellte
[4] befreundete weibliche Person
Herkunft:
Diminutiv von Magd: die Magd → das Mägdchen → das Mädchen
`;

const ABWAEGEN = `
== abwägen (Deutsch) ==


=== Verb ===

Worttrennung:
ab·wä·gen, Präteritum: wog ab/wäg·te ab, Partizip II: ab·ge·wo·gen, ab·ge·wägt
Aussprache:
IPA: [ˈapˌvɛːɡn̩]
Bedeutungen:
[1] vergleichend prüfen
[2] veraltet: abwiegen
Herkunft:
gebildet aus der Partikel ab als Verbzusatz und dem Verb wägen
`;

/** 同一个页面上有别的语言的同形词 —— 只能取 (Deutsch) 那一节。 */
const MULTILINGUAL = `
== Bank (Deutsch) ==

=== Substantiv, f ===

Worttrennung:
Bank, Plural: Bän·ke
Bedeutungen:
[1] Sitzgelegenheit für mehrere Personen

== Bank (Englisch) ==

=== Substantiv ===

Bedeutungen:
[1] das Ufer
`;

describe('parseExtract', () => {
  it('名词：性、复数、IPA、德语释义都拿到', () => {
    const e = parseExtract('Zuversicht', ZUVERSICHT);
    expect(e).not.toBeNull();
    expect(e!.s).toHaveLength(1);
    const s = e!.s[0];
    expect(s.p).toBe('noun');
    expect(s.g).toBe('f');
    expect(s.pl).toBe('Zuversichten'); // 音节分隔点要去掉
    expect(s.ipa).toBe('ˈt͡suːfɛɐ̯ˌzɪçt');
    expect(s.de).toEqual(['der feste Glaube daran, dass etwas Positives geschehen wird']);
  });

  it('不把 Herkunft / Beispiele / Sinnverwandte 收成释义', () => {
    const e = parseExtract('Zuversicht', ZUVERSICHT);
    const joined = (e!.s[0].de ?? []).join(' ');
    expect(joined).not.toMatch(/mittelhochdeutsch/);
    expect(joined).not.toMatch(/Prüfungen/);
    expect(joined).not.toMatch(/Optimismus/);
  });

  it('两个并列复数取 Plural 1 —— Mädchen 而不是口语的 Mädchens', () => {
    const e = parseExtract('Mädchen', MAEDCHEN);
    expect(e!.s[0].g).toBe('n');
    expect(e!.s[0].pl).toBe('Mädchen');
  });

  it('一行两个 IPA 只取第一个；Reime: 那种不以冒号结尾的行不当标签', () => {
    const e = parseExtract('Mädchen', MAEDCHEN);
    expect(e!.s[0].ipa).toBe('ˈmɛːtçən');
    expect((e!.s[0].de ?? []).join(' ')).not.toMatch(/ɛːtçən/);
  });

  it('释义最多留 3 条 —— Mädchen 有 4 条', () => {
    expect(parseExtract('Mädchen', MAEDCHEN)!.s[0].de).toHaveLength(3);
  });

  it('带空格带小写的标签（Anmerkung zum Genus）不会污染释义', () => {
    const de = (parseExtract('Mädchen', MAEDCHEN)!.s[0].de ?? []).join(' ');
    expect(de).not.toMatch(/sächlich/);
    expect(de).not.toMatch(/s-Plural/);
  });

  it('动词：不给复数（Worttrennung 里那行有 Präteritum 和 Partizip II，没有 Plural）', () => {
    const e = parseExtract('abwägen', ABWAEGEN);
    expect(e!.s[0].p).toBe('verb');
    expect(e!.s[0].pl).toBeUndefined();
    expect(e!.s[0].g).toBeUndefined();
    expect(e!.s[0].de).toEqual(['vergleichend prüfen', 'veraltet: abwiegen']);
  });

  it('只取 (Deutsch) 那一节，不混进英语同形词', () => {
    const e = parseExtract('Bank', MULTILINGUAL);
    expect(e!.s).toHaveLength(1);
    expect(e!.s[0].pl).toBe('Bänke');
    expect((e!.s[0].de ?? []).join(' ')).not.toMatch(/Ufer/);
  });

  it('没有德语小节时返回 null，不抛', () => {
    expect(parseExtract('Foo', '== Foo (Englisch) ==\n\n=== Noun ===\n\nBedeutungen:\n[1] a foo')).toBeNull();
    expect(parseExtract('Foo', '')).toBeNull();
  });
});

/**
 * 真实 extract（2026-09-20 取）。为 FR-9.5 的查词面板留的固件：它带着
 * Komparativ/Superlativ、逗号列表式的 Sinnverwandte/Gegenwörter、
 * 十几条例句（其中几条是带引号的文学引文），以及 Unterbegriffe / Redewendungen
 * ——后两段是「看着像内容但不该进任何字段」的东西。
 * Herkunft 那一大段截短了（原文有五行词源考据），例句留了前六条。
 */
const SCHNELL = `
== schnell (Deutsch) ==


=== Adjektiv ===

Worttrennung:
schnell, Komparativ: schnel·ler, Superlativ: am schnells·ten
Aussprache:
IPA: [ʃnɛl]
Hörbeispiele:  schnell (Info),  schnell (Info)
Reime: -ɛl
Bedeutungen:
[1] eine hohe Geschwindigkeit habend, das Gegenteil von langsam
[2] nur vergleichsweise wenig Zeit beanspruchend, das Gegenteil von langwierig
[3] adverbielle Verwendung: wenig Zeit benötigend
Herkunft:
althochdeutsch snël → goh, snëlles → goh (in gotisch nicht vorhanden)
Sinnverwandte Wörter:
[1, 2] fix, flink, flott, geschwind, hurtig, rapide, rasch, schleunig, unverzüglich, zügig
[3] eben
Gegenwörter:
[1] langsam
[2] langwierig
Unterbegriffe:
[1–3] blitzschnell, rasend, rasant, sekundenschnell
Beispiele:
[1] Heute nehme ich den schnelleren Zug.
[1] „Beim Bodyflying werden Sie durch einen 180 km/h schnellen Luftstrom aufwärts getrieben.“
[1] Sie ist wirklich schnell, kein anderer schafft soviel an einem Tag.
[2] Um überzeugen zu können, brauchen wir jetzt schnelle Erfolge!
[3] Ich will nur noch schnell einen Happen essen.
[3] „Obergärige Hefen sind zwar empfindlicher als untergärige.“
Redewendungen:
schnell wie der Blitz -
schneller als die Polizei erlaubt -
`;

describe('parseOnlineEntry（查词面板的那一份）', () => {
  it('例句、同义词、反义词、词源各归各位', () => {
    const e = parseOnlineEntry('Zuversicht', ZUVERSICHT)!;
    expect(e.senses).toHaveLength(1);
    expect(e.senses[0].ex).toEqual(['Wir gehen mit großer Zuversicht in die Prüfungen.']);
    expect(e.senses[0].syn).toEqual(['Optimismus']);
    expect(e.senses[0].origin).toMatch(/^mittelhochdeutsch zuoversiht/);
    expect(e.senses[0].ant).toEqual([]);
  });

  it('释义在这个视图里不截到 3 条 —— Mädchen 的 4 条都在', () => {
    expect(parseOnlineEntry('Mädchen', MAEDCHEN)!.senses[0].de).toHaveLength(4);
    // DictEntry 那个视图才截：它要变成 VocabEntry.meaning 的一行
    expect(parseExtract('Mädchen', MAEDCHEN)!.s[0].de).toHaveLength(3);
  });

  it('动词的 Präteritum 与 Partizip II 收进 forms（内置词典完全没有这一类）', () => {
    expect(parseOnlineEntry('abwägen', ABWAEGEN)!.senses[0].forms).toBe(
      'Präteritum: wog ab/wägte ab, Partizip II: abgewogen, abgewägt',
    );
  });

  it('只有 Plural 的名词不给 forms —— 复数已经单独成字段了', () => {
    const s = parseOnlineEntry('Mädchen', MAEDCHEN)!.senses[0];
    expect(s.pl).toBe('Mädchen');
    expect(s.forms).toBeUndefined();
  });

  it('形容词收比较级与最高级', () => {
    expect(parseOnlineEntry('schnell', SCHNELL)!.senses[0].forms).toBe(
      'Komparativ: schneller, Superlativ: am schnellsten',
    );
  });

  it('同义词/反义词按逗号拆开，不是整行一条', () => {
    const s = parseOnlineEntry('schnell', SCHNELL)!.senses[0];
    expect(s.syn.slice(0, 3)).toEqual(['fix', 'flink', 'flott']);
    expect(s.syn.length).toBeLessThanOrEqual(8);
    expect(s.ant).toEqual(['langsam', 'langwierig']);
  });

  it('例句排掉带引号的文学引文（还有普通例句时）', () => {
    const ex = parseOnlineEntry('schnell', SCHNELL)!.senses[0].ex;
    expect(ex).toHaveLength(4);
    expect(ex.some((e) => e.startsWith('„'))).toBe(false);
    expect(ex[0]).toBe('Heute nehme ich den schnelleren Zug.');
  });

  it('Unterbegriffe 与 Redewendungen 不混进释义、例句或同义词', () => {
    const s = parseOnlineEntry('schnell', SCHNELL)!.senses[0];
    const all = [...s.de, ...s.ex, ...s.syn, ...s.ant].join(' | ');
    expect(all).not.toMatch(/blitzschnell/);
    expect(all).not.toMatch(/Polizei/);
  });
});
