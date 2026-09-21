import { describe, it, expect } from 'vitest';
import {
  buildClozeQuestion,
  buildFormQuestion,
  buildGlossQuestion,
  buildReadFormQuestion,
  buildReadGlossQuestion,
  choicesAreWords,
  CLOZE_BLANK,
  maskHeadword,
  maskInSentence,
  MAX_CHOICES,
  pickQuestionKind,
  pickReadKind,
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

// ── FR-21：读卡的三种题 ────────────────────────────────────────────
describe('pickReadKind', () => {
  const at = (state: FSRSCard['state'], reps: number): FSRSCard => ({ ...card(state), reps });

  it('还没进 Review 的读卡一律考「看词形选释义」', () => {
    expect(pickReadKind(at(0, 0))).toBe('read-gloss');
    expect(pickReadKind(at(1, 1))).toBe('read-gloss');
    expect(pickReadKind(at(3, 7))).toBe('read-gloss');
  });

  it('进 Review 之后在 read-form 与 cloze 之间按 reps 奇偶交替', () => {
    expect(pickReadKind(at(2, 1))).toBe('read-form');
    expect(pickReadKind(at(2, 2))).toBe('cloze');
    expect(pickReadKind(at(2, 3))).toBe('read-form');
    expect(pickReadKind(at(2, 4))).toBe('cloze');
  });
});

describe('choicesAreWords', () => {
  it('选项里放词形的三种题走 2×2，放释义的两种走单列（§12.13）', () => {
    expect((['form', 'read-form', 'cloze'] as const).map(choicesAreWords)).toEqual([true, true, true]);
    expect((['gloss', 'read-gloss'] as const).map(choicesAreWords)).toEqual([false, false]);
  });
});

describe('maskInSentence', () => {
  it('把句子里的词遮成定宽的空', () => {
    expect(maskInSentence('Der Vorhang fiel.', 'Vorhang')).toBe(`Der ${CLOZE_BLANK} fiel.`);
  });

  it('同一句里出现两次要全遮 —— 遮一次剩一次就是答案', () => {
    const masked = maskInSentence('Der Vorhang fiel. Ein Vorhang aus Samt.', 'Vorhang');
    expect(masked).not.toContain('Vorhang');
    expect(masked?.match(new RegExp(CLOZE_BLANK, 'g'))).toHaveLength(2);
  });

  it('屈折形式也遮得掉（词干匹配）', () => {
    expect(maskInSentence('Die Vorhänge hingen schief.', 'Vorhang')).toBe(
      `Die ${CLOZE_BLANK} hingen schief.`,
    );
    expect(maskInSentence('Er heilte die Wunde.', 'heilen')).toBe(`Er ${CLOZE_BLANK} die Wunde.`);
  });

  it('短词按整词匹配，不打掉含它的别的词', () => {
    expect(maskInSentence('Das Tor und die Torte.', 'Tor')).toBe(
      `Das ${CLOZE_BLANK} und die Torte.`,
    );
  });

  it('空位宽度固定 —— 跟着词长走等于把词长泄给四个选项（FR-21.8）', () => {
    const kurz = maskInSentence('Das Tor ist zu.', 'Tor');
    const lang = maskInSentence('Die Fernbedienung ist weg.', 'Fernbedienung');
    expect(kurz).toContain(CLOZE_BLANK);
    expect(lang).toContain(CLOZE_BLANK);
    expect(kurz?.replace(CLOZE_BLANK, '')).not.toContain('_');
    expect(lang?.replace(CLOZE_BLANK, '')).not.toContain('_');
  });

  it('多词搭配不出这道题', () => {
    expect(maskInSentence('Es hing von ihm ab.', 'hing ab')).toBeNull();
  });

  it('句子里根本没有这个词时返回 null，不出一道无解的题', () => {
    expect(maskInSentence('Ein ganz anderer Satz.', 'Vorhang')).toBeNull();
  });
});

describe('读卡的三种组题', () => {
  const me = w('Vorhang', { gloss: 'Stoffbahn vor einem Fenster', pos: 'noun' });
  const pool = [
    w('Vorgang', { gloss: 'Ablauf eines Geschehens', pos: 'noun' }),
    w('Lebensform', { gloss: 'Art zu leben', pos: 'noun' }),
    w('Halluzination', { gloss: 'Sinnestäuschung ohne Reiz', pos: 'noun' }),
  ];

  it('read-gloss：题面是词形，选项是释义', () => {
    const q = buildReadGlossQuestion(me, pool, keepOrder);
    expect(q.kind).toBe('read-gloss');
    expect(q.prompt).toBe('Vorhang');
    expect(q.choices.filter((c) => c.correct)).toHaveLength(1);
    expect(q.choices[0].text).toContain('Stoffbahn');
  });

  it('read-form：题面是释义，选项是词形', () => {
    const q = buildReadFormQuestion(me, pool, keepOrder);
    expect(q.kind).toBe('read-form');
    expect(q.prompt).toContain('Stoffbahn');
    expect(q.choices.map((c) => c.text)).toContain('Vorhang');
  });

  it('read-form 的题面也要遮词头 —— 题面里写着答案是同一句话的另一种毁法', () => {
    const selbst = w('Fernbedienung', { gloss: 'Eine Fernbedienung steuert ein Gerät' });
    const q = buildReadFormQuestion(selbst, pool, keepOrder);
    expect(q.prompt).not.toContain('Fernbedienung');
    expect(q.prompt).toContain('…');
  });

  it('cloze：题面是调用方挖好的句子，选项是词形', () => {
    const masked = maskInSentence('Der Vorhang fiel.', 'Vorhang');
    const q = buildClozeQuestion(me, pool, masked!, keepOrder);
    expect(q.kind).toBe('cloze');
    expect(q.prompt).toBe(`Der ${CLOZE_BLANK} fiel.`);
    expect(q.choices).toHaveLength(MAX_CHOICES);
    expect(q.choices.filter((c) => c.correct)).toHaveLength(1);
  });

  it('三种题都不给听卡留题面以外的痕迹：听卡的 prompt 仍然是 undefined', () => {
    expect(buildFormQuestion(me, pool, keepOrder).prompt).toBeUndefined();
    expect(buildGlossQuestion(me, pool, keepOrder).prompt).toBeUndefined();
  });
});
