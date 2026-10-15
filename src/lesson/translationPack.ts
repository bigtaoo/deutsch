// 变更 83 / FR-19.6：译文包 —— 整批译文一次导进来。
//
// FR-19 的「复制走 → 在外面翻 → 粘回来」是一课一课的。一季 33 集要来回 33 次，于是有了
// 这个批量的形状：在 Claude Code 会话里（用他的订阅，不花 API 额度 —— 他的 key 留给查词）
// 把整季译好，存成一个 .json，在来源页导入一次。
//
// ── 包里每句带着原文 ──
// 课是在他的设备上按 DW 文稿切的句，包是在别处切的。两边用的是同一份切句代码，但只要
// 中间有人合并/拆过句、或者 DW 改过稿，按位置对就会整篇错位一句 —— FR-19 的老话：
// **错位的译文比没有译文更糟**。所以对的是原文：按顺序往下找同样的那一句，找到才填，
// 找不到的这一句留空、指针不动。重复的短句（「Ja.」）按顺序对，不会都填成第一个。
//
// ── 只补空的 ──
// 粘回来的、手改过的一律不碰。所以导入是幂等的，先导包、后导课的那几集再导一次包就行。
//
// ── 包不进仓库 ──
// 译文是 DW 文稿的演绎作品，仓库是公开的。包只在他本机，导进来之后跟着标注层同步。

import { useLessonStore } from '@/state/useLessonStore';
import type { Lesson, Sentence } from '@/types/models';

export const PACK_FORMAT = 'deutsch-translation-pack';

export interface PackSentence {
  de: string;
  zh: string;
}

export interface PackLesson {
  /** DW 的课 id —— 按它找本地的课 */
  dwLessonId: string;
  title?: string;
  sentences: PackSentence[];
}

export interface TranslationPack {
  format: typeof PACK_FORMAT;
  version: 1;
  lessons: PackLesson[];
}

/** 解析并校验。格式不对抛错，错误信息是给人看的。 */
export function parseTranslationPack(text: string): TranslationPack {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('不是 JSON 文件');
  }
  const r = raw as Partial<TranslationPack> | null;
  if (!r || r.format !== PACK_FORMAT) throw new Error('不是译文包（format 不对）');
  if (r.version !== 1) throw new Error(`不认识的译文包版本：${String(r.version)}`);
  if (!Array.isArray(r.lessons)) throw new Error('译文包里没有 lessons');
  const lessons: PackLesson[] = [];
  for (const l of r.lessons) {
    if (!l || typeof l.dwLessonId !== 'string' || !Array.isArray(l.sentences)) continue;
    lessons.push({
      dwLessonId: l.dwLessonId,
      ...(typeof l.title === 'string' ? { title: l.title } : {}),
      sentences: l.sentences.filter(
        (s): s is PackSentence => !!s && typeof s.de === 'string' && typeof s.zh === 'string' && !!s.zh.trim(),
      ),
    });
  }
  return { format: PACK_FORMAT, version: 1, lessons };
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * 按原文顺序对：每一句从上一个对上的位置往后找同样的原文，找到才算对上。
 * 只给对上了、不是排除句、还没有译文的句子填。返回新的句子数组与填了几句。
 */
export function fillFromPack(sentences: readonly Sentence[], pack: readonly PackSentence[]): { sentences: Sentence[]; filled: number } {
  let from = 0;
  let filled = 0;
  const next = sentences.map((s) => {
    const key = norm(s.text);
    let k = from;
    while (k < pack.length && norm(pack[k].de) !== key) k++;
    if (k >= pack.length) return s;
    from = k + 1;
    if (s.excluded || s.translation?.trim()) return s;
    filled++;
    return { ...s, translation: pack[k].zh.trim() };
  });
  return { sentences: next, filled };
}

export interface PackResult {
  /** 填进了译文的课数 */
  lessons: number;
  /** 一共填了几句 */
  filled: number;
  /** 包里有、本地还没导入的课（标题，没有标题就是 id） */
  missing: string[];
}

export async function applyTranslationPack(pack: TranslationPack): Promise<PackResult> {
  const store = useLessonStore.getState();
  const result: PackResult = { lessons: 0, filled: 0, missing: [] };
  for (const entry of pack.lessons) {
    const targets = store.lessons.filter(
      (l: Lesson) => l.source.type === 'dw' && l.source.dwLessonId === entry.dwLessonId,
    );
    if (targets.length === 0) {
      result.missing.push(entry.title ?? entry.dwLessonId);
      continue;
    }
    for (const lesson of targets) {
      // 先看一眼有没有可填的：一句都填不上的课不写回，免得白白改了 updatedAt、多推一次同步
      if (fillFromPack(lesson.sentences, entry.sentences).filled === 0) continue;
      let filled = 0;
      await useLessonStore.getState().patchLesson(lesson.id, (current) => {
        const out = fillFromPack(current.sentences, entry.sentences);
        filled = out.filled;
        return { ...current, sentences: out.sentences };
      });
      if (filled > 0) {
        result.lessons++;
        result.filled += filled;
      }
    }
  }
  return result;
}
