import { describe, it, expect } from 'vitest';
import { segmentSentences } from './segment';
import { createSentences } from './sentences';
import { carryGlossary, resegment } from './resegment';
import type { GlossaryCandidate, Sentence } from '@/types/models';

const OLD = 'Der Wald ist groß. Die Bäume sind alt. Es regnet.';

function annotated(): Sentence[] {
  const sentences = createSentences(segmentSentences(OLD));
  sentences[1] = {
    ...sentences[1],
    startTime: 12.5,
    endTime: 15,
    endTimeExplicit: true,
    markedDifficult: true,
    blanks: [{ id: 'b1', ranges: [{ start: 4, end: 9 }], surface: 'Bäume', vocabEntryId: 'v1' }],
  };
  return sentences;
}

describe('resegment', () => {
  it('原文前面插入一段后，旧标注按文本匹配跟到新位置', () => {
    const next = 'Ein neuer Satz voran. ' + OLD;
    const { sentences, carriedOver, orphaned } = resegment(annotated(), segmentSentences(next));

    expect(sentences.map((s) => s.text)).toEqual([
      'Ein neuer Satz voran.',
      'Der Wald ist groß.',
      'Die Bäume sind alt.',
      'Es regnet.',
    ]);
    expect(sentences[2].startTime).toBe(12.5);
    expect(sentences[2].markedDifficult).toBe(true);
    expect(carriedOver.get(2)).toBe(1);
    expect(orphaned).toEqual([]);

    // offset 用新文稿的，挖空 offset 是句内的，仍然对得上
    expect(next.slice(sentences[2].charStart, sentences[2].charEnd)).toBe(sentences[2].text);
    const r = sentences[2].blanks[0].ranges[0];
    expect(sentences[2].text.slice(r.start, r.end)).toBe('Bäume');
  });

  it('被改写的句子进 orphaned，等用户确认丢弃', () => {
    const next = 'Der Wald ist groß. Die Bäume sind sehr alt. Es regnet.';
    const { sentences, orphaned } = resegment(annotated(), segmentSentences(next));
    expect(orphaned.map((s) => s.text)).toEqual(['Die Bäume sind alt.']);
    expect(sentences[1].startTime).toBeUndefined();
  });

  it('没有标注的旧句消失了不算 orphaned', () => {
    const { orphaned } = resegment(annotated(), segmentSentences('Die Bäume sind alt.'));
    expect(orphaned).toEqual([]);
  });

  it('重复的句子一对一认领，不把同一份标注复制两遍', () => {
    const old = createSentences(segmentSentences('Ja. Ja.'));
    old[0] = { ...old[0], startTime: 1 };
    const { sentences } = resegment(old, segmentSentences('Ja. Ja. Ja.'));
    expect(sentences.map((s) => s.startTime)).toEqual([1, undefined, undefined]);
  });

  it('只改了换行/空白不影响匹配', () => {
    const { orphaned, sentences } = resegment(
      annotated(),
      segmentSentences('Der Wald ist groß.\nDie Bäume sind alt.\nEs regnet.'),
    );
    expect(orphaned).toEqual([]);
    expect(sentences[1].startTime).toBe(12.5);
  });
});

describe('carryGlossary（FR-14 候选词跟着重切搬迁）', () => {
  const candidate = (sentenceIndex: number, surface: string): GlossaryCandidate => ({
    dwKnowledgeId: `k-${surface}`,
    sentenceIndex,
    ranges: [{ start: 4, end: 4 + surface.length }],
    surface,
    title: surface,
  });

  it('句号换成新的，句内 offset 一个字都不动', () => {
    // 删掉第一句：旧句 1 → 新句 0
    const { carriedOver } = resegment(annotated(), segmentSentences('Die Bäume sind alt. Es regnet.'));
    const carried = carryGlossary([candidate(1, 'Bäume')], carriedOver)!;
    expect(carried).toHaveLength(1);
    expect(carried[0].sentenceIndex).toBe(0);
    expect(carried[0].ranges).toEqual([{ start: 4, end: 9 }]);
  });

  it('落在没被认领的旧句上的候选被丢掉，而不是留着指向别的句子', () => {
    const { carriedOver } = resegment(annotated(), segmentSentences('Es regnet.'));
    expect(carryGlossary([candidate(1, 'Bäume')], carriedOver)).toBeUndefined();
  });

  it('没有候选词时原样返回（undefined 不变成空数组）', () => {
    const { carriedOver } = resegment(annotated(), segmentSentences(OLD));
    expect(carryGlossary(undefined, carriedOver)).toBeUndefined();
  });
});
