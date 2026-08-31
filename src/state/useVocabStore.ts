// 生词本（FR-7 标记 / FR-9 管理 / FR-10 复习状态）。
//
// Blank 与 VocabEntry 是一对孪生：Blank 住在 Lesson.sentences 里（标注层，跟课走），
// VocabEntry 住在 vocab store 里（跟词走）。两边靠 Blank.vocabEntryId 互指。
// 所有会同时动到这两处的操作都收在这个文件里，免得某天只删了一半。

import { create } from 'zustand';
import {
  deleteVocabEntry,
  findVocabEntriesBySurface,
  getAllVocabEntries,
  putVocabEntry,
} from '@/db/vocab';
import { useLessonStore } from './useLessonStore';
import { generateId } from '@/lib/id';
import { newCard } from '@/srs/fsrs';
import { surfaceOf, type Range } from '@/lesson/tokens';
import type { Blank, Lesson, Sentence, VocabEntry } from '@/types/models';

export interface CreateFromSelectionInput {
  lesson: Lesson;
  sentence: Sentence;
  ranges: Range[];
  /** FR-14.3：来自 Glossar 候选时一并带上，省掉手工填 */
  prefill?: Partial<Pick<VocabEntry, 'lemma' | 'gender' | 'plural' | 'meaning' | 'dwKnowledgeId'>>;
}

interface VocabState {
  entries: VocabEntry[];
  loaded: boolean;

  load: () => Promise<void>;

  /** FR-9.3：新建前按 surface 全库匹配（大小写不敏感）。命中就把选择权交给用户。 */
  findDuplicates: (surface: string) => Promise<VocabEntry[]>;

  /** FR-7.3：标记 → 在句上建 Blank + 建 VocabEntry 草稿。 */
  createFromSelection: (input: CreateFromSelectionInput) => Promise<VocabEntry>;

  /** FR-9.3「合并到已有条目」：新句上照样挖空，但指向那个已存在的词条。 */
  attachToExisting: (input: CreateFromSelectionInput & { entryId: string }) => Promise<void>;

  updateEntry: (entry: VocabEntry) => Promise<void>;

  /** FR-7.5：取消挖空；deleteEntry=true 时连词条一起删。 */
  removeBlank: (lessonId: string, sentenceIndex: number, blankId: string, deleteEntry: boolean) => Promise<void>;

  removeEntry: (id: string) => Promise<void>;
}

/** 同一句上的挖空不允许区间重叠 —— 否则听写题面会出现套娃的空。 */
function overlapsExistingBlank(sentence: Sentence, ranges: Range[]): boolean {
  return sentence.blanks.some((b) =>
    b.ranges.some((existing) => ranges.some((r) => r.start < existing.end && existing.start < r.end)),
  );
}

/**
 * 挖空写在 Lesson 记录上，所以必须用 patchLesson 读最新的那一份：
 * 「全部接受」候选词是个串行循环，用调用方传进来的 lesson 连写 20 次，
 * 结果是只留下最后一条。
 */
async function addBlankToLesson(
  lessonId: string,
  sentenceIndex: number,
  blank: Blank,
): Promise<void> {
  await useLessonStore.getState().patchLesson(lessonId, (current) => ({
    ...current,
    sentences: current.sentences.map((s) =>
      s.index === sentenceIndex ? { ...s, blanks: [...s.blanks, blank] } : s,
    ),
  }));
}

export const useVocabStore = create<VocabState>((set, get) => ({
  entries: [],
  loaded: false,

  load: async () => {
    set({ entries: await getAllVocabEntries(), loaded: true });
  },

  findDuplicates: async (surface) => findVocabEntriesBySurface(surface),

  createFromSelection: async ({ lesson, sentence, ranges, prefill }) => {
    if (overlapsExistingBlank(sentence, ranges)) {
      throw new Error('选中的词已经在另一个挖空里了');
    }
    const now = Date.now();
    const entry: VocabEntry = {
      id: generateId(),
      surface: surfaceOf(sentence.text, ranges),
      lemma: prefill?.lemma,
      gender: prefill?.gender,
      plural: prefill?.plural,
      meaning: prefill?.meaning,
      contextSentence: sentence.text, // 只存本地，永不进 ShareablePackage（§3.1）
      lessonId: lesson.id,
      sentenceIndex: sentence.index,
      dwKnowledgeId: prefill?.dwKnowledgeId,
      // §3.3 R2：允许来自未标注句，此时是「无音频卡」，复习界面要显式说明并给补标注入口。
      hasTimestamp: sentence.startTime !== undefined,
      suspended: false,
      fsrs: newCard(new Date(now)),
      createdAt: now,
      updatedAt: now,
    };

    await putVocabEntry(entry);
    await addBlankToLesson(lesson.id, sentence.index, {
      id: generateId(),
      ranges,
      surface: entry.surface,
      vocabEntryId: entry.id,
    });
    set({ entries: [...get().entries, entry] });
    return entry;
  },

  attachToExisting: async ({ lesson, sentence, ranges, entryId }) => {
    if (overlapsExistingBlank(sentence, ranges)) {
      throw new Error('选中的词已经在另一个挖空里了');
    }
    await addBlankToLesson(lesson.id, sentence.index, {
      id: generateId(),
      ranges,
      surface: surfaceOf(sentence.text, ranges),
      vocabEntryId: entryId,
    });
    // 词条本身不动：合并的语义是「这是同一个词」，不是「用新语境覆盖旧语境」。
    // Q3 记录了这个已知局限：V1 一个词条只挂一个 contextSentence。
  },

  updateEntry: async (entry) => {
    const next = { ...entry, updatedAt: Date.now() };
    await putVocabEntry(next);
    set({ entries: get().entries.map((e) => (e.id === next.id ? next : e)) });
  },

  removeBlank: async (lessonId, sentenceIndex, blankId, deleteEntry) => {
    const lessonStore = useLessonStore.getState();
    const lesson = lessonStore.lessons.find((l) => l.id === lessonId);
    if (!lesson) return;

    const blank = lesson.sentences[sentenceIndex]?.blanks.find((b) => b.id === blankId);
    await lessonStore.patchLesson(lessonId, (current) => ({
      ...current,
      sentences: current.sentences.map((s) =>
        s.index === sentenceIndex ? { ...s, blanks: s.blanks.filter((b) => b.id !== blankId) } : s,
      ),
    }));

    if (deleteEntry && blank) await get().removeEntry(blank.vocabEntryId);
  },

  removeEntry: async (id) => {
    await deleteVocabEntry(id);
    set({ entries: get().entries.filter((e) => e.id !== id) });
  },
}));

/** FR-7.4：名词没填性等于没记。列表里标黄用这个判断。 */
export function needsGender(entry: VocabEntry): boolean {
  if (entry.gender) return false;
  const head = entry.lemma ?? entry.surface;
  // 德语名词首字母大写；多词搭配不强求（`hing ... ab` 不是名词）。
  return /^\p{Lu}/u.test(head) && !head.includes(' ');
}
