// FR-22.14：课程里的新词自动进速背（变更 84）。
//
// 打开一课时跑一次：这一课有时间戳（对齐过）才跑 —— 候选要挂在某一句上，卡背才能放原句（FR-22.16）。
// 判据沿用 FR-9.13 的本课生词候选（src/lesson/vocabCandidates.ts）：减掉常见词、已有的、标过认识的。
// 只收**词典查到的**（found）；查不到的多半是复合词或人名，没有词性和中文可依。
//
// 中文：词典第一条 → 缺的一批问 AI（`/v1/ai/gloss`，按原句译，最多 GLOSS_BATCH 个）→ 仍然没有的不进池
// —— 没有中文就出不了「中文四选一」的题。
//
// 每课只跑一次，记在本机 meta 里（不同步：另一台设备打开同一课再跑一遍，加的是同一批 id，
// withCustom 按 id 覆盖，结果一样）。已经在词库里的词不另加 —— 与查词「加入速背」同一条规矩。

import { aiAvailable } from '@/ai/explain';
import { GLOSS_BATCH, glossWithAi } from '@/ai/gloss';
import { getMeta, putMeta } from '@/db/meta';
import { normalizeKey } from '@/dict/bucket';
import { loadDeck, lookupDict } from '@/dict/lookup';
import { COMMON_BANDS, findCandidates, type CandidateDeps } from '@/lesson/vocabCandidates';
import type { DictPos } from '@/dict/types';
import type { Lesson } from '@/types/models';
import { getDrillState, updateDrillState, withCustom } from './state';
import type { DrillPos } from './types';
import { customItemId, findInWordbank, getCachedWordbank } from './wordbank';

const HARVESTED_KEY = 'drillHarvested';

export interface Common {
  keys: Set<string>;
  forms: Set<string>;
}
let commonPromise: Promise<Common> | null = null;

/**
 * 「常见」的两份表：牌组 1~3 档的词元（约 260KB）+ 前一万的词形（约 100KB）。整个会话只取一次。
 * 不看 res.ok（SPA 回退给 200 + HTML），靠 parse 判。
 */
export function loadCommon(): Promise<Common> {
  commonPromise ??= (async () => {
    const [decks, forms] = await Promise.all([
      Promise.all(COMMON_BANDS.map((id) => loadDeck(id))),
      fetch('/dict/common-forms.json')
        .then((r) => r.text())
        .then((t) => JSON.parse(t) as string[])
        .catch(() => [] as string[]),
    ]);
    const keys = new Set<string>();
    for (const deck of decks) for (const w of deck?.words ?? []) keys.add(normalizeKey(w.w));
    const result = { keys, forms: new Set(Array.isArray(forms) ? forms : []) };
    // 缺了哪一份（词典没部署、断网）：别缓存，下次再试
    if (keys.size === 0 || result.forms.size === 0) commonPromise = null;
    return result;
  })();
  return commonPromise;
}

export function toDrillPos(pos: DictPos | undefined): DrillPos {
  return pos === 'noun' || pos === 'verb' || pos === 'adj' || pos === 'adv' ? pos : 'other';
}

export interface HarvestDeps {
  lookup: CandidateDeps['lookup'];
  common: () => Promise<Common>;
  gloss: (items: { word: string; context?: string }[]) => Promise<string[]>;
  aiAvailable: () => Promise<boolean>;
  knownWords: readonly string[];
}

const defaultDeps = (knownWords: readonly string[]): HarvestDeps => ({
  lookup: lookupDict,
  common: loadCommon,
  gloss: glossWithAi,
  aiAvailable,
  knownWords,
});

export type HarvestResult = { status: 'skipped' } | { status: 'done'; added: number };

/** 这一课跑过没有。 */
async function harvested(): Promise<Record<string, true>> {
  return (await getMeta<Record<string, true>>(HARVESTED_KEY)) ?? {};
}

/**
 * 跑一课。没时间戳、常见词表没拿到、已经跑过 —— 都返回 skipped，且不记「跑过了」
 * （前两种下次还要再试）。
 */
export async function harvestLesson(
  lesson: Lesson,
  knownWords: readonly string[] = [],
  deps: HarvestDeps = defaultDeps(knownWords),
  now: number = Date.now(),
): Promise<HarvestResult> {
  if ((await harvested())[lesson.id]) return { status: 'skipped' };
  if (!lesson.sentences.some((s) => s.startTime !== undefined)) return { status: 'skipped' };
  const common = await deps.common();
  if (common.keys.size === 0 || common.forms.size === 0) return { status: 'skipped' };

  const [state, bank] = await Promise.all([getDrillState(), getCachedWordbank()]);
  const taken = new Set(
    Object.values(state.custom)
      .filter((c) => !c.deleted)
      .map((c) => normalizeKey(c.w)),
  );
  const result = await findCandidates(lesson, {
    lookup: deps.lookup,
    commonKeys: common.keys,
    commonForms: common.forms,
    takenKeys: taken,
    knownKeys: new Set(deps.knownWords),
  });
  if (!result.timed) return { status: 'skipped' };

  const rows: { word: string; pos: DrillPos; g?: 'm' | 'f' | 'n'; zh: string; si: number }[] = [];
  for (const c of result.found) {
    if (findInWordbank(bank, c.headword)) continue;
    const hit = await deps.lookup(c.headword).catch(() => null);
    const sense = hit?.entry.s[0];
    rows.push({ word: c.headword, pos: toDrillPos(sense?.p), g: c.gender, zh: sense?.zh?.[0]?.trim() ?? '', si: c.sentenceIndex });
  }

  const missing = rows.filter((r) => !r.zh).slice(0, GLOSS_BATCH);
  if (missing.length > 0 && (await deps.aiAvailable().catch(() => false))) {
    try {
      const glosses = await deps.gloss(missing.map((r) => ({ word: r.word, context: lesson.sentences[r.si]?.text })));
      missing.forEach((r, i) => (r.zh = glosses[i]?.trim() ?? ''));
    } catch {
      // 问不到：这几个这次不进池。整课仍记「跑过了」—— 不为几个词每次打开都问一遍 AI。
    }
  }

  const ok = rows.filter((r) => r.zh);
  if (ok.length > 0) {
    await updateDrillState((s) =>
      ok.reduce(
        (acc, r, i) =>
          withCustom(
            acc,
            { id: customItemId(r.word), w: r.word, p: r.pos, g: r.g, zh: r.zh, src: 'lesson', lessonId: lesson.id, si: r.si },
            now + i,
          ),
        s,
      ),
    );
  }
  await putMeta(HARVESTED_KEY, { ...(await harvested()), [lesson.id]: true });
  return { status: 'done', added: ok.length };
}
