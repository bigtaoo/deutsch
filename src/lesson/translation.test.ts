import { describe, it, expect } from 'vitest';
import { segmentSentences } from './segment';
import { createSentences } from './sentences';
import {
  applyTranslations,
  clearTranslations,
  hasTranslations,
  parseTranslations,
  translationCoverage,
  translationRequest,
  TRANSLATION_PROMPT,
} from './translation';
import type { Sentence } from '@/types/models';

const TEXT = 'Der Wald ist groß. Die Bäume sind alt. Es regnet.';

function fresh(): Sentence[] {
  return createSentences(segmentSentences(TEXT));
}

describe('translationRequest', () => {
  it('按显示号输出原文，排除句不占号也不出现', () => {
    const sentences = fresh();
    sentences[1] = { ...sentences[1], excluded: true };
    const out = translationRequest(sentences);

    expect(out).toContain('1. Der Wald ist groß.');
    expect(out).toContain('2. Es regnet.');
    expect(out).not.toContain('Die Bäume');
  });

  it('句内换行折成空格 —— 复制出去的每一条就是一行', () => {
    const sentences = fresh();
    sentences[0] = { ...sentences[0], text: 'Der Wald\nist  groß.' };
    expect(translationRequest(sentences)).toContain('1. Der Wald ist groß.');
  });
});

describe('parseTranslations', () => {
  it('提示词本身解析不出任何条目 —— 它的要求不带数字编号正是为此', () => {
    expect(parseTranslations(TRANSLATION_PROMPT).size).toBe(0);
  });

  it('吃得下常见的几种编号写法', () => {
    const parsed = parseTranslations(
      ['1. 森林很大。', '2、树很老。', '3) 下雨了。', '4：第四句。', '5．第五句。'].join('\n'),
    );
    expect(parsed.get(1)).toBe('森林很大。');
    expect(parsed.get(2)).toBe('树很老。');
    expect(parsed.get(3)).toBe('下雨了。');
    expect(parsed.get(4)).toBe('第四句。');
    expect(parsed.get(5)).toBe('第五句。');
  });

  it('忽略前言、结语、列表符与加粗', () => {
    const parsed = parseTranslations(
      [
        '好的，以下是这篇课文的逐句翻译：',
        '',
        '- **1.** 森林很大。',
        '> 2. 树很老。',
        '',
        '以上就是全文翻译，希望对你有帮助。',
      ].join('\n'),
    );
    expect([...parsed.keys()]).toEqual([1, 2]);
    expect(parsed.get(1)).toBe('森林很大。');
    expect(parsed.get(2)).toBe('树很老。');
  });

  it('一条译文占好几行时，续行接在上一条后面；空行结束这一条', () => {
    const parsed = parseTranslations(
      ['1. 森林很大，', '而且很安静。', '', '这句结语不该被吃进第 1 条。'].join('\n'),
    );
    expect(parsed.get(1)).toBe('森林很大，\n而且很安静。');
    expect(parsed.size).toBe(1);
  });

  it('没有编号的行永远开不了新条目 —— 宁可少认，不按位置猜', () => {
    const parsed = parseTranslations(['森林很大。', '树很老。'].join('\n'));
    expect(parsed.size).toBe(0);
  });

  it('空条目不写进去', () => {
    expect(parseTranslations('1.\n2. 有内容。').has(1)).toBe(false);
  });

  it('同一个编号出现两次，后一次赢（补贴一段修正）', () => {
    const parsed = parseTranslations('1. 旧译文。\n\n1. 新译文。');
    expect(parsed.get(1)).toBe('新译文。');
  });
});

describe('applyTranslations', () => {
  it('按显示号写回，排除句跳过', () => {
    const sentences = fresh();
    sentences[1] = { ...sentences[1], excluded: true };
    const { sentences: next, applied, strayNumbers } = applyTranslations(
      sentences,
      parseTranslations('1. 森林很大。\n2. 下雨了。'),
    );

    expect(applied).toBe(2);
    expect(strayNumbers).toEqual([]);
    expect(next[0].translation).toBe('森林很大。');
    expect(next[1].translation).toBeUndefined(); // 排除句
    expect(next[2].translation).toBe('下雨了。');
  });

  it('这次没给到的句子保留原有译文 —— 一篇分两次贴是常事', () => {
    const first = applyTranslations(fresh(), parseTranslations('1. 森林很大。')).sentences;
    const second = applyTranslations(first, parseTranslations('3. 下雨了。')).sentences;

    expect(second[0].translation).toBe('森林很大。');
    expect(second[2].translation).toBe('下雨了。');
  });

  it('超出范围的编号报出来，不静默丢弃', () => {
    const { applied, strayNumbers } = applyTranslations(
      fresh(),
      parseTranslations('1. 森林很大。\n9. 哪来的第九句。'),
    );
    expect(applied).toBe(1);
    expect(strayNumbers).toEqual([9]);
  });

  it('内容没变时不产生新对象 —— 重复粘同一份不该让整课看起来改过', () => {
    const once = applyTranslations(fresh(), parseTranslations('1. 森林很大。'));
    const twice = applyTranslations(once.sentences, parseTranslations('1. 森林很大。'));
    expect(twice.applied).toBe(0);
    expect(twice.sentences[0]).toBe(once.sentences[0]);
  });
});

describe('coverage', () => {
  it('分母不算排除句', () => {
    const sentences = applyTranslations(fresh(), parseTranslations('1. 森林很大。')).sentences;
    sentences[2] = { ...sentences[2], excluded: true };

    expect(translationCoverage(sentences)).toEqual({ translated: 1, total: 2 });
    expect(hasTranslations(sentences)).toBe(true);
    expect(hasTranslations(clearTranslations(sentences))).toBe(false);
  });
});
