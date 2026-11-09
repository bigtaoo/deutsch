// FR-5.7 循环播放（变更 84）：把手机放一边，当 podcast 听。
//
// 三档，在播放条上一个键轮换：
//   · off    —— 不循环（原来的行为：放完就停）；
//   · lesson —— 本课循环：放完从头再放；
//   · group  —— 顺播本组：放完接着放同一个折叠组（课程页上那一组）里的下一课，到末尾回到组首。
//               本机没有音频的课跳过（放不出来，停在那里就等于整条断了）。
// 档位存本机 localStorage：这是「这台设备怎么用」的习惯，不是学习数据，不进备份和同步。
//
// 只有整段放到结尾（<audio> 的 'ended'）才算「放完」—— 跟读、点句播放走的是 playRange，
// 到句尾是 pause 不是 ended，不会被误接到下一课。
//
// 锁屏 / 耳机线控走 Media Session：播放、暂停、上一课、下一课。没有组的课，上一课 / 下一课退化成从头放。

import { useEffect, useSyncExternalStore } from 'react';
import { audioPlayer } from '@/audio/player';
import type { LessonAudioState } from '@/audio/useLessonAudio';
import { navigate } from '@/app/router';
import { useLessonStore } from '@/state/useLessonStore';
import type { Lesson, LessonCache } from '@/types/models';
import { groupLessons, splitChapters } from '../LessonsPage';

export type LoopMode = 'off' | 'lesson' | 'group';

export const LOOP_MODES: readonly LoopMode[] = ['off', 'lesson', 'group'];
export const LOOP_LABELS: Record<LoopMode, string> = {
  off: '不循环',
  lesson: '本课循环',
  group: '顺播本组',
};

const STORAGE_KEY = 'deutsch.loopMode';
const listeners = new Set<() => void>();

export function getLoopMode(): LoopMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'lesson' || v === 'group' ? v : 'off';
  } catch {
    return 'off';
  }
}

export function setLoopMode(mode: LoopMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 存不下（隐私模式）：这一次会话里仍然生效 —— 下面的 memo 兜着
  }
  memo = mode;
  listeners.forEach((l) => l());
}

let memo: LoopMode | null = null;
function current(): LoopMode {
  memo ??= getLoopMode();
  return memo;
}

export function nextLoopMode(mode: LoopMode): LoopMode {
  return LOOP_MODES[(LOOP_MODES.indexOf(mode) + 1) % LOOP_MODES.length];
}

export function useLoopMode(): [LoopMode, (m: LoopMode) => void] {
  const mode = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    current,
    current,
  );
  return [mode, setLoopMode];
}

/** 测试用：清掉模块里的缓存档位。 */
export function resetLoopModeForTest(): void {
  memo = null;
}

// ── 组内顺序 ─────────────────────────────────────────────────────────────

/** 这一课所在的组：名字 + 组内播放顺序（与课程页的展示顺序一致：散课在前，各章依次展开）。 */
export function groupPlaylist(lessons: readonly Lesson[], lessonId: string): { name: string; order: Lesson[] } | null {
  const { groups } = groupLessons(lessons);
  for (const [name, members] of groups) {
    if (!members.some((l) => l.id === lessonId)) continue;
    const { loose, chapters } = splitChapters(members);
    return { name, order: [...loose, ...chapters.flatMap(([, list]) => list)] };
  }
  return null;
}

/**
 * 组里的下一课（dir=1）/ 上一课（dir=-1），首尾相接。本机没有音频的课跳过；
 * 没有组、或组里只剩这一课能放 —— 返回它自己（调用方据此从头再放）。
 */
export function nextInGroup(
  lessons: readonly Lesson[],
  caches: Readonly<Record<string, LessonCache | undefined>>,
  lessonId: string,
  dir: 1 | -1 = 1,
): string {
  const group = groupPlaylist(lessons, lessonId);
  if (!group) return lessonId;
  const playable = group.order.filter((l) => l.id === lessonId || caches[l.id]?.hasAudio);
  const at = playable.findIndex((l) => l.id === lessonId);
  if (at < 0 || playable.length < 2) return lessonId;
  return playable[(at + dir + playable.length) % playable.length].id;
}

// ── 换课之后自动接着放 ──────────────────────────────────────────────────

/** 「下一课一加载好就开始放」—— 跨一次路由切换，所以挂在模块上。 */
let pendingAutoplay: string | null = null;

export function markAutoplay(lessonId: string): void {
  pendingAutoplay = lessonId;
}

export function consumeAutoplay(lessonId: string): boolean {
  if (pendingAutoplay !== lessonId) return false;
  pendingAutoplay = null;
  return true;
}

function goToLesson(target: string, from: string): void {
  if (target === from) {
    void audioPlayer.play(0);
    return;
  }
  markAutoplay(target);
  navigate({ name: 'lesson', lessonId: target, tab: 'listen' });
}

/** 通听页里调一次：接 'ended'、接「换课后自动放」、接 Media Session。 */
export function useLoopPlayback(lesson: Lesson, audio: LessonAudioState): void {
  const [mode] = useLoopMode();
  const lessons = useLessonStore((s) => s.lessons);
  const caches = useLessonStore((s) => s.caches);
  const ready = audio.status === 'ready';

  // 放完了怎么办
  useEffect(() => {
    if (!ready || mode === 'off') return;
    const el = audioPlayer.element();
    const onEnded = () => {
      if (audioPlayer.loadedLessonId !== lesson.id) return;
      if (mode === 'lesson') void audioPlayer.play(0);
      else goToLesson(nextInGroup(lessons, caches, lesson.id, 1), lesson.id);
    };
    el.addEventListener('ended', onEnded);
    return () => el.removeEventListener('ended', onEnded);
  }, [ready, mode, lesson.id, lessons, caches]);

  // 上一课放完跳过来的：音频一就绪就开始放
  useEffect(() => {
    if (ready && consumeAutoplay(lesson.id)) void audioPlayer.play(0);
  }, [ready, lesson.id]);

  // 锁屏 / 线控
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ready || !ms) return;
    const group = groupPlaylist(lessons, lesson.id);
    try {
      if (typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({ title: lesson.title, album: group?.name ?? '德语精听' });
      }
    } catch {
      // 老 WebView 没有 MediaMetadata：只是锁屏上不显示标题
    }
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // 不支持的动作会抛：忽略那一个
      }
    };
    set('play', () => void audioPlayer.play());
    set('pause', () => audioPlayer.pause());
    set('previoustrack', () => goToLesson(nextInGroup(lessons, caches, lesson.id, -1), lesson.id));
    set('nexttrack', () => goToLesson(nextInGroup(lessons, caches, lesson.id, 1), lesson.id));
    return () => {
      for (const a of ['play', 'pause', 'previoustrack', 'nexttrack'] as const) set(a, null);
    };
  }, [ready, lesson.id, lesson.title, lessons, caches]);
}
