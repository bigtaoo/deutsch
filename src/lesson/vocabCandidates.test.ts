import { describe, expect, it } from 'vitest';
import { findCandidates, type CandidateDeps } from './vocabCandidates';
import type { DictEntry, DictLookup } from '@/dict/types';
import type { Lesson, Sentence } from '@/types/models';

function sentence(index: number, text: string, timed = true, extra: Partial<Sentence> = {}): Sentence {
  return {
    index,
    text,
    charStart: 0,
    charEnd: text.length,
    startTime: timed ? index * 5 : undefined,
    endTimeExplicit: false,
    blanks: [],
    markedDifficult: false,
    excluded: false,
    ...extra,
  };
}

function lesson(sentences: Sentence[], extra: Partial<Lesson> = {}): Lesson {
  return { id: 'L', title: 't', source: { type: 'manual' }, sentences, createdAt: 0, updatedAt: 0, ...extra } as Lesson;
}

/** 小词典：词形 → 词条。`f` 越小越难 */
const DICT: Record<string, DictEntry> = {
  und: { w: 'und', f: 900000, s: [{ p: 'conj' }] },
  die: { w: 'die', f: 900000, s: [{ p: 'art' }] },
  zuversicht: { w: 'Zuversicht', f: 120, s: [{ p: 'noun', g: 'f', de: ['feste Hoffnung'] }] },
  plattform: { w: 'Plattform', f: 800, s: [{ p: 'noun', g: 'f', de: ['erhöhte Fläche'] }] },
  plattformen: { w: 'Plattform', f: 800, s: [{ p: 'noun', g: 'f', de: ['erhöhte Fläche'] }] },
  abwägen: { w: 'abwägen', f: 50, s: [{ p: 'verb', de: ['vergleichend prüfen'] }] },
  müller: { w: 'Müller', s: [{ p: 'propn' }] },
  haus: { w: 'Haus', f: 50000, s: [{ p: 'noun', g: 'n' }] },
  häuser: { w: 'Haus', f: 50000, s: [{ p: 'noun', g: 'n' }] },
};

function deps(over: Partial<CandidateDeps> = {}): CandidateDeps {
  return {
    lookup: async (surface): Promise<DictLookup | null> => {
      const entry = DICT[surface.toLowerCase()];
      return entry ? { entry, via: 'exact' } : null;
    },
    commonKeys: new Set(['und', 'die', 'haus']),
    commonForms: new Set(),
    takenKeys: new Set(),
    knownKeys: new Set(),
    ...over,
  };
}

describe('findCandidates（FR-9.13）', () => {
  it('去掉前 3000 名，剩下的按难度（词频从低到高）排，挂在第一次出现的句子上', async () => {
    const l = lesson([
      sentence(0, 'Die Plattform und das Haus.'),
      sentence(1, 'Mit Zuversicht abwägen.'),
    ]);
    const { found } = await findCandidates(l, deps());
    expect(found.map((c) => c.headword)).toEqual(['abwägen', 'Zuversicht', 'Plattform']);
    const z = found.find((c) => c.headword === 'Zuversicht')!;
    expect(z).toMatchObject({ sentenceIndex: 1, gender: 'f', meaning: 'feste Hoffnung', surface: 'Zuversicht' });
    expect(l.sentences[1].text.slice(z.ranges[0].start, z.ranges[0].end)).toBe('Zuversicht');
  });

  it('同一个词元的几种词形只列一次，留课文里最早出现的那个', async () => {
    const l = lesson([sentence(0, 'Viele Plattformen.'), sentence(1, 'Eine Plattform.')]);
    const { found } = await findCandidates(l, deps());
    const p = found.filter((c) => c.headword === 'Plattform');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ surface: 'Plattformen', sentenceIndex: 0 });
  });

  it('生词本里已有的、标过认识的都不列（按词元键，变形也算）', async () => {
    const l = lesson([sentence(0, 'Plattformen, Zuversicht, abwägen.')]);
    const { found } = await findCandidates(l, deps({ takenKeys: new Set(['plattform']), knownKeys: new Set(['zuversicht']) }));
    expect(found.map((c) => c.headword)).toEqual(['abwägen']);
  });

  it('专有名词、数字、太短的不列；查不到的短词不列、长的单列在 unknown', async () => {
    const l = lesson([sentence(0, 'Herr Müller kam 2024 mit Xyz und Gesetzesvorlage.')]);
    const { found, unknown } = await findCandidates(l, deps());
    expect(found).toEqual([]);
    // Herr / kam / mit 查不到但短于 5 → 不列；Gesetzesvorlage 查不到但够长 → unknown
    expect(unknown.map((c) => c.headword)).toEqual(['Gesetzesvorlage']);
  });

  it('没有时间戳的句子上的词挂不上挖空，不收；整课都没有时 timed=false', async () => {
    const partly = lesson([sentence(0, 'Zuversicht.', false), sentence(1, 'Plattform.')]);
    const r1 = await findCandidates(partly, deps());
    expect(r1.timed).toBe(true);
    expect(r1.found.map((c) => c.headword)).toEqual(['Plattform']);

    const none = lesson([sentence(0, 'Zuversicht.', false)]);
    const r2 = await findCandidates(none, deps());
    expect(r2).toEqual({ found: [], unknown: [], timed: false });
  });

  it('已经挖了空的、DW Glossar 标过的、排除句里的词，这一课里有自己的入口，不重复列', async () => {
    const text = 'Zuversicht und Plattform, abwägen.';
    const l = lesson(
      [
        sentence(0, text, true, { blanks: [{ id: 'b', ranges: [{ start: 0, end: 10 }], surface: 'Zuversicht', vocabEntryId: 'v' }] }),
        sentence(1, 'Gesetzesvorlage', true, { excluded: true }),
      ],
      {
        glossary: [
          { dwKnowledgeId: 'k', sentenceIndex: 0, ranges: [{ start: 15, end: 24 }], surface: 'Plattform', title: 'die Plattform' },
        ] as Lesson['glossary'],
      },
    );
    const { found, unknown } = await findCandidates(l, deps());
    expect(found.map((c) => c.headword)).toEqual(['abwägen']);
    expect(unknown).toEqual([]);
  });

  it('词形常见就不列，哪怕词元那一侧没有词频（`Tag` 那一类）；词元常见时少见的变形也不列', async () => {
    const l = lesson([sentence(0, 'Jeden Tag Zuversicht, Häuser, Plattformen.')]);
    const { found, unknown } = await findCandidates(l, deps({ commonForms: new Set(['tag', 'jeden']) }));
    // Tag 在常见词形里；Häuser 查到的是 Haus（commonKeys）；只剩真正少见的两个
    expect([...found, ...unknown].map((c) => c.headword).sort()).toEqual(['Plattform', 'Zuversicht']);
  });

  it('查词抛错当查不到处理，不让整张列表失败', async () => {
    const l = lesson([sentence(0, 'Zuversicht Gesetzesvorlage')]);
    const { found, unknown } = await findCandidates(l, deps({ lookup: async () => { throw new Error('断网'); } }));
    expect(found).toEqual([]);
    expect(unknown.map((c) => c.surface)).toEqual(['Zuversicht', 'Gesetzesvorlage']);
  });
});
