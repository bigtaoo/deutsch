import { describe, expect, it } from 'vitest';
import {
  addStudySeconds,
  emptyStudyLog,
  localDateKey,
  mergeStudyLogs,
  shiftDateKey,
  studyLogNeedsPush,
  type StudyLog,
} from './log';

function log(days: StudyLog['days'], updatedAt = 1): StudyLog {
  return { days, updatedAt };
}

describe('localDateKey / shiftDateKey', () => {
  it('按本地时区给出 YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 8, 15, 23, 30))).toBe('2026-09-15');
    // 本地时间 00:30 属于当天 —— 换成 UTC 会算成前一天
    expect(localDateKey(new Date(2026, 8, 15, 0, 30))).toBe('2026-09-15');
  });

  it('往回数跨月跨年', () => {
    expect(shiftDateKey('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftDateKey('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDateKey('2024-03-01', -1)).toBe('2024-02-29');
  });
});

describe('addStudySeconds', () => {
  it('累加到对应设备的格子上，不改入参', () => {
    const before = emptyStudyLog();
    const once = addStudySeconds(before, '2026-09-15', 'dev-a', 30);
    const twice = addStudySeconds(once, '2026-09-15', 'dev-a', 30);

    expect(before.days).toEqual({});
    expect(twice.days['2026-09-15']['dev-a']).toBe(60);
  });

  it('同一天的两台设备各占一格', () => {
    const a = addStudySeconds(emptyStudyLog(), '2026-09-15', 'dev-a', 900);
    const both = addStudySeconds(a, '2026-09-15', 'dev-b', 420);
    expect(both.days['2026-09-15']).toEqual({ 'dev-a': 900, 'dev-b': 420 });
  });

  it('非正数不写入', () => {
    const before = emptyStudyLog();
    expect(addStudySeconds(before, '2026-09-15', 'dev-a', 0)).toBe(before);
  });
});

describe('mergeStudyLogs', () => {
  it('逐格取 max，两台设备的时长都在', () => {
    const local = log({ '2026-09-15': { a: 900 } });
    const remote = log({ '2026-09-15': { b: 420 }, '2026-09-14': { b: 600 } });

    const { merged, changed } = mergeStudyLogs(local, remote);
    expect(merged.days['2026-09-15']).toEqual({ a: 900, b: 420 });
    expect(merged.days['2026-09-14']).toEqual({ b: 600 });
    expect(changed).toBe(true);
  });

  it('幂等：同一份远端合两次结果一样，而且数字不翻倍', () => {
    const local = log({ '2026-09-15': { a: 900 } });
    const remote = log({ '2026-09-15': { a: 900, b: 420 } });

    const once = mergeStudyLogs(local, remote).merged;
    const twice = mergeStudyLogs(once, remote).merged;
    expect(twice.days).toEqual(once.days);
    expect(twice.days['2026-09-15']['a']).toBe(900);
  });

  it('本地那格更大时不倒退，也不报告变化', () => {
    const local = log({ '2026-09-15': { a: 900 } });
    const remote = log({ '2026-09-15': { a: 300 } });

    const { merged, changed } = mergeStudyLogs(local, remote);
    expect(merged.days['2026-09-15']['a']).toBe(900);
    expect(changed).toBe(false);
  });
});

describe('studyLogNeedsPush', () => {
  it('本地有远端没有的格子时要回推', () => {
    expect(
      studyLogNeedsPush(log({ '2026-09-15': { a: 60 } }), log({ '2026-09-15': { b: 60 } })),
    ).toBe(true);
  });

  it('本地那格更大时要回推', () => {
    expect(
      studyLogNeedsPush(log({ '2026-09-15': { a: 900 } }), log({ '2026-09-15': { a: 300 } })),
    ).toBe(true);
  });

  it('远端已经包含本地的一切时不推', () => {
    expect(
      studyLogNeedsPush(
        log({ '2026-09-15': { a: 300 } }),
        log({ '2026-09-15': { a: 300, b: 60 } }),
      ),
    ).toBe(false);
  });
});
