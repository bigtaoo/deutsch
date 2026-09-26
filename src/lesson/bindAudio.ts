// FR-3.6 / FR-3.6a / FR-1.8：给手动导入的课绑本地音频 —— 单课与整组两个入口共用这一份。
//
// 手动导入的课音频不同步（它来自本机磁盘，没有下载地址），所以换一台设备总要再选一次文件。
// 这件事以前有两个问题：
//   1. 绑完**无条件**重对齐 —— 桌面对好、同步过来的时间戳，在手机上被送去服务器再算两分钟、
//      原样盖回去。和变更 43 是同一类问题，只是这条路 DW 的课不走，所以之前没暴露。
//   2. 拼过的课（一个 Aufgabe 好几轨）要按同一顺序、同一批文件重新拼，否则时长对不上。

import { useLessonStore, type AttachOutcome } from '@/state/useLessonStore';
import { useAlignStore } from '@/state/useAlignStore';
import { hasTimings } from '@/align/apply';
import { concatAudioFiles, pickListedFiles } from '@/audio/concat';
import type { Lesson } from '@/types/models';

/** 这一课当初用的是哪几个文件（按拼接顺序）。只记了一个名字或一个都没记时返回它能给的。 */
export function listedAudioFiles(lesson: Lesson): string[] {
  if (lesson.source.type !== 'manual') return [];
  if (lesson.source.audioFiles && lesson.source.audioFiles.length > 0) return lesson.source.audioFiles;
  return lesson.source.audioFileName ? [lesson.source.audioFileName] : [];
}

/** 是不是几轨拼起来的课 —— 是的话选文件时要多选，并且按清单认。 */
export function isMultiTrack(lesson: Lesson): boolean {
  return listedAudioFiles(lesson).length > 1;
}

/** FR-3.6a：绑完之后要不要重新对齐。只有「压根没有时间戳」和「换了一份音频」才值得。 */
export function shouldRealign(lesson: Lesson, outcome: AttachOutcome): boolean {
  return !hasTimings(lesson.sentences) || outcome.audioChanged;
}

export type BindResult =
  | { ok: true; outcome: AttachOutcome; realigned: boolean; method: 'bytes' | 'wav'; fileName: string }
  | { ok: false; missing: string[] };

/**
 * 把选中的文件绑到这一课上。拼过的课按清单挑文件、按清单顺序拼；缺哪个就原样报出来，
 * 不将就 —— 少一轨拼出来整段时间戳都会错位。
 */
export async function bindPickedAudio(lesson: Lesson, picked: File[]): Promise<BindResult> {
  let files: File[];
  if (isMultiTrack(lesson)) {
    const { files: listed, missing } = pickListedFiles(picked, listedAudioFiles(lesson));
    if (missing.length > 0) return { ok: false, missing };
    files = listed;
  } else {
    // 单个文件的课：多选了一堆时优先认记着的那个名字，认不出就用第一个（和以前单选的行为一样）。
    const wanted = listedAudioFiles(lesson)[0];
    const match = wanted ? picked.find((f) => f.name === wanted) : undefined;
    const first = match ?? picked[0];
    if (!first) return { ok: false, missing: wanted ? [wanted] : [] };
    files = [first];
  }

  const { file, method } = await concatAudioFiles(files);
  const outcome = await useLessonStore.getState().attachAudio(lesson.id, file);
  const realigned = shouldRealign(lesson, outcome);
  if (realigned) useAlignStore.getState().enqueue(lesson.id);
  return { ok: true, outcome, realigned, method, fileName: file.name };
}

/**
 * 整组补音频：一次选一整个文件夹的 mp3，每一课按自己记着的文件名认领。
 * 只返回**全部文件都在**的那些课；文件名一个都没记过的课（很老的手动导入）不参与，
 * 只能在它自己的课程页里手动选。
 */
export function matchGroupFiles(
  lessons: readonly Lesson[],
  picked: readonly File[],
): { matched: Array<{ lesson: Lesson; files: File[] }>; unmatched: Lesson[] } {
  const names = new Set(picked.map((f) => f.name));
  const matched: Array<{ lesson: Lesson; files: File[] }> = [];
  const unmatched: Lesson[] = [];
  for (const lesson of lessons) {
    const wanted = listedAudioFiles(lesson);
    if (wanted.length > 0 && wanted.every((n) => names.has(n))) {
      matched.push({ lesson, files: wanted.map((n) => picked.find((f) => f.name === n)!) });
    } else {
      unmatched.push(lesson);
    }
  }
  return { matched, unmatched };
}
