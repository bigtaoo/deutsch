// 变更 82 / FR-19.11：一课的逐句中译交给服务器上的 AI（`POST /v1/ai/translate`），
// 写进标注层的 `Sentence.translation` —— 与 FR-19 粘回来的译文是同一个字段、同一套显示。
//
// ── 只补没有译文的句子 ──
// 粘回来的、手改过的译文一律不碰：自动的那一份不该覆盖人做过的事。所以「让 AI 译」
// 天然是幂等的 —— 一课全有译文时一个请求都不发。
//
// ── 一个串行的后台队列 ──
// 整季导入一次 33 集，每集导完就排进来；同一时间只问一课，免得 33 个请求一齐打到
// 服务器（那边是一个 Haiku key，没有并发的必要）。离开来源页也照样跑完 —— 队列在模块里。
//
// ── 写回时按 index + 原文双重核对 ──
// 问一次要十几秒，这期间这一课可能被对齐写回过（对齐那边已经改成以最新的为底，见
// align/client.ts saveOutcome）、也可能被合并/拆分过句子。所以写回时重读最新的那份，
// 只给 index 与原文都还对得上、且仍然没有译文的句子填 —— 对不上的宁可留空（FR-19.2：
// 错位的译文比没有译文更糟）。
//
// ── 失败就算了 ──
// 与 gloss.ts 同一条：没登录、服务器没开 AI、模型条数对不上，都静默跳过这一课。
// 界面上的入口（译文页的「让 AI 译」）会把错误原因说出来，那里是用户主动点的。

import { syncFetch } from '@/sync/client';
import { getSessionToken } from '@/sync/session';
import { useLessonStore } from '@/state/useLessonStore';
import type { Sentence } from '@/types/models';
import { aiAvailable } from './explain';

/** 一次请求最多多少句（服务端 TRANSLATE_MAX_LINES 是 120，留点余量）。 */
export const TRANSLATE_BATCH = 100;

export interface TranslateLine {
  speaker?: string;
  text: string;
}

/** 问一批。返回与输入一一对应的中文。 */
export async function translateWithAi(lines: TranslateLine[], title?: string): Promise<string[]> {
  const token = await getSessionToken();
  if (!token) throw new Error('尚未登录，无法使用 AI');
  const { translations } = await syncFetch<{ translations: string[] }>('/v1/ai/translate', {
    method: 'POST',
    body: { lines, ...(title ? { title } : {}) },
    token,
  });
  return translations;
}

/** 这一句要不要译：不是排除句、有字、还没有译文。 */
function wantsTranslation(s: Sentence): boolean {
  return !s.excluded && !!s.text.trim() && !s.translation?.trim();
}

/** 这一课还有几句没有译文（排除句不算）。 */
export function untranslatedCount(sentences: readonly Sentence[]): number {
  return sentences.filter(wantsTranslation).length;
}

export interface TranslateResult {
  /** 这次新填上译文的句数 */
  translated: number;
}

/**
 * 给一课补上没有的译文。失败**抛错**（调用方决定说不说出来）；课不存在、
 * 全都有译文时返回 0 句、不发请求。
 */
export async function translateLessonWithAi(lessonId: string): Promise<TranslateResult> {
  const lesson = useLessonStore.getState().lessons.find((l) => l.id === lessonId);
  if (!lesson) return { translated: 0 };
  const targets = lesson.sentences.filter(wantsTranslation);
  let translated = 0;
  for (let i = 0; i < targets.length; i += TRANSLATE_BATCH) {
    const batch = targets.slice(i, i + TRANSLATE_BATCH);
    const zh = await translateWithAi(
      batch.map((s) => ({ ...(s.speaker ? { speaker: s.speaker } : {}), text: s.text.replace(/\s+/g, ' ').trim() })),
      lesson.title,
    );
    const byIndex = new Map<number, { text: string; zh: string }>();
    batch.forEach((s, j) => {
      const t = zh[j]?.trim();
      if (t) byIndex.set(s.index, { text: s.text, zh: t });
    });
    let filled = 0;
    await useLessonStore.getState().patchLesson(lessonId, (current) => ({
      ...current,
      sentences: current.sentences.map((s) => {
        const hit = byIndex.get(s.index);
        if (!hit || hit.text !== s.text || s.translation?.trim()) return s;
        filled++;
        return { ...s, translation: hit.zh };
      }),
    }));
    translated += filled;
  }
  return { translated };
}

const queue: string[] = [];
let draining: Promise<void> | null = null;

/** 排进后台队列。已经在排的不重复排；没登录/没开 AI 时整队静默丢掉。 */
export function queueLessonTranslation(lessonIds: readonly string[]): Promise<void> {
  for (const id of lessonIds) if (!queue.includes(id)) queue.push(id);
  if (!draining) {
    draining = (async () => {
      try {
        while (queue.length > 0) {
          if (!(await aiAvailable())) {
            queue.length = 0;
            return;
          }
          const id = queue.shift()!;
          try {
            await translateLessonWithAi(id);
          } catch {
            // 见文件头「失败就算了」
          }
        }
      } finally {
        draining = null;
      }
    })();
  }
  return draining;
}

/** 测试用。 */
export function __resetTranslationQueue(): void {
  queue.length = 0;
  draining = null;
}
