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
import { newCardShortfall } from '@/srs/queue';
import { surfaceOf, type Range } from '@/lesson/tokens';
import { normalizeKey } from '@/dict/bucket';
import { dedupeKey, loadDeck, lookupDict } from '@/dict/lookup';
import { pickPresetWords } from '@/dict/preset';
import { prefetchWordAudio } from '@/dict/audio';
import { lookupOnline } from '@/dict/online';
import { useSettingsStore } from './useSettingsStore';
import type { DictEntry } from '@/dict/types';
import type { Blank, Lesson, Sentence, VocabEntry } from '@/types/models';

/**
 * 一个词条的去重键（FR-9.3）。
 *
 * 用 `lemma ?? surface` 而不是每次去查词典：查词是异步的，而这个键在渲染路径上
 * 会被成百上千次地算（生词本列表、预置词挑选）。词条建立时就把词典查出来的
 * lemma 存进去了，所以这里读它就够；没有 lemma 的老词条退回 surface ——
 * 那正是 V1 的行为，不是新的退化。
 */
export function vocabKey(entry: VocabEntry): string {
  return normalizeKey(entry.lemma ?? entry.surface);
}

/** 把词典查到的东西摊成 VocabEntry 的那几个字段。取第一个义项 —— 它已经按「有释义优先」排过。 */
function fieldsFromDict(entry: DictEntry): Pick<VocabEntry, 'lemma' | 'gender' | 'plural' | 'meaning' | 'ipa'> {
  const s = entry.s[0];
  // 释义优先德语：FR-14 在 DW 的 Glossar 上已经得出过这个结论（德德释义比中文更适合 C1）。
  // 中文放在括号里跟着，而不是取代它 —— 一个都不给才是真的不方便。
  const de = s?.de?.[0];
  const zh = s?.zh?.slice(0, 2).join('、');
  const en = s?.en?.slice(0, 2).join(', ');
  const meaning = [de, zh ? `（${zh}）` : en ? `(${en})` : ''].filter(Boolean).join(' ') || undefined;
  return {
    lemma: entry.w,
    gender: s?.g,
    plural: s?.pl,
    ipa: s?.ipa,
    meaning,
  };
}

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

  /**
   * FR-17.4：把**今天缺的新卡**从已报名的档里补上（惰性激活）。返回真的建出来的条目。
   *
   * 「报名一整档」不等于「建一整档的卡」—— 第 4 档是 3000 个词，那要 60 次
   * MediaWiki 往返和 100MB 以上的录音。所以报名只写一条设置，卡在这里按天发。
   *
   * 四件事必须在这里一起做完，缺一件卡就是坏的：
   *   ① 查内置词典拿释义/性/复数 —— 词典是缓存层、可重建，而卡不可重建，
   *      所以要把值**拷进**卡里，不能让卡运行时再去查（§2.3）。
   *   ② 词典查不到的词直接跳过，不建空卡 —— 卡背空白的卡没有任何用处。
   *   ③ 取发音。激活发生在打开复习页的那一刻，那时**通常**在线；
   *      而复习本身按 §2.1 是在碎片时间、很可能没网时做的。
   *   ④ 顺手把**下一批**的发音也下下来（不建卡）。这样明天的激活可以完全离线完成。
   */
  topUpNewCards: (
    onProgress?: (phase: 'picking' | 'audio', done: number, total: number) => void,
  ) => Promise<{ added: VocabEntry[]; skipped: number; human: number }>;

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

  findDuplicates: async (surface) => {
    // FR-9.3 修订：**按词元键匹配，不再只按 surface。**
    // 原文写「V1 无 lemma，只能靠 surface 匹配；`gelaufen` 与 `laufen` 匹配不上是
    // 已知且接受的局限」—— FR-16 的词形索引把这条局限修掉了。
    //
    // 两个来源并起来而不是只用新的：老词条没有 lemma，它们的键退回 surface，
    // 而 surface 匹配那条路还能抓到「词典里查不到的词」（生僻复合词、多词搭配）。
    const key = await dedupeKey(surface);
    const byKey = get().entries.filter((e) => vocabKey(e) === key);
    const bySurface = await findVocabEntriesBySurface(surface);
    const seen = new Set(byKey.map((e) => e.id));
    return [...byKey, ...bySurface.filter((e) => !seen.has(e.id))];
  },

  createFromSelection: async ({ lesson, sentence, ranges, prefill }) => {
    if (overlapsExistingBlank(sentence, ranges)) {
      throw new Error('选中的词已经在另一个挖空里了');
    }
    const now = Date.now();
    const surface = surfaceOf(sentence.text, ranges);

    // FR-7.4：能自动填的就自动填。
    //
    // **DW 的 Glossar（prefill）优先级更高**，词典只补它没给的字段：
    // FR-14 那一节的判断是「这是 DW 为这篇素材选的词、给的是语境内的释义」，
    // 而词典给的是脱离语境的通用释义。用词典覆盖 prefill 会把更好的那份换掉。
    //
    // 内置词典查不到时才联网（FR-16.5）。顺序不能反：本地查是同步开销，
    // 联网查要一个来回，而绝大多数词本地就有。
    // prefill 齐全时连本地都不查 —— Glossar 已经给了性、复数和语境释义。
    const needsLookup = !prefill?.meaning || !prefill?.gender;
    let auto: Partial<Pick<VocabEntry, 'lemma' | 'gender' | 'plural' | 'meaning' | 'ipa'>> = {};
    if (needsLookup) {
      const dictHit = await lookupDict(surface).catch(() => null);
      if (dictHit) auto = fieldsFromDict(dictHit.entry);
      else if (useSettingsStore.getState().settings.onlineDictFallback) {
        const online = await lookupOnline(surface).catch(() => null);
        if (online) auto = fieldsFromDict(online);
      }
    }

    const entry: VocabEntry = {
      id: generateId(),
      surface,
      lemma: prefill?.lemma ?? auto.lemma,
      gender: prefill?.gender ?? auto.gender,
      plural: prefill?.plural ?? auto.plural,
      meaning: prefill?.meaning ?? auto.meaning,
      ipa: auto.ipa,
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

  topUpNewCards: async (onProgress) => {
    const { settings } = useSettingsStore.getState();
    // `?? []` 不是多余的：从旧备份恢复出来的 settings 里没有这个字段
    const bands = settings.enrolledBands ?? [];
    const empty = { added: [] as VocabEntry[], skipped: 0, human: 0 };
    if (bands.length === 0) return empty;

    const count = newCardShortfall(get().entries, { newPerDay: settings.newPerDay });
    const taken = new Set(get().entries.map(vocabKey));
    // 已经够了也别直接走：下一批的发音还是要预取（那是这个函数的第 ④ 件事）。
    const picks = count > 0 ? await pickPresetWords(bands, taken, count, loadDeck) : [];

    const added: VocabEntry[] = [];
    let skipped = 0;
    for (const [i, pick] of picks.entries()) {
      onProgress?.('picking', i + 1, picks.length);
      const hit = await lookupDict(pick.w);
      // 牌组是从词典产出的，所以查不到基本只会发生在「词典没部署」的情况下
      // （web 版首次、或者 public/dict/ 没跟着构建走）。跳过而不是建空卡。
      if (!hit) {
        skipped++;
        continue;
      }
      const now = Date.now();
      const entry: VocabEntry = {
        id: generateId(),
        surface: hit.entry.w,
        ...fieldsFromDict(hit.entry),
        // 没有 lessonId / sentenceIndex / contextSentence —— 这张卡不来自任何课程。
        preset: { band: pick.band, rank: pick.r },
        // 预置卡的声音来自 Wiktionary 录音或 TTS，与「来源句有没有时间戳」无关。
        // 置 false 是如实记账；卡面靠 cardAudioStatus 走 'preset-word' 那一档说明来源。
        hasTimestamp: false,
        suspended: false,
        fsrs: newCard(new Date(now)),
        createdAt: now,
        updatedAt: now,
      };
      await putVocabEntry(entry);
      added.push(entry);
    }
    set({ entries: [...get().entries, ...added] });

    let human = 0;
    if (added.length > 0) {
      const result = await prefetchWordAudio(
        added.map((e) => e.surface),
        (done, total) => onProgress?.('audio', done, total),
      );
      human = result.human;
    }

    // ④ 预取下一批的发音，**不建卡**。
    //
    // 不建卡是关键：多建出来的卡会挤掉课上标的生词（它们同为新卡且优先），
    // 而多下几个发音只占几百 KB 缓存、丢了还能重下。
    // 不 await：它对「今天能不能练」没有影响，让界面先动起来。
    const nextTaken = new Set([...taken, ...added.map(vocabKey)]);
    void pickPresetWords(bands, nextTaken, settings.newPerDay, loadDeck)
      .then((ahead) => (ahead.length ? prefetchWordAudio(ahead.map((p) => p.w)) : undefined))
      .catch(() => {
        // 离线或 Wiktionary 抽风：明天激活时会再试一次。不打扰用户。
      });

    return { added, skipped, human };
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
