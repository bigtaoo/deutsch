// 任务队列。routes.test.ts 已经从 HTTP 那一侧走过一遍，这里补的是**队列自己的语义** ——
// 那些从路由上看不清、但会在真实使用里出问题的：
//
//   · 串行：一份权重 230MB + 推理峰值，并行只会把内存翻倍（那台机器上还跑着别人的东西）；
//   · 排位：手机上显示的「前面还有 N 个」；
//   · TTL：结果留着是为了「切走十分钟再回来取」，但不能永远留；
//   · 隔离：别人的任务一律当不存在，连「这个 id 存在」都不漏。

import { describe, expect, it, vi } from 'vitest';
import { createJobQueue } from './jobs.ts';
import { Cancelled, type EmissionsResult, type Engine } from './engine.ts';

function result(frames = 10): EmissionsResult {
  return {
    frames,
    vocabSize: 35,
    duration: frames * 0.02,
    logProbs: new Float32Array(frames * 35),
  };
}

/** 手动控制每次 compute 何时结束 —— 队列的时序全靠它才验得了。 */
function controllableEngine() {
  const pending: Array<{
    resolve: (r: EmissionsResult) => void;
    reject: (e: unknown) => void;
    progress: (p: { stage: 'decode' | 'infer'; chunk?: number; chunks?: number }) => void;
    isCancelled: () => boolean;
  }> = [];
  const engine: Engine = {
    compute: vi.fn(
      (_audio, _ext, progress, isCancelled) =>
        new Promise<EmissionsResult>((resolve, reject) => {
          pending.push({
            resolve,
            reject,
            progress: progress as never,
            isCancelled: isCancelled as never,
          });
        }),
    ) as Engine['compute'],
  } as Engine;
  return { engine, pending };
}

const audio = (bytes = 8) => new Uint8Array(bytes);

function queueOf(overrides: Partial<Parameters<typeof createJobQueue>[0]> = {}) {
  const { engine, pending } = controllableEngine();
  const queue = createJobQueue({ engine, maxQueued: 3, ttlMs: 60_000, ...overrides });
  return { queue, pending, engine };
}

describe('串行', () => {
  it('第一个立刻开跑，第二个排队 —— engine 同时只被调一次', async () => {
    const { queue, pending, engine } = queueOf();
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };
    const b = queue.submit('u1', audio(), 'mp3') as { id: string };

    expect(engine.compute).toHaveBeenCalledTimes(1);
    expect(queue.view('u1', a.id)?.status).toBe('running');
    expect(queue.view('u1', b.id)?.status).toBe('queued');
    expect(queue.stats()).toEqual({ queued: 1, running: 1 });

    pending[0].resolve(result());
    await vi.waitFor(() => expect(queue.view('u1', b.id)?.status).toBe('running'));
    expect(engine.compute).toHaveBeenCalledTimes(2);
  });

  it('排位是「前面还有几个，含正在跑的那个」', () => {
    const { queue } = queueOf();
    queue.submit('u1', audio(), 'mp3');
    const b = queue.submit('u1', audio(), 'mp3') as { id: string };
    const c = queue.submit('u1', audio(), 'mp3') as { id: string };

    expect(queue.view('u1', b.id)?.queuePosition).toBe(1);
    expect(queue.view('u1', c.id)?.queuePosition).toBe(2);
  });

  it('跑着的那个没有排位（它就在跑，不在排）', () => {
    const { queue } = queueOf();
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };
    expect(queue.view('u1', a.id)?.queuePosition).toBeUndefined();
  });

  it('排满了拒绝，且理由带着上限 —— 一个人用的服务，堆积没有意义', () => {
    const { queue } = queueOf({ maxQueued: 1 });
    queue.submit('u1', audio(), 'mp3'); // 跑着
    queue.submit('u1', audio(), 'mp3'); // 排着
    const third = queue.submit('u1', audio(), 'mp3');
    expect(third).toHaveProperty('error');
    expect((third as { error: string }).error).toContain('1');
  });
});

describe('进度与结果', () => {
  it('engine 报的进度照实落到 view 上', async () => {
    const { queue, pending } = queueOf();
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };

    pending[0].progress({ stage: 'infer', chunk: 5, chunks: 27 });
    expect(queue.view('u1', a.id)).toMatchObject({ stage: 'infer', chunk: 5, chunks: 27 });
  });

  it('算完之后 view 里带上矩阵的形状（客户端据此准备缓冲）', async () => {
    const { queue, pending } = queueOf();
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };
    pending[0].resolve(result(24_000));

    await vi.waitFor(() => expect(queue.view('u1', a.id)?.status).toBe('done'));
    expect(queue.view('u1', a.id)).toMatchObject({ frames: 24_000, vocabSize: 35 });
  });

  it('取走即删：第二次拿不到 —— 一份 3MB，没有第二次要它的理由', async () => {
    const { queue, pending } = queueOf();
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };
    pending[0].resolve(result());
    await vi.waitFor(() => expect(queue.view('u1', a.id)?.status).toBe('done'));

    expect(queue.takeResult('u1', a.id)).not.toBeNull();
    expect(queue.takeResult('u1', a.id)).toBeNull();
    expect(queue.view('u1', a.id)).toBeNull();
  });

  it('还没算完时取不到结果（客户端要能分清「再等等」和「重新上传」）', () => {
    const { queue } = queueOf();
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };
    expect(queue.takeResult('u1', a.id)).toBeNull();
    expect(queue.view('u1', a.id)?.status).toBe('running');
  });

  it('算挂了：状态是 error，消息带着原因，而且不挡住后面那个', async () => {
    const { queue, pending } = queueOf();
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };
    const b = queue.submit('u1', audio(), 'mp3') as { id: string };

    pending[0].reject(new Error('ffmpeg 退出码 1'));
    await vi.waitFor(() => expect(queue.view('u1', a.id)?.status).toBe('error'));
    expect(queue.view('u1', a.id)?.error).toContain('ffmpeg');
    await vi.waitFor(() => expect(queue.view('u1', b.id)?.status).toBe('running'));
  });
});

describe('取消', () => {
  it('排队中的立刻结算成 cancelled，并腾出位置', () => {
    const { queue } = queueOf({ maxQueued: 1 });
    queue.submit('u1', audio(), 'mp3');
    const b = queue.submit('u1', audio(), 'mp3') as { id: string };

    expect(queue.cancel('u1', b.id)).toBe(true);
    expect(queue.view('u1', b.id)?.status).toBe('cancelled');
    expect(queue.stats().queued).toBe(0);
    expect(queue.submit('u1', audio(), 'mp3')).toHaveProperty('id');
  });

  it('正在跑的那个由 engine 在下一个块边界自己停', async () => {
    const { queue, pending } = queueOf();
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };

    expect(pending[0].isCancelled()).toBe(false);
    queue.cancel('u1', a.id);
    expect(pending[0].isCancelled()).toBe(true);

    pending[0].reject(new Cancelled());
    await vi.waitFor(() => expect(queue.view('u1', a.id)?.status).toBe('cancelled'));
    expect(queue.view('u1', a.id)?.error).toBeUndefined();
  });

  it('取消一个不存在的任务是 false，不抛', () => {
    const { queue } = queueOf();
    expect(queue.cancel('u1', 'gibt-es-nicht')).toBe(false);
  });
});

describe('隔离', () => {
  it('别人的任务一律当不存在 —— 连「这个 id 存在」都不漏', () => {
    const { queue } = queueOf();
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };

    expect(queue.view('u2', a.id)).toBeNull();
    expect(queue.takeResult('u2', a.id)).toBeNull();
    expect(queue.cancel('u2', a.id)).toBe(false);
    // 自己的照旧好使 —— 上面那三下没有把它改坏。
    expect(queue.view('u1', a.id)?.status).toBe('running');
  });
});

describe('TTL', () => {
  it('结束满 TTL 之后被扫掉', async () => {
    let clock = 0;
    const { queue, pending } = queueOf({ ttlMs: 1000, now: () => clock });
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };
    pending[0].resolve(result());
    await vi.waitFor(() => expect(queue.view('u1', a.id)?.status).toBe('done'));

    clock = 1001;
    queue.submit('u1', audio(), 'mp3'); // submit/view 都会触发 sweep
    expect(queue.view('u1', a.id)).toBeNull();
  });

  it('排队和计算再久也不会被扫掉 —— TTL 只从结束那一刻算起', () => {
    let clock = 0;
    const { queue } = queueOf({ ttlMs: 1000, now: () => clock });
    const a = queue.submit('u1', audio(), 'mp3') as { id: string };

    clock = 10 * 60_000;
    expect(queue.view('u1', a.id)?.status).toBe('running');
  });
});
