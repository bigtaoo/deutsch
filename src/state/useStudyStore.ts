import { create } from 'zustand';
import { getStudyLog, emptyStudyLog, type StudyLog } from '@/study/log';
import { computeStudyStats, type StudyStats } from '@/study/stats';
import { studyClock } from '@/study/tracker';
import { scheduleStudySync } from '@/sync/trigger';

interface StudyState {
  log: StudyLog;
  stats: StudyStats;
  loaded: boolean;
  load: () => Promise<void>;
}

/**
 * FR-18：学习记录在内存里的那一份。
 *
 * 和别的 store 有一处不同：**它自己不写库**。写库的是计时器（study/tracker.ts），
 * 每 30 秒一次；这个 store 只在计时器落完库之后重读。这样「谁在写这份数据」
 * 只有一个答案 —— 界面上任何地方都不该能把学习时长改掉。
 */
export const useStudyStore = create<StudyState>((set) => ({
  log: emptyStudyLog(),
  stats: computeStudyStats(emptyStudyLog()),
  loaded: false,

  load: async () => {
    const log = await getStudyLog();
    set({ log, stats: computeStudyStats(log), loaded: true });
  },
}));

/**
 * 把计时器接到 store 和同步上。App 启动时调一次。
 *
 * 落库之后才推同步（去抖 60s）：推的是库里那份，顺序反了会把还没落库的秒数漏掉。
 */
export function connectStudyClock(): void {
  studyClock.setHooks({
    onFlushed: () => {
      void useStudyStore.getState().load();
      scheduleStudySync();
    },
  });
}
