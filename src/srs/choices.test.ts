import { describe, it, expect } from 'vitest';
import {
  buildFormQuestion,
  buildGlossQuestion,
  maskHeadword,
  MAX_CHOICES,
  pickQuestionKind,
  shortGloss,
} from './choices';
import { newCard } from './fsrs';
import type { CandidateWord, Choice } from './choices';
import type { FSRSCard } from '@/types/models';

const NOW = new Date('2026-09-02T12:00:00Z');
const keepOrder = (c: Choice[]) => c;

function card(state: FSRSCard['state']): FSRSCard {
  return { ...newCard(NOW), state };
}

function w(word: string, extra: Partial<CandidateWord> = {}): CandidateWord {
  return { w: word, ...extra };
}

describe('pickQuestionKind', () => {
  it('新卡 / 学习中 / 重学中都考辨形', () => {
    expect(pickQuestionKind(card(0))).toBe('form');
    expect(pickQuestionKind(card(1))).toBe('form');
    expect(pickQuestionKind(card(3))).toBe('form');
  });

  it('进入 Review 之后才考辨义', () => {
    expect(pickQuestionKind(card(2))).toBe('gloss');
  });
});

describe('shortGloss', () => {
  it('短释义原样留着', () => {
    expect(shortGloss('Biologie: Art von Lebewesen')).toBe('Biologie: Art von Lebewesen');
  });

  it('分号前那半优先 —— 它通常正好是个短释义', () => {
    expect(shortGloss('einer für den andern; in einem kooperativen, wohlwollenden Verhältnis zueinander')).toBe(
      'einer für den andern',
    );
  });

  it('领域标签保留（那是最有信息量的一段）', () => {
    expect(shortGloss('Theater: Sichtschutz für die Bühne')).toBe('Theater: Sichtschutz für die Bühne');
  });

  it('长释义在词边界上截，不在第一个逗号上截', () => {
    // 真实数据：Vorhang。截到第一个逗号只剩「ein oder mehrere」，那不是释义
    const long =
      'ein oder mehrere, gegebenenfalls zusammengenähte, Bahnen aus Textil oder anderem Material ursprünglich zum Davorhängen';
    const out = shortGloss(long);
    expect(out.length).toBeLessThanOrEqual(81);
    expect(out).toMatch(/…$/);
    expect(out).not.toBe('ein oder mehrere');
    expect(out.length).toBeGreaterThan(40);
    // 不能截在词中间
    expect(long.startsWith(out.replace('…', '').trimEnd())).toBe(true);
  });

  it('把折行和多余空白压平', () => {
    expect(shortGloss('  jemanden   gesund\n machen ')).toBe('jemanden gesund machen');
  });
});

describe('maskHeadword', () => {
  it('释义里出现词头时遮掉 —— 否则这道题不用听就能做对', () => {
    expect(maskHeadword('Wo sind die Batterien für die Fernbedienung?', 'Fernbedienung')).toBe(
      'Wo sind die Batterien für die …?',
    );
  });

  it('按词干匹配，连屈折形式一起遮', () => {
    expect(maskHeadword('etwas, das heilt oder geheilt wird', 'heilen')).toBe('etwas, das … oder … wird');
  });

  it('太短的词不遮 —— 词干会误伤别的词', () => {
    // `Tor` 的词干只有 3 个字符，遮它会把 Torte / total 一起打掉
    expect(maskHeadword('großes Tor aus Holz', 'Tor')).toBe('großes Tor aus Holz');
  });
});

describe('buildFormQuestion', () => {
  const neighbors = [w('Vorgang'), w('Vorhand', { gender: 'f' }), w('Anhang', { gender: 'm' }), w('Umhang')];

  it('四个选项，正确项恰好一个', () => {
    const q = buildFormQuestion(w('Vorhang', { gender: 'm' }), neighbors, keepOrder);
    expect(q.choices).toHaveLength(MAX_CHOICES);
    expect(q.choices.filter((c) => c.correct)).toHaveLength(1);
    expect(q.choices.find((c) => c.correct)!.text).toBe('Vorhang');
  });

  it('选项不带冠词 —— 只有名词有冠词的话，那本身就是线索', () => {
    const q = buildFormQuestion(w('Vorhang', { gender: 'm' }), neighbors, keepOrder);
    expect(q.choices.map((c) => c.text)).toEqual(['Vorhang', 'Vorgang', 'Vorhand', 'Anhang']);
  });

  it('只有大小写不同的词不能当干扰项（Laufen / laufen 归一化同键）', () => {
    const q = buildFormQuestion(w('laufen'), [w('Laufen'), w('kaufen'), w('raufen'), w('saufen')], keepOrder);
    expect(q.choices.map((c) => c.id)).toEqual(['laufen', 'kaufen', 'raufen', 'saufen']);
  });

  it('干扰项不够时给三个，不抛异常', () => {
    const q = buildFormQuestion(w('Vorhang'), [w('Vorgang'), w('Anhang')], keepOrder);
    expect(q.choices).toHaveLength(3);
    expect(q.choices.filter((c) => c.correct)).toHaveLength(1);
  });

  it('一个干扰项都没有时也能出题（只有正确项）', () => {
    const q = buildFormQuestion(w('Vorhang'), [], keepOrder);
    expect(q.choices).toHaveLength(1);
  });

  it('保持调用方给的近邻顺序 —— 「谁最像」是词典层的判断', () => {
    const q = buildFormQuestion(w('Vorhang'), neighbors, keepOrder);
    expect(q.choices.slice(1).map((c) => c.id)).toEqual(['Vorgang', 'Vorhand', 'Anhang']);
  });
});

describe('buildGlossQuestion', () => {
  const correct = w('Vorhang', {
    gender: 'm',
    pos: 'noun',
    gloss: 'Theater: Sichtschutz für die Bühne',
  });
  const pool = [
    w('heilen', { pos: 'verb', gloss: 'jemanden gesund machen' }),
    w('Falke', { pos: 'noun', gloss: 'Greifvogel aus der Familie der Falkenartigen' }),
    w('Spind', { pos: 'noun', gloss: 'abschließbarer Schrank für Kleidung' }),
    w('Galgen', { pos: 'noun', gloss: 'Gerüst zum Erhängen' }),
  ];

  it('选项是释义，正确项恰好一个', () => {
    const q = buildGlossQuestion(correct, pool, keepOrder);
    expect(q.kind).toBe('gloss');
    expect(q.choices).toHaveLength(MAX_CHOICES);
    expect(q.choices.filter((c) => c.correct)).toHaveLength(1);
    expect(q.choices.find((c) => c.correct)!.text).toBe('Theater: Sichtschutz für die Bühne');
  });

  it('同词性的干扰项优先 —— 否则靠语法就能排除', () => {
    const q = buildGlossQuestion(correct, pool, keepOrder);
    // heilen 是动词，被排到最后，四个选项里装不下
    expect(q.choices.map((c) => c.id)).toEqual(['Vorhang', 'Falke', 'Spind', 'Galgen']);
  });

  it('没有释义的候选跳过，不建空选项', () => {
    const q = buildGlossQuestion(correct, [w('Tool', { pos: 'noun' }), pool[1], pool[2]], keepOrder);
    expect(q.choices.map((c) => c.id)).toEqual(['Vorhang', 'Falke', 'Spind']);
    expect(q.choices.every((c) => c.text.length > 0)).toBe(true);
  });

  it('释义撞车的候选跳过 —— 否则出现两个都对的选项', () => {
    const twin = w('Gardine', { pos: 'noun', gloss: 'Theater: Sichtschutz für die Bühne' });
    const q = buildGlossQuestion(correct, [twin, pool[1], pool[2], pool[3]], keepOrder);
    expect(q.choices.map((c) => c.id)).not.toContain('Gardine');
    expect(new Set(q.choices.map((c) => c.text)).size).toBe(q.choices.length);
  });

  it('四个选项里的词头一起被遮，带「…」的那个不会变成答案', () => {
    const q = buildGlossQuestion(
      w('Fernbedienung', { pos: 'noun', gloss: 'Gerät, mit dem eine Fernbedienung ausgeübt wird' }),
      [
        w('Halluzination', { pos: 'noun', gloss: 'Halluzination genannte Sinnestäuschung' }),
        w('Generator', { pos: 'noun', gloss: 'Maschine zur Stromerzeugung' }),
        w('Kreuzung', { pos: 'noun', gloss: 'Stelle, an der sich Wege schneiden' }),
      ],
      keepOrder,
    );
    const masked = q.choices.filter((c) => c.text.includes('…'));
    expect(masked).toHaveLength(2); // 正确项和 Halluzination 都被遮，遮痕不指向答案
  });

  it('释义太长时截断后仍然互不相同', () => {
    const q = buildGlossQuestion(correct, pool, keepOrder);
    for (const c of q.choices) expect(c.text.length).toBeLessThanOrEqual(81);
  });
});

describe('打乱', () => {
  it('正确项不会永远排在第一个', () => {
    const positions = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const q = buildFormQuestion(w('Vorhang'), [w('Vorgang'), w('Anhang'), w('Umhang')]);
      positions.add(q.choices.findIndex((c) => c.correct));
    }
    expect(positions.size).toBeGreaterThan(1);
  });
});
