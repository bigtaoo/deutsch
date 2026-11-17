// 把「IndexedDB 里的音频 Blob」接到「单例 <audio>」上的 React 胶水。
//
// 所有需要出声的 tab 都用这个 hook，谁都不许自己 new Audio()（§3.2）。
// 卸载时**不** unload：切 tab 不该把音频卸掉，换课时 audioPlayer.load 自己会 revoke 旧的 objectURL。

import { useEffect, useState } from 'react';
import { getAudioBlob } from '@/db/cache';
import { useLessonStore } from '@/state/useLessonStore';
import { audioPlayer } from './player';

export interface LessonAudioState {
  status: 'loading' | 'ready' | 'missing' | 'error';
  error: string | null;
  duration: number;
}

/**
 * `hasAudio` 进依赖数组（§0 变更 34）：这个 hook 原来只在挂载时读一次 Blob，
 * 于是「素材是在这一页上补齐的」这条路走不通 —— FR-3.5a 让打开一课就自动补齐，
 * 音频到位时这一页早就挂载完了，播放条会一直停在「素材未下载」，
 * 要切走再切回来才活。同一个陈旧读也发生在启动那一下：store 还没读完 caches 时
 * 挂载的话，第一次读 Blob 可能空手而归。
 */
export function useLessonAudio(lessonId: string): LessonAudioState {
  const [state, setState] = useState<LessonAudioState>({ status: 'loading', error: null, duration: 0 });
  const hasAudio = useLessonStore((s) => Boolean(s.caches[lessonId]?.hasAudio));

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', error: null, duration: 0 });

    void (async () => {
      const blob = await getAudioBlob(lessonId);
      if (cancelled) return;
      if (!blob) {
        setState({ status: 'missing', error: null, duration: 0 });
        return;
      }
      try {
        await audioPlayer.load(lessonId, blob);
        if (cancelled) return;
        setState({ status: 'ready', error: null, duration: audioPlayer.duration });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err), duration: 0 });
      }
    })();

    return () => {
      cancelled = true;
      audioPlayer.pause();
    };
  }, [lessonId, hasAudio]);

  return state;
}

/**
 * 订阅播放位置。
 *
 * 默认每帧发一次（逐词高亮要的就是这个频率）。但「每帧 setState」会把订阅者
 * 整棵子树每秒重渲染 60 次，而需要这个频率的只有逐词高亮那一处 ——
 * 变更 93 实测过：播放时每秒强制同步布局 60 次，文本**折叠**着也一样，
 * 因为通听页无条件订阅、而它底下挂着播放条和一整列句子。
 *
 * 两个闸门：
 * - `enabled: false` —— 这一刻根本用不到播放位置（文本折叠时的通听页）：不订阅。
 * - `quantizeMs` —— 把时间量化到这个粒度再 setState。落在同一格里的值相等，
 *   React 自己 bail out，不重渲染。时间码只要 0.1 秒一档，那就是 10Hz 而不是 60Hz。
 */
export function useAudioTime({
  enabled = true,
  quantizeMs = 0,
}: { enabled?: boolean; quantizeMs?: number } = {}): number {
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    if (quantizeMs <= 0) return audioPlayer.subscribe(setTime);
    const step = quantizeMs / 1000;
    return audioPlayer.subscribe((t) => {
      const q = Math.floor(t / step) * step;
      // 返回 prev 就是「没变」：React 认出同一个值，这一帧不重渲染。
      setTime((prev) => (Math.abs(prev - q) < step / 2 ? prev : q));
    });
  }, [enabled, quantizeMs]);
  return time;
}

/** 播放/暂停状态。<audio> 的 play/pause 事件是唯一可靠来源，别自己维护一个布尔量。 */
export function useAudioPlaying(): boolean {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const el = audioPlayer.element();
    const onPlay = () => setPlaying(true);
    const onStop = () => setPlaying(false);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onStop);
    el.addEventListener('ended', onStop);
    setPlaying(!el.paused);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onStop);
      el.removeEventListener('ended', onStop);
    };
  }, []);
  return playing;
}
