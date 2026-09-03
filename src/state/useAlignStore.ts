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
import { nativeEmissionsAvailable } from '@/align/nativeEmissions';
import { reviewQueue } from '@/align/apply';
import { allPlansCrashed, detectCrash, type AlignRunRecord } from '@/align/journal';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import type { AlignProgress } from '@/align/align';

export interface AlignTask {
  lessonId: string;
  title: string;
  /**
   * 人自己点的，还是导入流程排进来的。
   *
   * 这一位现在**决定手机上跑不跑**（变更 33）：iOS 原生壳上自动对齐不再启动，
   * 只有手动那一次才跑。理由不是「怕崩」——原生这条路是稳的 —— 而是**时长**：
   * 一课十几分钟，而 iOS 默认 30 秒到 2 分钟就锁屏，锁屏或切走 App 之后进程被挂起，
   * 带着 400MB 常驻被挂起的进程又正是 jetsam 最先挑的那一个。
   * 也就是说自动跑在手机上十有八九跑不完，只是白热一台机器。
   */
  manual?: boolean;
}

export interface AlignDone extends AlignTask {
  applied: number;
  /** 置信度偏低、值得亲耳确认的句数 */
  review: number;
  seconds: number;
}

interface AlignState {
  /**
   * `inferStartedAt` 是**推理那一段**开始的时刻，不是整次运行的开始。
   * 分开记是为了算「还要多久」：前面那两段（过桥 + 解码 + 加载 230MB 权重）在手机上
   * 要几分钟，把它们摊进「每块平均耗时」会让预估离谱地偏大。
   *
   * `inferStartedChunk` 是那一刻**已经算完几块**了。断点续算（变更 33）之后它不一定是 0：
   * 续算时第一条事件报的是「第 13/27 块」，拿 13 去除刚过去的两秒会算出一个荒谬的速度，
   * 于是「还要多久」会说出「约还需 4 秒」这种话。只有这一段里新算完的块才能当样本。
   */
  current:
    | (AlignTask & {
        progress: AlignProgress;
        startedAt: number;
        inferStartedAt?: number;
        inferStartedChunk?: number;
      })
    | null;
  queue: AlignTask[];
  lastDone: AlignDone | null;
  lastError: (AlignTask & { message: string }) | null;
  /** 上次运行被系统杀掉的证据（启动时从黑匣子里探出来） */
  crash: AlignRunRecord | null;
  /** 两档后端都崩过：不再自动跑，只留手动 */
  blocked: boolean;
  /**
   * emissions 由原生插件算（iOS，变更 31）。界面要这一位是因为
   * **崩溃记录会比壳活得久**：黄条里那句「下一次会降一档重试」在这台设备上已经不对了，
   * 下一次根本不进 WebView。
   */
  native: boolean;

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
  native: false,

  init: () => {
    // **必须真的只跑一次。** detectCrash() 有副作用（把那条 running 记录归档成 crashed），
    // 所以第二次调用一定返回 null —— React 的 StrictMode 在开发模式下会把 effect 调两遍，
    // 于是「上次被系统杀掉了」那条黄条被第二遍用 null 覆盖，一次都没能显示出来。
    // 实测就是这样丢的：记录归档正常，界面上什么都没有。
    if (initialized) return;
    initialized = true;
    set({ crash: detectCrash(), blocked: allPlansCrashed(PLAN_LADDER.length) });
    // 原生那一档不在阶梯上，所以「阶梯全崩过」不该拦它 —— 否则这台 iPhone 上
    // 自动对齐会因为几条旧壳留下的崩溃记录永远不再启动。
    void nativeEmissionsAvailable().then((native) => {
      if (native) set({ native: true, blocked: false });
    });
  },

  enqueue: (lessonId, options = {}) => {
    const lesson = useLessonStore.getState().lessons.find((l) => l.id === lessonId);
    if (!lesson) return;
    if (!options.manual) {
      if (get().blocked) return;
      // 手机上不自动跑（变更 33）。**这个判断必须是设备本地的** ——
      // autoAlignOnImport 是同步项（sync/docs.ts），把它设成 false 会传染到桌面，
      // 而桌面上一课 26 秒，那里自动跑是完全对的。
      // 课程页会明确说「这一课还没有时间戳」并给出两个出路（AlignStatus）。
      if (get().native) return;
      // FR-15 的那个开关还在（设置页）。默认开 —— 「下载完就能直接练」是这个功能的全部意义。
      if (!useSettingsStore.getState().settings.autoAlignOnImport) return;
    }
    const { current, queue } = get();
    if (current?.lessonId === lessonId || queue.some((t) => t.lessonId === lessonId)) return;
    set({
      queue: [...queue, { lessonId, title: lesson.title, manual: options.manual }],
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

    // 手机那道闸门在这里**再问一次**。enqueue 里问的是 store 里的 `native`，
    // 而它由 init() 异步填（要过一次原生桥）—— 启动后立刻导入的话那一位可能还是 false。
    // 这里问的是真身，且它有缓存，所以不花钱。
    if (!task.manual && (await nativeEmissionsAvailable())) {
      useAlignStore.setState({ queue: rest, native: true });
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
          // 第一条 infer 事件报的是「已经算完几块」（分母已知、这一块还没算），
          // 正好是计时起点。续算时它是 13 而不是 0，所以基线要连块号一起记。
          const first = progress.stage === 'infer' && current.inferStartedAt === undefined;
          useAlignStore.setState({
            current: {
              ...current,
              progress,
              inferStartedAt: first ? Date.now() : current.inferStartedAt,
              inferStartedChunk: first ? (progress.chunk ?? 0) : current.inferStartedChunk,
            },
          });
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
