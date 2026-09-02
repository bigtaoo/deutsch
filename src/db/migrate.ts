// 老库迁移：把 §0 变更 27 之前存在缓存层的东西搬到标注层。
//
// 为什么值得写这一段（`wordTimings` 那次就没写）：**这一份没有别的补救路径。**
// 词级时间戳丢了可以「重新对齐」拿回来，而候选词只有两条路 ——
// 要么走 FR-3.5「补齐素材」重抓一遍页面（连带重下 6~10MB 音频），
// 要么就没了。而候选词里带着「还没接受哪些」这个待办，属于不该静默消失的东西。
//
// 迁移是**幂等**的：只搬「课程里没有、缓存里有」的那些，搬完不删缓存里那份
// （缓存层本来可弃，留着无害；FR-3.8 清缓存时自然带走）。

import { putLesson } from './lessons';
import type { Lesson, LessonCache } from '@/types/models';

/** 老 LessonCache 里可能还留着的字段。类型上已经删掉了，所以这里显式描述。 */
interface LegacyCache extends LessonCache {
  glossary?: Lesson['glossary'];
}

export interface LayerMigration {
  /** 迁移后的课程数组（没有需要迁移的就是原数组本身，引用不变） */
  lessons: Lesson[];
  /** 实际改过的课程 id —— 调用方据此排同步，否则这份数据到不了别的设备 */
  changed: string[];
}

/**
 * 候选词：`LessonCache.glossary` → `Lesson.glossary`（§0 变更 27）。
 *
 * `updatedAt` 要动 —— 不动的话同步那边比不出新旧，另一台设备的旧版本会赢回来。
 * 迁移只加数据不改别的字段，所以在 §2.4 的「较新者整体胜出」下赢是安全的。
 */
export async function migrateGlossaryIntoLessons(
  lessons: Lesson[],
  caches: LessonCache[],
): Promise<LayerMigration> {
  const byId = new Map(caches.map((c) => [c.lessonId, c as LegacyCache]));
  const changed: string[] = [];

  const next = await Promise.all(
    lessons.map(async (lesson) => {
      if (lesson.glossary !== undefined) return lesson;
      const legacy = byId.get(lesson.id)?.glossary;
      if (!legacy || legacy.length === 0) return lesson;
      const migrated: Lesson = { ...lesson, glossary: legacy, updatedAt: Date.now() };
      await putLesson(migrated);
      changed.push(lesson.id);
      return migrated;
    }),
  );

  return { lessons: changed.length > 0 ? next : lessons, changed };
}
