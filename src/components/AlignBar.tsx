// 常驻在应用底部的自动对齐进度条。
//
// 为什么必须是常驻的：手机上一课要跑几分钟到十几分钟，而这段时间人一定会切页面。
// 进度只画在某一页上，等于「切走就看不见了」——那和卡死无法区分，
// 而这个功能上一次的真实故障（进程被系统杀掉）恰恰长得就像卡死。
//
// ── 底部单浮层契约（SPEC §12.2）──
// 它以前是 `fixed bottom-0 z-30`，而音频条是 `sticky bottom-0 z-10` —— 对齐一跑，
// 进度条就正正压住播放键。现在两件事变了：
//   ① 位置从 `bottom-0` 改成 `bottom: var(--base-bar-h)`，永远落在基座之上；
//   ② 有音频条在场时**默认折叠成一条进度线**（20px），点一下才展成整行。
// 优先级是「音频条 > 对齐进度」：你在听的时候，能不能按到播放键比看不看得见
// 百分数重要，而进度线仍然在动，「还活着」这件事一眼可见。

import { useEffect, useState } from 'react';
import { planLabel } from '@/align/config';
import { Banner, Button, Note, formatBytes } from '@/components/ui';
import { stageLabel, useAlignStore } from '@/state/useAlignStore';
import { useBottomLayer, useHasAudioBar } from './bottomLayer';
import type { AlignProgress } from '@/align/align';

function detail(p: AlignProgress): string {
  if (p.stage === 'model') {
    // 首次使用要下 187MB 权重；随包版本走本机文件，这行会快很多但仍然看得见。
    return p.total ? `${formatBytes(p.loaded ?? 0)} / ${formatBytes(p.total)}` : '…';
  }
  // 块数优先于百分数。百分数是个没有单位的量：手机上 4% 既可能是「在正常爬」
  // 也可能是「卡住了」，而「第 1/27 块」配上下面那个秒表就能自己说清楚。
  if (p.stage === 'infer' && p.chunks) {
    return `第 ${p.chunk ?? 0}/${p.chunks} 块`;
  }
  if (p.stage === 'infer' || p.stage === 'align') return `${Math.round((p.fraction ?? 0) * 100)}%`;
  return '…';
}

/** 毫秒 → `M:SS`。 */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 「还要多久」。只有推理那一段算得出来 —— 它是唯一有分母的一段（块数）。
 *
 * 手机上一课要十几分钟，而进度条一格一格跳的间隔本身就有几十秒。
 * 没有这句话的话，「慢」和「死了」在界面上是同一个样子。
 */
function remaining(
  p: AlignProgress,
  base: { inferStartedAt?: number; inferStartedChunk?: number },
  now: number,
): string | null {
  if (p.stage !== 'infer' || !p.chunks || p.chunk === undefined || !base.inferStartedAt) return null;
  // 只有**这一段里新算完的**块能当样本。续算时前面那些块是从磁盘读回来的，
  // 拿它们去除刚过去的几秒会算出一个荒谬的速度（变更 33）。
  const done = p.chunk - (base.inferStartedChunk ?? 0);
  if (done <= 0) return null;
  const left = ((now - base.inferStartedAt) / done) * (p.chunks - p.chunk);
  return left >= 5000 ? `约还需 ${clock(left)}` : null;
}

/**
 * 一秒一跳的时钟。**存在的理由就是「让静默看起来不像死机」**：
 * 2026-09-03 iPhone 上的症状是「一开始就卡住好几分钟」，而那几分钟里
 * 界面上每一个像素都是静止的。有一个自己在走的秒表，人至少知道应用还活着。
 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function percent(p: AlignProgress): number {
  // 四个阶段各占一段。model 的字节进度也折进来 —— 它是最慢的一段，
  // 只显示「加载模型…」的话，最需要耐心的那几分钟里进度条一动不动。
  const model = p.total ? (p.loaded ?? 0) / p.total : 0;
  switch (p.stage) {
    case 'decode':
      return 2;
    case 'model':
      return 5 + model * 35;
    case 'infer':
      return 40 + (p.fraction ?? 0) * 45;
    case 'align':
      return 85 + (p.fraction ?? 0) * 14;
    case 'apply':
      return 99;
  }
}

export function AlignBar() {
  const { current, queue, lastDone, lastError, cancel, dismiss } = useAlignStore();
  const now = useTicker(current !== null);
  const hasAudioBar = useHasAudioBar();
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  useBottomLayer('align', el);

  if (!current && !lastDone && !lastError) return null;

  const eta = current ? remaining(current.progress, current, now) : null;
  // 折叠只发生在「正在跑」这一档：完成和失败各只出现一次、一句话说完，
  // 而且带着一个「知道了」要点，压成一条线反而藏起了唯一的出口。
  const collapsed = current !== null && hasAudioBar && !expanded;

  return (
    <div
      ref={setEl}
      // 基座之上，不是视口底部。基座是底部标签栏或音频条（两者互斥），高度实测。
      style={{ bottom: 'var(--base-bar-h, 0px)' }}
      className={`fixed inset-x-0 z-20 border-t border-line bg-raised/95 backdrop-blur ${
        hasAudioBar ? '' : 'app-bottom-safe'
      }`}
    >
      {collapsed ? (
        <button
          onClick={() => setExpanded(true)}
          aria-label={`对齐中：${stageLabel(current.progress)} ${detail(current.progress)}，点开看详情`}
          className="block w-full"
        >
          <div className="h-[2px] w-full bg-sunken">
            <div
              className="h-full bg-accent transition-[width] duration-300"
              style={{ width: `${percent(current.progress)}%` }}
            />
          </div>
          <div className="mx-auto flex h-[18px] max-w-4xl items-center justify-end px-4">
            <span className="size-1.5 rounded-full bg-accent" />
          </div>
        </button>
      ) : (
        <div className="mx-auto max-w-4xl px-4 py-2 text-ui">
          {current ? (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  <span className="font-medium">《{current.title}》</span>
                  <span className="ml-2 text-muted">
                    {stageLabel(current.progress)} {detail(current.progress)}
                  </span>
                  <span className="tnum ml-2 text-note text-faint">
                    已跑 {clock(now - current.startedAt)}
                    {eta && ` · ${eta}`}
                  </span>
                  {queue.length > 0 && (
                    <span className="ml-2 text-note text-faint">还有 {queue.length} 课排队</span>
                  )}
                </p>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
                  <div
                    className="h-full bg-accent transition-[width] duration-300"
                    style={{ width: `${percent(current.progress)}%` }}
                  />
                </div>
              </div>
              {hasAudioBar && (
                <button className="shrink-0 text-note text-muted underline" onClick={() => setExpanded(false)}>
                  收起
                </button>
              )}
              <button className="shrink-0 text-note text-muted underline" onClick={cancel}>
                停止
              </button>
            </div>
          ) : lastError ? (
            <Note
              tone="danger"
              action={
                <button className="shrink-0 text-note text-muted underline" onClick={dismiss}>
                  知道了
                </button>
              }
            >
              《{lastError.title}》自动对齐失败：{lastError.message}
            </Note>
          ) : lastDone ? (
            <Note
              tone="ok"
              action={
                <button className="shrink-0 text-note text-muted underline" onClick={dismiss}>
                  知道了
                </button>
              }
            >
              《{lastDone.title}》对齐完成：{lastDone.applied} 句，用了 {lastDone.seconds} 秒
              {lastDone.review > 0 && ` · ${lastDone.review} 句置信度偏低`}
            </Note>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * 「上次对齐被系统杀掉了」的证据条。
 *
 * 这是 2026-09-01 那次事故留下的东西：手机上进度走到 181 MB / 187.6 MB 之后应用直接消失，
 * 没有任何提示，重开之后一切正常 —— 你甚至不知道对齐到底成没成。
 * 现在那一次死亡会在下次启动时把自己说出来，包括死在哪一步、用的哪套后端、
 * 以及接下来自动改用什么。
 *
 * 放在应用外壳而不是某一页：崩溃之后你会落在哪一页是不确定的。
 *
 * 这一条**留在「拦路」那一档**（§12.3）：它要求你现在做一个决定（接着算 / 知道了），
 * 而那些取证细节（死在哪一步、哪档后端、堆多大）收进折叠块 —— 需要它们的时候
 * 是在跟我自己对账，不是在练听力。
 */
export function AlignCrashBanner() {
  const { crash, blocked, native, dismiss, enqueue } = useAlignStore();
  if (!crash) return null;

  const elapsed = Math.round((crash.updatedAt - crash.startedAt) / 1000);
  const where =
    crash.stage === 'model' && crash.total
      ? `加载模型（${formatBytes(crash.loaded ?? 0)} / ${formatBytes(crash.total)}）`
      : `${stageLabel({ stage: crash.stage, fraction: crash.fraction })} ${detail({
          stage: crash.stage,
          fraction: crash.fraction,
          chunk: crash.chunk,
          chunks: crash.chunks,
        })}`;

  const retryLabel = native
    ? crash.chunk && crash.chunks
      ? `接着算（上次到第 ${crash.chunk}/${crash.chunks} 块）`
      : '接着算'
    : '再试一次（用降档后的后端）';

  return (
    <Banner
      tone="warn"
      title="上次自动对齐没跑完 —— 进程被系统终止了。"
      action={
        <>
          {/*
            重试是手动的，不是自动的：崩掉的那一课在启动时自动重跑，等于「一开应用就再被杀一次」，
            而那正是这条横幅要终结的循环。降档已经准备好了，按不按由你决定。
          */}
          <Button
            onClick={() => {
              enqueue(crash.lessonId, { manual: true });
              dismiss();
            }}
          >
            {retryLabel}
          </Button>
          <Button variant="ghost" onClick={dismiss}>
            知道了
          </Button>
        </>
      }
    >
      <p>
        《{crash.title}》死在「{where}」，已经跑了 {elapsed} 秒。
      </p>
      <p>
        {native
          ? '这台设备走原生插件算 emissions —— 那 230MB 权重不再进 WebView。已经算完的块存在断点里，接着算不会从头开始。'
          : blocked
            ? '两档后端都被杀过了 —— 这台设备跑不动这个模型。自动对齐已停掉，请在桌面上对齐，句级时间戳会跟着备份同步回来。'
            : '下一次会自动换一档更保守的后端重试（同一档不会连试两次）。'}
      </p>
      <details className="text-note">
        <summary className="cursor-pointer list-none opacity-70">› 取证细节</summary>
        <p className="mt-1">
          {planLabel(crash.plan, crash.planStep)} · {crash.platform} · 权重
          {crash.weights === 'local' ? (crash.ranged ? '随包·分片取' : '随包·整份取') : '来自 CDN'}
          {crash.heapMB !== undefined && ` · JS 堆 ${crash.heapMB} MB`}
        </p>
      </details>
    </Banner>
  );
}
