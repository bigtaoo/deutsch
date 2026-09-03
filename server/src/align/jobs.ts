// 对齐任务队列。
//
// ── 为什么是「任务」而不是一个同步请求 ──
// 一课要一两分钟。如果做成「POST 进去、等着、拿矩阵」，那手机就必须在这一两分钟里
// 一直握着这个连接 —— 而**手机握不住**：锁屏、切走 App、地铁里换基站，任一件事
// 都会掐掉连接，然后一两分钟的计算白扔。这正是变更 33 在手机本地对齐上撞的那面墙，
// 换到服务器上如果还用同步请求，墙一点没变矮。
//
// 拆成「提交 → 轮询 → 取结果」之后：上传是几秒的事（那段手机握得住），
// 之后**计算在服务器上继续跑**，手机可以锁屏、可以退出 App，回来再问一次就好。
// 顺带白拿两样：进度（界面要的 chunk/chunks 就是它）和取消。
//
// ── 为什么串行 ──
// 一份权重 230MB + 推理峰值，4 vCPU。并行两个任务不会更快（intra-op 已经吃了 3 个线程），
// 只会把峰值内存翻倍 —— 而这台机器上还跑着别人的 mssql。所以一次一个，其余排队。
//
// ── 结果放内存 ──
// 一份 3MB，取走即删，TTL 兜底。落盘反而要处理「谁来清」，而这条服务的数据目录
// 是备份用的，不该混进临时产物。

import { randomUUID } from 'node:crypto';
import { Cancelled, type EmissionsResult, type Engine, type EngineProgress } from './engine.ts';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

interface Job {
  id: string;
  userId: string;
  createdAt: number;
  /** 完成/失败/取消的时刻 —— TTL 从这里算，排队和计算再久也不会被扫掉。 */
  settledAt?: number;
  status: JobStatus;
  stage?: EngineProgress['stage'];
  chunk?: number;
  chunks?: number;
  audio?: Uint8Array;
  extension: string;
  bytes: number;
  result?: EmissionsResult;
  error?: string;
  cancelRequested: boolean;
}

export interface JobView {
  id: string;
  status: JobStatus;
  stage?: EngineProgress['stage'];
  chunk?: number;
  chunks?: number;
  /** 排队时前面还有几个（含正在跑的那个）。0 = 下一个就是它。 */
  queuePosition?: number;
  frames?: number;
  vocabSize?: number;
  duration?: number;
  error?: string;
  createdAt: number;
}

export interface JobQueueOptions {
  engine: Engine;
  /** 排队上限（不含正在跑的那个）。满了就 429 —— 一个人用的服务，堆积没有意义。 */
  maxQueued: number;
  /** 结束之后留多久。留着是为了「手机切走十分钟再回来取」这条路。 */
  ttlMs: number;
  now?: () => number;
}

export interface JobQueue {
  submit(userId: string, audio: Uint8Array, extension: string): { id: string } | { error: string };
  view(userId: string, id: string): JobView | null;
  /** 取结果。**取走即删** —— 一份 3MB，客户端拿到就没有第二次要它的理由。 */
  takeResult(userId: string, id: string): EmissionsResult | null;
  cancel(userId: string, id: string): boolean;
  stats(): { queued: number; running: number };
}

export function createJobQueue(options: JobQueueOptions): JobQueue {
  const now = options.now ?? Date.now;
  const jobs = new Map<string, Job>();
  const waiting: string[] = [];
  let running = false;

  const sweep = (): void => {
    const t = now();
    for (const [id, job] of jobs) {
      if (job.settledAt !== undefined && t - job.settledAt > options.ttlMs) jobs.delete(id);
    }
  };

  const settle = (job: Job, status: JobStatus, error?: string): void => {
    job.status = status;
    job.error = error;
    job.settledAt = now();
    job.audio = undefined; // 7MB，跑完立刻放掉
  };

  const pump = (): void => {
    if (running) return;
    const id = waiting.shift();
    if (id === undefined) return;
    const job = jobs.get(id);
    if (!job) return pump(); // 已经被取消并删掉了
    if (job.cancelRequested) {
      settle(job, 'cancelled');
      return pump();
    }

    running = true;
    job.status = 'running';
    const audio = job.audio!;
    void options.engine
      .compute(
        audio,
        job.extension,
        (p) => {
          job.stage = p.stage;
          job.chunk = p.chunk;
          job.chunks = p.chunks;
        },
        () => job.cancelRequested,
      )
      .then(
        (result) => {
          job.result = result;
          settle(job, 'done');
        },
        (err: unknown) => {
          if (err instanceof Cancelled) settle(job, 'cancelled');
          else settle(job, 'error', err instanceof Error ? err.message : String(err));
        },
      )
      .finally(() => {
        running = false;
        pump();
      });
  };

  const owned = (userId: string, id: string): Job | null => {
    const job = jobs.get(id);
    // 不是自己的任务一律当「不存在」—— 别把「这个 id 存在」这件事漏给别人。
    return job && job.userId === userId ? job : null;
  };

  return {
    submit(userId, audio, extension) {
      sweep();
      if (waiting.length >= options.maxQueued) {
        return { error: `排队已满（${options.maxQueued} 个），等前面的跑完再来` };
      }
      const id = randomUUID();
      jobs.set(id, {
        id,
        userId,
        createdAt: now(),
        status: 'queued',
        audio,
        extension,
        bytes: audio.byteLength,
        cancelRequested: false,
      });
      waiting.push(id);
      pump();
      return { id };
    },

    view(userId, id) {
      sweep();
      const job = owned(userId, id);
      if (!job) return null;
      const view: JobView = {
        id: job.id,
        status: job.status,
        stage: job.stage,
        chunk: job.chunk,
        chunks: job.chunks,
        error: job.error,
        createdAt: job.createdAt,
      };
      if (job.status === 'queued') {
        view.queuePosition = waiting.indexOf(id) + (running ? 1 : 0);
      }
      if (job.result) {
        view.frames = job.result.frames;
        view.vocabSize = job.result.vocabSize;
        view.duration = job.result.duration;
      }
      return view;
    },

    takeResult(userId, id) {
      const job = owned(userId, id);
      if (!job || job.status !== 'done' || !job.result) return null;
      const result = job.result;
      jobs.delete(id);
      return result;
    },

    cancel(userId, id) {
      const job = owned(userId, id);
      if (!job) return false;
      job.cancelRequested = true;
      if (job.status === 'queued') {
        const at = waiting.indexOf(id);
        if (at >= 0) waiting.splice(at, 1);
        settle(job, 'cancelled');
      }
      // 正在跑的那个由 engine 在下一个块边界自己停下（isCancelled）。
      return true;
    },

    stats() {
      return { queued: waiting.length, running: running ? 1 : 0 };
    },
  };
}
