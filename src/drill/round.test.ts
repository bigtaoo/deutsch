// FR-22.5 ~ FR-22.7：排轮、出题、本轮重做。全是纯函数。

import { describe, expect, it } from 'vitest';
import { newCard } from '@/srs/fsrs';
import {
  advanceRun,
  buildDrillChoices,
  isRetry,
  planRound,
  primaryZh,
  recordAnswer,
  RETRY_GAP,
  runFinished,
  sameMeaning,
  splitPool,
  startRun,
  summarizeRun,
} from './round';
import { emptyDrillState, withCustom, withProgress } from './state';
import type { PoolItem } from './types';

function item(id: string, zh: string, extra: Partial<PoolItem> = {}): PoolItem {
  return { id, w: id, p: 'noun', zh, category: 'daily', ...extra };
}

/** 可复现的伪随机。 */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

const NOW = 1_000_000;

describe('splitPool / planRound', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id, id + '义'));

  it('先到期（按到期先后）、再新词；没到期的已学词不出', () => {
    let s = emptyDrillState();
    s = withProgress(s, 'audio', 'c', { ...newCard(), due: NOW - 10 }, 1);
    s = withProgress(s, 'audio', 'a', { ...newCard(), due: NOW - 99 }, 1);
    s = withProgress(s, 'audio', 'b', { ...newCard(), due: NOW + 1 }, 1);
    const split = splitPool(pool, s, 'audio', NOW);
    expect(split.due.map((i) => i.id)).toEqual(['a', 'c']);
    expect(split.fresh.map((i) => i.id).sort()).toEqual(['d', 'e']);
    expect(planRound(pool, s, 'audio', 3, NOW).map((i) => i.id).slice(0, 2)).toEqual(['a', 'c']);
    expect(planRound(pool, s, 'audio', 3, NOW)).toHaveLength(3);
  });

  it('两种模式各算各的：音频学过的词在单词模式里仍是新词（FR-22.4）', () => {
    const s = withProgress(emptyDrillState(), 'audio', 'a', { ...newCard(), due: NOW + 1 }, 1);
    expect(splitPool(pool, s, 'word', NOW).fresh.map((i) => i.id)).toContain('a');
    expect(splitPool(pool, s, 'audio', NOW).fresh.map((i) => i.id)).not.toContain('a');
  });

  it('新词里「我加的」排最前（按加入先后），其余顺序与输入顺序无关', () => {
    let s = emptyDrillState();
    s = withCustom(s, { id: 'u:y', w: 'y', p: 'noun', zh: 'y' }, 20);
    s = withCustom(s, { id: 'u:x', w: 'x', p: 'noun', zh: 'x' }, 10);
    const mine = [item('u:y', 'y义', { category: 'mine' }), item('u:x', 'x义', { category: 'mine' })];
    const fresh = splitPool([...pool, ...mine], s, 'audio', NOW).fresh.map((i) => i.id);
    expect(fresh.slice(0, 2)).toEqual(['u:x', 'u:y']);
    const reversed = splitPool([...[...pool].reverse(), ...mine], s, 'audio', NOW).fresh.map((i) => i.id);
    expect(reversed).toEqual(fresh);
  });
});

describe('primaryZh / sameMeaning', () => {
  it('主义项是「；」前那一段，去掉括号补充', () => {
    expect(primaryZh('（银行）扣款；直接借记')).toBe('扣款');
    expect(primaryZh('押金')).toBe('押金');
  });

  it('整句相同、主义项相同、互相包含都算同义', () => {
    expect(sameMeaning('放弃', '放弃；弃权')).toBe(true);
    expect(sameMeaning('押金', '押金；保证金')).toBe(true);
    expect(sameMeaning('投诉', '投诉信')).toBe(true);
    expect(sameMeaning('押金', '房租')).toBe(false);
  });
});

describe('buildDrillChoices', () => {
  const target = item('kaution', '押金');
  const pool = [
    target,
    item('miete', '房租'),
    item('pfand', '押金；保证金'), // 与正确答案同义，不能出现
    item('vermieter', '房东'),
    item('makler', '中介'),
    item('laufen', '跑', { p: 'verb' }),
    item('schnell', '快的', { p: 'adj' }),
  ];

  it('四个选项、正确项恰好一个、就是这个词的中文', () => {
    const choices = buildDrillChoices(target, pool, seeded());
    expect(choices).toHaveLength(4);
    expect(choices.filter((c) => c.correct)).toEqual([{ id: 'kaution', text: '押金', correct: true }]);
  });

  it('同义的中文不进干扰项（否则是一道没有唯一答案的题）', () => {
    for (let seed = 1; seed < 30; seed++) {
      const ids = buildDrillChoices(target, pool, seeded(seed)).map((c) => c.id);
      expect(ids).not.toContain('pfand');
    }
  });

  it('同词性优先：名词题的干扰项都是名词', () => {
    for (let seed = 1; seed < 30; seed++) {
      const ids = buildDrillChoices(target, pool, seeded(seed)).map((c) => c.id);
      expect(ids).not.toContain('laufen');
      expect(ids).not.toContain('schnell');
    }
  });

  it('同词性不够时放宽到别的词性，照样凑满四个', () => {
    const small = [target, item('miete', '房租'), item('laufen', '跑', { p: 'verb' }), item('schnell', '快的', { p: 'adj' })];
    expect(buildDrillChoices(target, small, seeded())).toHaveLength(4);
  });

  it('干扰项之间也不能同义', () => {
    const p = [target, item('a', '房租'), item('b', '房租；租金'), item('c', '房东'), item('d', '中介')];
    for (let seed = 1; seed < 30; seed++) {
      const ids = buildDrillChoices(target, p, seeded(seed)).map((c) => c.id);
      expect(ids.includes('a') && ids.includes('b')).toBe(false);
    }
  });

  it('正确项不总在第一个', () => {
    const positions = new Set<number>();
    for (let seed = 1; seed < 40; seed++) {
      positions.add(buildDrillChoices(target, pool, seeded(seed)).findIndex((c) => c.correct));
    }
    expect(positions.size).toBeGreaterThan(1);
  });
});

describe('一轮之内（FR-22.7）', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => item(id, id));

  it('答错的词插回 RETRY_GAP 张之后，直到答对', () => {
    let run = startRun(items);
    run = recordAnswer(run, false); // a 错
    expect(run.queue.indexOf('a', 1)).toBe(1 + RETRY_GAP);
    run = advanceRun(run);
    for (let i = 0; i < RETRY_GAP; i++) run = advanceRun(recordAnswer(run, true));
    expect(run.queue[run.position]).toBe('a');
    expect(isRetry(run)).toBe(true);
    run = recordAnswer(run, false); // 重做又错：再插回去
    expect(run.queue.filter((id) => id === 'a')).toHaveLength(3);
  });

  it('只记第一次作答：错了再对，小结里仍然是「错过」', () => {
    let run = startRun(items.slice(0, 2));
    run = advanceRun(recordAnswer(run, false)); // a 错
    run = advanceRun(recordAnswer(run, true)); // b 对
    run = advanceRun(recordAnswer(run, true)); // a 重做对
    expect(runFinished(run)).toBe(true);
    expect(summarizeRun(run)).toEqual({ total: 2, firstTry: 1, missed: ['a'] });
  });

  it('错题在队尾附近时插到最后，不越界', () => {
    let run = startRun(items.slice(0, 2));
    run = advanceRun(recordAnswer(run, true));
    run = recordAnswer(run, false); // b 错，后面只剩 0 张
    expect(run.queue).toEqual(['a', 'b', 'b']);
  });
});
