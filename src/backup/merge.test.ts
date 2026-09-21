import { describe, expect, it } from 'vitest';
import { mergeBackup, mergeLessons, mergeSettings, mergeVocabEntries } from './merge';
import { DEFAULT_SETTINGS } from '@/db/meta';
import type { Lesson, Settings, VocabEntry } from '@/types/models';

function lesson(overrides: Partial<Lesson>): Lesson {
  return {
    id: 'l1',
    title: 'Local Title',
    source: { type: 'manual' },
    sentences: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function vocab(overrides: Partial<VocabEntry>): VocabEntry {
  return {
    id: 'v1',
    surface: 'Wort',
    contextSentence: 'Ein Wort.',
    lessonId: 'l1',
    sentenceIndex: 0,
    hasTimestamp: false,
    suspended: false,
    fsrs: {
      due: 0,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: 0,
    },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('mergeLessons', () => {
  it('adds a lesson that only exists in incoming', () => {
    const { merged, summary } = mergeLessons([], [lesson({ id: 'new' })]);
    expect(merged.map((l) => l.id)).toEqual(['new']);
    expect(summary.addedLessons).toEqual(['new']);
  });

  it('keeps local when local is newer, and records it as skipped', () => {
    const local = lesson({ id: 'l1', updatedAt: 100, title: 'Newer local' });
    const incoming = lesson({ id: 'l1', updatedAt: 50, title: 'Older incoming' });
    const { merged, summary } = mergeLessons([local], [incoming]);
    expect(merged[0].title).toBe('Newer local');
    expect(summary.skippedLessons).toEqual(['l1']);
    expect(summary.updatedLessons).toEqual([]);
  });

  it('overwrites local when incoming is newer, and names the overwritten title', () => {
    const local = lesson({ id: 'l1', updatedAt: 50, title: 'Old local title' });
    const incoming = lesson({ id: 'l1', updatedAt: 100, title: 'New incoming title' });
    const { merged, summary } = mergeLessons([local], [incoming]);
    expect(merged[0].title).toBe('New incoming title');
    expect(summary.updatedLessons).toEqual(['l1']);
    expect(summary.overwrittenLessonTitles).toEqual(['Old local title']);
  });

  it('leaves lessons that only exist locally untouched', () => {
    const localOnly = lesson({ id: 'local-only' });
    const { merged, summary } = mergeLessons([localOnly], []);
    expect(merged).toEqual([localOnly]);
    expect(summary.addedLessons).toEqual([]);
    expect(summary.updatedLessons).toEqual([]);
    expect(summary.skippedLessons).toEqual([]);
  });
});

describe('mergeVocabEntries', () => {
  it('adds a vocab entry that only exists in incoming', () => {
    const { merged, summary } = mergeVocabEntries([], [vocab({ id: 'new' })]);
    expect(merged.map((v) => v.id)).toEqual(['new']);
    expect(summary.addedVocab).toEqual(['new']);
  });

  it('picks the entry with the newer fsrs.last_review, not the newer updatedAt', () => {
    const local = vocab({
      id: 'v1',
      updatedAt: 9999, // 故意让 updatedAt 更新但 last_review 更旧
      fsrs: { ...vocab({}).fsrs, last_review: 10 },
    });
    const incoming = vocab({
      id: 'v1',
      updatedAt: 1,
      fsrs: { ...vocab({}).fsrs, last_review: 20 },
    });
    const { merged, summary } = mergeVocabEntries([local], [incoming]);
    expect(merged[0].fsrs.last_review).toBe(20);
    expect(summary.updatedVocab).toEqual(['v1']);
  });

  it('keeps local when local last_review is newer', () => {
    const local = vocab({ id: 'v1', fsrs: { ...vocab({}).fsrs, last_review: 20 } });
    const incoming = vocab({ id: 'v1', fsrs: { ...vocab({}).fsrs, last_review: 10 } });
    const { merged, summary } = mergeVocabEntries([local], [incoming]);
    expect(merged[0].fsrs.last_review).toBe(20);
    expect(summary.skippedVocab).toEqual(['v1']);
  });

  // ── FR-21：一条词条上挂着两张卡，合并要看两张 ──
  it('读卡的复习记录也算「动过」—— 只看听卡会静默丢掉桌面上做的那一轮', () => {
    // 桌面：只复习了读卡（fsrsRead 变新，fsrs 没动）
    const desktop = vocab({
      id: 'v1',
      updatedAt: 5,
      fsrs: { ...vocab({}).fsrs, last_review: 10 },
      fsrsRead: { ...vocab({}).fsrs, last_review: 30 },
    });
    // 手机：之后复习了听卡，但还没收到桌面那一份
    const phone = vocab({ id: 'v1', updatedAt: 6, fsrs: { ...vocab({}).fsrs, last_review: 20 } });

    const { merged } = mergeVocabEntries([phone], [desktop]);
    expect(merged[0].fsrsRead?.last_review).toBe(30);
  });

  it('两张卡都没复习过时照旧退到 updatedAt', () => {
    const local = vocab({ id: 'v1', updatedAt: 1, fsrsRead: { ...vocab({}).fsrs } });
    const incoming = vocab({ id: 'v1', updatedAt: 2, fsrsRead: { ...vocab({}).fsrs } });
    const { merged } = mergeVocabEntries([local], [incoming]);
    expect(merged[0].updatedAt).toBe(2);
  });

  it('老备份里没有 fsrsRead —— 合并不因此崩，也不误判成「动过」', () => {
    const alt = vocab({ id: 'v1', updatedAt: 1 }); // 早于 FR-21 的那份
    const neu = vocab({ id: 'v1', updatedAt: 2, fsrsRead: { ...vocab({}).fsrs, last_review: 50 } });
    expect(mergeVocabEntries([alt], [neu]).merged[0].fsrsRead?.last_review).toBe(50);
    expect(mergeVocabEntries([neu], [alt]).merged[0].fsrsRead?.last_review).toBe(50);
  });

  it('treats missing last_review on both sides as a tie and breaks it via updatedAt', () => {
    const local = vocab({ id: 'v1', updatedAt: 1 });
    const incoming = vocab({ id: 'v1', updatedAt: 2 });
    const { merged, summary } = mergeVocabEntries([local], [incoming]);
    expect(merged[0].updatedAt).toBe(2);
    expect(summary.updatedVocab).toEqual(['v1']);
  });
});

describe('mergeBackup', () => {
  it('combines lesson and vocab summaries into one report', () => {
    const local = { lessons: [lesson({ id: 'l1', updatedAt: 100 })], vocab: [] as VocabEntry[] };
    const incoming = {
      lessons: [lesson({ id: 'l2', updatedAt: 1 })],
      vocab: [vocab({ id: 'v1' })],
    };
    const { lessons, vocab: mergedVocab, summary } = mergeBackup(local, incoming);
    expect(lessons.map((l) => l.id).sort()).toEqual(['l1', 'l2']);
    expect(mergedVocab.map((v) => v.id)).toEqual(['v1']);
    expect(summary.addedLessons).toEqual(['l2']);
    expect(summary.addedVocab).toEqual(['v1']);
  });
});

describe('mergeSettings（§0 变更 28：整体 last-write-wins）', () => {
  const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

  it('导入的那份更新 → 整体胜出', () => {
    const local = settings({ newPerDay: 10, updatedAt: 100 });
    const incoming = settings({ newPerDay: 30, updatedAt: 200 });
    const { merged, changed } = mergeSettings(local, incoming);
    expect(changed).toBe(true);
    expect(merged.newPerDay).toBe(30);
  });

  it('本地更新 → 一个字段都不动', () => {
    const local = settings({ newPerDay: 10, updatedAt: 300 });
    const incoming = settings({ newPerDay: 30, updatedAt: 200 });
    const { merged, changed } = mergeSettings(local, incoming);
    expect(changed).toBe(false);
    expect(merged.newPerDay).toBe(10);
  });

  it('updatedAt 缺失（老库、从没改过设置）算最旧，任何真实改动都赢过它', () => {
    const fresh = settings({ presetBand: 6, updatedAt: 1 });
    expect(mergeSettings(settings(), fresh).changed).toBe(true);
    // 反过来：本地改过、远端还是老库那份 → 本地留着
    expect(mergeSettings(fresh, settings()).changed).toBe(false);
  });

  it('同一毫秒时保留本地 —— 确定性优先', () => {
    const local = settings({ newPerDay: 10, updatedAt: 500 });
    const incoming = settings({ newPerDay: 30, updatedAt: 500 });
    expect(mergeSettings(local, incoming).merged.newPerDay).toBe(10);
  });

  it('mergeBackup 顺带把设置一起合并，并在 summary 里报出来', () => {
    const base = { lessons: [] as Lesson[], vocab: [] as VocabEntry[] };
    const result = mergeBackup(
      { ...base, settings: settings({ reviewPerDay: 60, updatedAt: 1 }) },
      { ...base, settings: settings({ reviewPerDay: 90, updatedAt: 2 }) },
    );
    expect(result.settings?.reviewPerDay).toBe(90);
    expect(result.summary.settingsUpdated).toBe(true);
  });

  it('调用方不给设置时 mergeBackup 照常跑 —— settings 为 undefined，不误报改过', () => {
    const result = mergeBackup({ lessons: [], vocab: [] }, { lessons: [], vocab: [] });
    expect(result.settings).toBeUndefined();
    expect(result.summary.settingsUpdated).toBe(false);
  });
});

describe('mergeBackup：学习记录（FR-18）', () => {
  const base = { lessons: [] as Lesson[], vocab: [] as VocabEntry[] };

  it('不是 last-write-wins，而是逐格取 max —— 两台设备的时长都保住', () => {
    const result = mergeBackup(
      { ...base, studyLog: { days: { '2026-09-15': { a: 900 } }, updatedAt: 9 } },
      { ...base, studyLog: { days: { '2026-09-15': { b: 420 } }, updatedAt: 1 } },
    );
    // 本地的 updatedAt 更大，但远端那一格照样合进来了
    expect(result.studyLog?.days['2026-09-15']).toEqual({ a: 900, b: 420 });
    expect(result.summary.studyUpdated).toBe(true);
  });

  it('老备份文件没有这一项时，本机那份原样留着', () => {
    const local = { days: { '2026-09-15': { a: 900 } }, updatedAt: 9 };
    const result = mergeBackup({ ...base, studyLog: local }, { ...base });
    expect(result.studyLog).toEqual(local);
    expect(result.summary.studyUpdated).toBe(false);
  });

  it('空设备导入带记录的备份 —— 整份收下', () => {
    const incoming = { days: { '2026-09-15': { a: 900 } }, updatedAt: 9 };
    const result = mergeBackup({ ...base }, { ...base, studyLog: incoming });
    expect(result.studyLog).toEqual(incoming);
    expect(result.summary.studyUpdated).toBe(true);
  });
});
