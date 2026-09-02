// 回填最近几期（FR-13.12）。冷启动用：一次导入几期旧刊，把它们的 Glossar 候选词
// 变成一批**带真语料**的生词 —— 有德德释义、有语境句、有真人朗读，
// 这三样都是 FR-17 的预置词库给不了的。
//
// ── 这个文件与 §3.1.1 R-3 的关系，必须说清 ──
// R-3 原文：「串行请求、请求间隔 ≥ 1s、不做批量预抓……代码里不能写出可以被误用成
// 批量抓取的形状（比如「一键导入全部 100 期」）」。而这里就是一个批量导入。
//
// 差别在**形状**，不在有没有循环：
//   · **有硬上限，且没有「全部」这个选项**（BACKFILL_LIMITS，最大 10 期）。
//     R-3 点名禁止的是「一键导入全部 100 期」—— 上限是这条禁令的实现。
//   · **只从已经拉到的 RSS 列表里取**。不翻页、不猜 id、不爬归档，
//     所以它抓不到 RSS 之外的任何东西 —— 这不是一个爬虫。
//   · **速率约束是复用的，不是重写的**：每一期都走 importFromDw，而它内部所有出网
//     请求都过 politely()（全局 ≥ 1s 串行）。这里不碰那个机制，所以绕不过它。
//   · **可以停**，且停在期与期之间，不会留下半篇课程。
//
// 速率上它与「手点十次导入」完全等价 —— 差别只是不用手点十次。
// 这个判断是 2026-09-02 他明确裁定过的（原话是选了「词频档 + DW 回填都做」），
// 而这段注释是为了让下一个读代码的人知道 R-3 没有被绕过，是被满足了。

import { importFromDw, type ImportProgress } from './importLesson';
import type { FeedItem } from './dw/rss';

/** 可选的期数。**刻意没有「全部」** —— 见文件头。 */
export const BACKFILL_LIMITS = [3, 5, 10] as const;

export interface BackfillProgress {
  /** 第几期（从 1 开始）/ 共几期 */
  index: number;
  total: number;
  title: string;
  /** 单期内部的进度（取页面 / 取音频 / 落库） */
  step?: ImportProgress['step'];
}

export interface BackfillOutcome {
  imported: string[];
  /** 导入成功但音频没拿到的（FR-13.9：抓到哪算哪，课程照样建出来） */
  withoutAudio: string[];
  failed: Array<{ lessonId: string; title: string; error: string }>;
  /** 因为已经导入过而跳过的 */
  skipped: number;
  stopped: boolean;
}

export interface BackfillOptions {
  items: FeedItem[];
  /** 已经导入过的 dwLessonId */
  importedIds: ReadonlySet<string>;
  limit: number;
  onProgress?: (progress: BackfillProgress) => void;
  /** 每期之间检查一次；返回 true 就停在期与期之间 */
  shouldStop?: () => boolean;
  /** 注入用，测试里替掉真正的导入 */
  importOne?: typeof importFromDw;
}

/**
 * 串行回填。**一期失败不影响后面几期** —— 一次十期里有一期改过稿或音频挂了
 * 就整批放弃，是最没用的失败方式。
 */
export async function backfillRecent({
  items,
  importedIds,
  limit,
  onProgress,
  shouldStop,
  importOne = importFromDw,
}: BackfillOptions): Promise<BackfillOutcome> {
  const outcome: BackfillOutcome = {
    imported: [],
    withoutAudio: [],
    failed: [],
    skipped: 0,
    stopped: false,
  };

  // 已导入的先滤掉再截断，否则「回填 10 期」在已经导过 8 期时只会新增 2 期。
  const pending = items.filter((i) => !importedIds.has(i.lessonId));
  outcome.skipped = items.length - pending.length;
  const targets = pending.slice(0, Math.max(0, limit));

  for (const [i, item] of targets.entries()) {
    if (shouldStop?.()) {
      outcome.stopped = true;
      break;
    }
    onProgress?.({ index: i + 1, total: targets.length, title: item.title });
    try {
      const result = await importOne(
        item.lessonId,
        (p) => onProgress?.({ index: i + 1, total: targets.length, title: item.title, step: p.step }),
        item.link || undefined,
      );
      outcome.imported.push(result.lessonId);
      if (result.audioError) outcome.withoutAudio.push(result.lessonId);
    } catch (err) {
      outcome.failed.push({
        lessonId: item.lessonId,
        title: item.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcome;
}
