// 黑匣子的价值全在「进程被杀之后」，而那没法在单测里制造。
// 能测的是等价的东西：**不调 finishRun 就等于崩溃**，以及崩过的档位会被跳过。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allPlansCrashed,
  beginRun,
  clearJournal,
  detectCrash,
  finishRun,
  nextPlanStep,
  noteStage,
  readHistory,
} from './journal';
import { PLAN_LADDER } from './config';

const base = {
  lessonId: 'l1',
  title: '测试课',
  platform: 'ios',
  weights: 'local' as const,
};

function startStep(step: number) {
  beginRun({ ...base, plan: PLAN_LADDER[step], planStep: step });
}

// jsdom 在这套配置下不给 localStorage（源是 opaque origin）。黑匣子本身对此是容错的
// —— read/write 全在 try/catch 里，拿不到存储就退化成「不记录」而不是让对齐失败 ——
// 但要测它记了什么，就得先有一个存储。
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  clearJournal();
});

describe('黑匣子', () => {
  it('正常收尾之后，下次启动不认为崩溃过', () => {
    startStep(0);
    noteStage({ stage: 'model', loaded: 100, total: 200 });
    finishRun('done');
    expect(detectCrash()).toBeNull();
    expect(readHistory()[0].status).toBe('done');
  });

  it('抛错也算正常收尾 —— 报得出来的错不是崩溃', () => {
    startStep(0);
    finishRun('error', '词表大小不对');
    expect(detectCrash()).toBeNull();
    expect(readHistory()[0]).toMatchObject({ status: 'error', error: '词表大小不对' });
  });

  // Worker 被杀而主线程活着（client.ts 的 AlignWorkerDeath）：JS 有机会收尾，
  // 但性质是崩溃。记成 error 的话降档判据就丢了 —— 那一档会被无限重试。
  it('Worker 被杀要记成 crashed，并且真的能让下一次降档', () => {
    startStep(0);
    finishRun('crashed', '对齐进程被系统杀掉了 —— 多半是加载权重时内存不够');
    // 已经收尾了，所以不该再被下次启动当成「上次没跑完」重复报一遍
    expect(detectCrash()).toBeNull();
    expect(readHistory()[0].status).toBe('crashed');
    expect(nextPlanStep(PLAN_LADDER.length)).toBe(1);
  });

  it('两档各被杀一次（都走 finishRun 那条路）也要停掉自动对齐', () => {
    for (const step of [0, 1]) {
      startStep(step);
      finishRun('crashed', '被杀');
    }
    expect(allPlansCrashed(PLAN_LADDER.length)).toBe(true);
  });

  it('没收尾就等于被系统杀掉，并且记得死在哪一步', () => {
    startStep(0);
    noteStage({ stage: 'model', loaded: 181_000_000, total: 196_708_000 });
    // 这里没有 finishRun —— 模拟进程直接消失。
    const crash = detectCrash();
    expect(crash).toMatchObject({
      status: 'crashed',
      stage: 'model',
      loaded: 181_000_000,
      planStep: 0,
      platform: 'ios',
    });
  });

  it('detectCrash 只报一次：归档之后重启不该再弹一遍', () => {
    startStep(0);
    expect(detectCrash()).not.toBeNull();
    expect(detectCrash()).toBeNull();
  });

  it('崩过的档位会被跳过，没崩过的还是从第 0 档开始', () => {
    expect(nextPlanStep(PLAN_LADDER.length)).toBe(0);
    startStep(0);
    detectCrash();
    expect(nextPlanStep(PLAN_LADDER.length)).toBe(1);
    expect(allPlansCrashed(PLAN_LADDER.length)).toBe(false);
  });

  it('两档都崩过 = 这台设备跑不动，自动对齐要停掉', () => {
    for (const step of [0, 1]) {
      startStep(step);
      detectCrash();
    }
    expect(allPlansCrashed(PLAN_LADDER.length)).toBe(true);
  });

  it('成功一次不会把崩溃记录抹掉 —— 但也不该因此永远降档', () => {
    startStep(0);
    detectCrash();
    startStep(1);
    finishRun('done');
    // 历史里两条都在（一条 crashed、一条 done），第 0 档仍然被跳过。
    expect(readHistory().map((r) => r.status)).toEqual(['done', 'crashed']);
    expect(nextPlanStep(PLAN_LADDER.length)).toBe(1);
  });
});
