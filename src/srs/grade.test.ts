import { describe, it, expect } from 'vitest';
import { articled, gradeFromAnswer, GRADE_THRESHOLDS } from './grade';
import { newCard, review } from './fsrs';
import type { FSRSCard } from '@/types/models';

const NOW = new Date('2026-09-02T12:00:00Z');

function card(partial: Partial<FSRSCard> = {}): FSRSCard {
  return { ...newCard(NOW), ...partial };
}

/** 一张复习过几次、没错过的卡 */
const seasoned = card({ reps: 3, lapses: 0, state: 2 });

describe('gradeFromAnswer', () => {
  it('选错判 again', () => {
    expect(gradeFromAnswer({ correct: false, gaveUp: false, elapsedMs: 800 }, seasoned)).toBe('again');
  });

  it('点「不认识」判 again —— 哪怕点得很快', () => {
    // 快是因为他一眼就知道自己不知道，那不是「记得牢」
    expect(gradeFromAnswer({ correct: false, gaveUp: true, elapsedMs: 300 }, seasoned)).toBe('again');
  });

  it('答对但犹豫（≥4s）判 hard', () => {
    expect(gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: 4_000 }, seasoned)).toBe('hard');
    expect(gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: 9_000 }, seasoned)).toBe('hard');
  });

  it('答对且正常速度判 good', () => {
    expect(gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: 2_500 }, seasoned)).toBe('good');
  });

  it('答对且秒答（<1.5s）判 easy', () => {
    expect(gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: 900 }, seasoned)).toBe('easy');
  });

  // ── 下面三条是这个函数存在的真正理由：四选一有 25% 的瞎猜命中率 ──

  it('错过的卡即使秒答也只到 good，不给 easy', () => {
    const lapsed = card({ reps: 5, lapses: 1, state: 2 });
    expect(gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: 400 }, lapsed)).toBe('good');
  });

  it('新卡（reps=0）秒答也只到 good —— 第一次见就点对，多半是猜的', () => {
    expect(gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: 200 }, card())).toBe('good');
  });

  it('乱点一次猜对，不会把卡推到一个月以后', () => {
    // 这条测的是「阈值 + FSRS」合起来的行为，不只是映射表
    const fresh = card();
    const guessed = review(fresh, gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: 150 }, fresh), NOW);
    const days = (guessed.due - NOW.getTime()) / 86_400_000;
    expect(days).toBeLessThan(7);
  });

  it('阈值是闭右开左的，边界不落进空档', () => {
    const at = (ms: number) => gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: ms }, seasoned);
    expect(at(GRADE_THRESHOLDS.easyMs - 1)).toBe('easy');
    expect(at(GRADE_THRESHOLDS.easyMs)).toBe('good');
    expect(at(GRADE_THRESHOLDS.hardMs - 1)).toBe('good');
    expect(at(GRADE_THRESHOLDS.hardMs)).toBe('hard');
  });

  it('四档全都能被判出来 —— 没有哪一档因为阈值写反而永远取不到', () => {
    const got = new Set([
      gradeFromAnswer({ correct: false, gaveUp: false, elapsedMs: 1_000 }, seasoned),
      gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: 5_000 }, seasoned),
      gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: 2_000 }, seasoned),
      gradeFromAnswer({ correct: true, gaveUp: false, elapsedMs: 500 }, seasoned),
    ]);
    expect(got).toEqual(new Set(['again', 'hard', 'good', 'easy']));
  });
});

describe('articled', () => {
  it('名词带冠词（FR-10.11 那 600ms 唯一能给出性的地方）', () => {
    expect(articled('Vorhang', 'm')).toBe('der Vorhang');
    expect(articled('Freundlichkeit', 'f')).toBe('die Freundlichkeit');
    expect(articled('Gästezimmer', 'n')).toBe('das Gästezimmer');
  });

  it('没有性的词原样返回，不硬塞一个冠词', () => {
    expect(articled('heilen', undefined)).toBe('heilen');
  });
});
