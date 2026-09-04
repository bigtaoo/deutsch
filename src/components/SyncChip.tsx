// FR-11.9 同步状态常驻可见 —— 现在是应用头部那个状态芯片（SPEC §12.3.1）。
//
// ── 为什么从「首页一行五个字段」改成「头部一个芯片」 ──
// 旧形状有两个问题，而且是相反方向的两个：
//   ① 它**只在首页**。而 FR-11.9 要防的是「同步静默停摆」，那件事在你连着三天
//      只开复习页的那三天里最危险 —— 恰好是旧状态条一次都不出现的三天。
//   ② 它在首页**永远占一行五个字段**，一切正常时也照占。天天看见同一行绿字的
//      结果是不再读它，而不再读的指示灯等于没有指示灯。
//
// 新形状两头都收：**芯片跟着应用外壳走，每一页都在**（比原来更「常驻」），
// 但它只用一行说**四项里最坏的那一项**；四项全文在点开之后（FR-11.9 要求的
// 账号 / 上次推送 / 上次拉取 / 待推送数一项没少）。
//
// 「最坏那一项」而不是「拼一行摘要」是关键：拼摘要会把「待推送 3 项」和
// 「上次拉取 12 天前」并排放，而人只会读第一段。

import { useEffect, useState } from 'react';
import { href } from '@/app/router';
import { useSyncStore } from '@/state/useSyncStore';
import { syncNow } from '@/sync/trigger';
import type { NoteTone } from './ui';

/** 拉取多久没跑通就该说出来。自动拉取是启动/回前台就跑的，所以三天已经很久了。 */
const PULL_STALE_DAYS = 3;

function daysAgo(timestamp: number): number {
  return Math.floor((Date.now() - timestamp) / 86_400_000);
}

function ago(timestamp: number | null): string {
  if (timestamp === null) return '从未';
  const days = daysAgo(timestamp);
  return days === 0 ? '今天' : `${days} 天前`;
}

interface Summary {
  tone: NoteTone;
  label: string;
}

/**
 * 四项里最坏的那一项。顺序就是严重程度：
 * 登录没了 → 推送有积压 → 拉取停摆 → 一切正常。
 */
function worst(state: {
  status: string;
  lastSuccessAt: number | null;
  lastPullAt: number | null;
  pendingCount: number;
  errorMessage: string | null;
}): Summary {
  if (state.status === 'unconfigured') return { tone: 'neutral', label: '未配同步' };
  if (state.status !== 'signed-in') return { tone: 'warn', label: '未登录' };
  if (state.errorMessage) return { tone: 'danger', label: '同步出错' };
  if (state.pendingCount > 0) return { tone: 'warn', label: `待推送 ${state.pendingCount}` };
  if (state.lastPullAt === null || daysAgo(state.lastPullAt) > PULL_STALE_DAYS) {
    return { tone: 'warn', label: `拉取 ${ago(state.lastPullAt)}` };
  }
  return { tone: 'ok', label: `同步 ${ago(state.lastSuccessAt)}` };
}

const DOT = {
  neutral: 'bg-faint',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
} as const;

export function SyncChip() {
  const state = useSyncStore();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void state.refreshStatus();
    // refreshStatus 是稳定引用；这里只要进应用时问一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = worst(state);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex max-w-36 items-center gap-1.5 rounded-full px-2 py-1 text-note text-muted hover:bg-sunken"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${DOT[summary.tone]}`} />
        <span className="truncate">{summary.label}</span>
      </button>

      {open && (
        <>
          {/* 点别处收起。放在浮层下面一层，不吃浮层自己的点击。 */}
          <button
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-1 w-64 space-y-1.5 rounded-box border border-line bg-raised p-3 text-note shadow-lg">
            <Row label="账号">
              {state.status === 'unconfigured' ? (
                <span className="text-muted">这个版本没配同步服务器</span>
              ) : state.status === 'signed-in' && state.account ? (
                <span className="truncate text-ok">{state.account.email}</span>
              ) : (
                <a className="text-warn underline" href={href({ name: 'settings' })} onClick={() => setOpen(false)}>
                  未登录 —— 去登录
                </a>
              )}
            </Row>
            <Row label="上次推送">{ago(state.lastSuccessAt)}</Row>
            {/* 拉那一半必须单独一行（FR-11.19）：它停了的症状是「别的设备上的东西
                一直不来」，而那看起来跟「我最近没在别的设备上练」一模一样。 */}
            <Row label="上次拉取">{ago(state.lastPullAt)}</Row>
            <Row label="待推送">
              <span className={state.pendingCount > 0 ? 'text-warn' : undefined}>{state.pendingCount} 项</span>
              {state.pendingCount > 0 && (
                <button className="ml-2 underline" onClick={() => void syncNow({ force: true })}>
                  立即重试
                </button>
              )}
            </Row>
            {state.errorMessage && <p className="text-danger">{state.errorMessage}</p>}
            <a
              className="block pt-1 text-muted underline"
              href={href({ name: 'settings' })}
              onClick={() => setOpen(false)}
            >
              同步与备份设置
            </a>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="flex gap-2">
      <span className="w-16 shrink-0 text-faint">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

/**
 * FR-11.12 手动导出提醒。**分两档**，而不是一条永远挂着的横幅。
 *
 * 旧形状有个具体的毛病：`lastBackupAt` 只在导出时才写，所以**全新安装第一次打开
 * 就会看到「距上次手动导出已超过 90 天」** —— 那时候你还没有任何东西可丢。
 * 一条从第一天起就挂着、内容还是三行取舍论证的横幅，教会人的只有「忽略横幅」。
 *
 * 现在：没东西可备份就不说；90 天是一行提醒（Note）；半年才升级成真横幅。
 * 两档之间的差别是「该找个时间做」和「现在就做」，而那正是横幅该保留给的那一档。
 */
export const MANUAL_EXPORT_REMINDER_DAYS = 90;
export const MANUAL_EXPORT_OVERDUE_DAYS = 180;

export function manualExportStage(
  lastBackupAt: number | undefined,
  hasSomethingToLose: boolean,
): 'silent' | 'remind' | 'overdue' {
  if (!hasSomethingToLose) return 'silent';
  // 「从未导出」停在提醒那一档，不升级成横幅：没有安装日期可比，而刚导完第一课
  // 的人和攒了三年的人在这个字段上长得一样。有真实时间戳才谈得上「过期多久」。
  if (lastBackupAt === undefined) return 'remind';
  const days = daysAgo(lastBackupAt);
  if (days > MANUAL_EXPORT_OVERDUE_DAYS) return 'overdue';
  if (days > MANUAL_EXPORT_REMINDER_DAYS) return 'remind';
  return 'silent';
}
