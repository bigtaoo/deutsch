// 今天还剩几个（FR-22.17）：导航角标与单词页的今日卡片共用这一份数。
//
// drill 状态每次落库都会通知（`onDrillStateChange`），所以背一个词、同步拉下来一批进度、
// 课程词自动加进来，角标都跟着变，不用刷新。

import { useEffect, useState } from 'react';
import { DAILY_TARGET, dayProgress, localDate as localDateOf, planDay, remainingToday, type DayProgress } from './daily';
import { getDrillState, onDrillStateChange, updateDrillState, withDay } from './state';
import type { CachedWordbank, DrillState, PoolItem } from './types';
import { buildPool, getCachedWordbank } from './wordbank';

export interface DrillToday {
  loaded: boolean;
  state: DrillState | null;
  wordbank: CachedWordbank | undefined;
  pool: PoolItem[];
  /** 今天的计划已经排好时才有；还没排时页面显示估算。 */
  progress: DayProgress | null;
  /** 还剩几个 —— 有计划按计划数，没有就估一个。 */
  remaining: number;
  target: number;
}

export function useDrillToday(): DrillToday {
  const [state, setState] = useState<DrillState | null>(null);
  const [wordbank, setWordbank] = useState<CachedWordbank | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [s, wb] = await Promise.all([getDrillState(), getCachedWordbank()]);
      if (!alive) return;
      setState(s);
      setWordbank(wb);
      setLoaded(true);
    };
    void load().catch(() => setLoaded(true));
    const off = onDrillStateChange((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const pool = state ? buildPool(wordbank, state) : [];
  const now = Date.now();
  const progress = state ? dayProgress(state, new Set(pool.map((p) => p.id)), now) : null;
  const remaining = state ? remainingToday(pool, state, now) : 0;
  return { loaded, state, wordbank, pool, progress, remaining, target: DAILY_TARGET };
}

/**
 * 排（或补足）今天的计划并落库。开始背之前调一次；当天已经满 200 时什么都不写。
 * 返回落库后的状态。
 */
export async function ensureToday(wordbank: CachedWordbank | undefined, now: number = Date.now()): Promise<DrillState> {
  return updateDrillState((s) => {
    const ids = planDay(buildPool(wordbank, s), s, now);
    return ids ? withDay(s, { date: localDateOf(now), ids }, now) : s;
  });
}
