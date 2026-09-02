// 自动对齐的**全局**任务状态。
//
// 为什么不放在页面组件里（原来的 AutoAlignPanel 就是那样）：一课的对齐在手机上要跑
// 几分钟到十几分钟，而这段时间里人一定会切页面 —— 去看别的课、去复习、去设置里翻。
// 状态挂在组件里就意味着「一切页面进度条就消失」，看起来跟卡死没有区别。
// 放在 store 里，进度条可以常驻在应用底部（AlignBar），谁也不用等在原地。
//
// 队列只有一条并发：两个对齐同时跑各自要一份 187MB 权重，手机上必死。

import { create } from 'zustand';
import { AlignWorkerDeath, alignLesson, cancelAlignment, isAligning } from '@/align/client';
import { PLAN_LADDER } from '@/align/config';
import { reviewQueue } from '@/align/apply';
import { allPlansCrashed, detectCrash, type AlignRunRecord } from '@/align/journal';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import type { AlignProgress } from '@/align/align';

export interface AlignTask {
  lessonId: string;
  title: string;
}

export interface AlignDone extends AlignTask {
  applied: number;
  /** 置信度偏低、值得亲耳确认的句数 */
  review: number;
  seconds: number;
}

interface AlignState {
  current: (AlignTask & { progress: AlignProgress; startedAt: number }) | null;
  queue: AlignTask[];
  lastDone: AlignDone | null;
  lastError: (AlignTask & { message: string }) | null;
  /** 上次运行被系统杀掉的证据（启动时从黑匣子里探出来） */
  crash: AlignRunRecord | null;
  /** 两档后端都崩过：不再自动跑，只留手动 */
  blocked: boolean;

  init: () => void;
  /**
   * 排一课进队列。同一课已在跑或已在队里就什么都不做（幂等，可以随便调）。
   *
   * manual = 用户自己点的按钮：无视「导入后自动对齐」这个开关，也无视 blocked
   * （两档都崩过之后自动跑会停，但人非要试一次是他的权利）。
   */
  enqueue: (lessonId: string, options?: { manual?: boolean }) => void;
  cancel: () => void;
  dismiss: () => void;
}

/** init() 的一次性闸门。见 init 里那段关于 StrictMode 的注释。 */
let initialized = false;

export const useAlignStore = create<AlignState>((set, get) => ({
  current: null,
  queue: [],
  lastDone: null,
  lastError: null,
  crash: null,
  blocked: false,

  init: () => {
    // **必须真的只跑一次。** detectCrash() 有副作用（把那条 running 记录归档成 crashed），
    // 所以第二次调用一定返回 null —— React 的 StrictMode 在开发模式下会把 effect 调两遍，
    // 于是「上次被系统杀掉了」那条黄条被第二遍用 null 覆盖，一次都没能显示出来。
    // 实测就是这样丢的：记录归档正常，界面上什么都没有。
    if (initialized) return;
    initialized = true;
    set({ crash: detectCrash(), blocked: allPlansCrashed(PLAN_LADDER.length) });
  },

  enqueue: (lessonId, options = {}) => {
    const lesson = useLessonStore.getState().lessons.find((l) => l.id === lessonId);
    if (!lesson) return;
    if (!options.manual) {
      if (get().blocked) return;
      // FR-15 的那个开关还在（设置页）。默认开 —— 「下载完就能直接练」是这个功能的全部意义。
      if (!useSettingsStore.getState().settings.autoAlignOnImport) return;
    }
    const { current, queue } = get();
    if (current?.lessonId === lessonId || queue.some((t) => t.lessonId === lessonId)) return;
    set({
      queue: [...queue, { lessonId, title: lesson.title }],
      lastError: null,
    });
    void drain();
  },

  cancel: () => {
    // 队列也一起清掉：点「停止」的意思是「现在别跑」，不是「跳过这一课接着跑下一课」。
    set({ queue: [] });
    cancelAlignment();
  },

  dismiss: () => set({ lastDone: null, lastError: null, crash: null }),
}));

/** 串行泵。任何时刻只有一个在跑 —— 由 isAligning() 与这里的队列共同保证。 */
async function drain(): Promise<void> {
  if (isAligning() || useAlignStore.getState().current) return;

  for (;;) {
    const [task, ...rest] = useAlignStore.getState().queue;
    if (!task) return;

    // 队列里只存 id：课程随时可能被改（甚至删），要用最新那一份。
    const lesson = useLessonStore.getState().lessons.find((l) => l.id === task.lessonId);
    if (!lesson) {
      // 课被删了。静默跳过 —— 这不是错误。
      useAlignStore.setState({ queue: rest });
      continue;
    }

    const startedAt = Date.now();
    useAlignStore.setState({
      queue: rest,
      current: { ...task, startedAt, progress: { stage: 'decode' } },
      lastError: null,
    });

    try {
      const result = await alignLesson(lesson, (progress) => {
        const { current } = useAlignStore.getState();
        if (current?.lessonId === task.lessonId) {
          useAlignStore.setState({ current: { ...current, progress } });
        }
      });
      useAlignStore.setState({
        current: null,
        lastDone: {
          ...task,
          applied: result.applied,
          review: reviewQueue(result.sentences).length,
          seconds: Math.round((Date.now() - startedAt) / 1000),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useAlignStore.setState({
        current: null,
        // 取消不是失败，别在界面上摆一条红条。
        lastError: message === '已取消' ? null : { ...task, message },
      });
      // Worker 被系统杀掉：client.ts 已经把它记进黑匣子的 crashed 计数，
      // 所以队列里的下一课会自动落到更保守的一档（pickPlan ← nextPlanStep）—— 让它接着跑。
      // 但**两档都崩过之后必须停**：那时 nextPlanStep() 会回到第 0 档，
      // 而 blocked 只在 init() 算过一次，不在这里重算的话，
      // 本次会话里这个队列就成了「每课杀一次进程」的循环 —— 正是 FR-15.10 要防的那个。
      if (err instanceof AlignWorkerDeath) {
        const blocked = allPlansCrashed(PLAN_LADDER.length);
        useAlignStore.setState(blocked ? { blocked, queue: [] } : { blocked });
        if (blocked) return;
      }
    }
  }
}

/** 界面文案：现在到哪一步了。 */
export function stageLabel(progress: AlignProgress): string {
  switch (progress.stage) {
    case 'decode':
      return '解码音频';
    case 'model':
      return '加载对齐模型';
    case 'infer':
      return '识别音频';
    case 'align':
      return '对齐文本';
    case 'apply':
      return '写入时间戳';
  }
}
