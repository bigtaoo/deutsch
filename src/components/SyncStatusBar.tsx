// FR-11.9：同步状态**常驻可见** —— 登录的账号 + 上次成功时间 + 待推送变更数。
// FR-11.12：距上次手动导出超过 90 天的横幅提醒。
//
// 静默失败的备份比没有备份更危险，它给你虚假的安全感。所以这条状态在首页永远在，
// 哪怕一切正常也占一行 —— 只在出事时才出现的指示灯，出事时你也不会注意到它没亮。

import { useEffect } from 'react';
import { href } from '@/app/router';
import { useSyncStore } from '@/state/useSyncStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { drainSyncQueue } from '@/sync/trigger';

const MANUAL_EXPORT_REMINDER_DAYS = 90;

function daysAgo(timestamp: number): number {
  return Math.floor((Date.now() - timestamp) / 86_400_000);
}

export function SyncStatusBar() {
  const { status, account, lastSuccessAt, pendingCount, errorMessage, refreshPendingCount } =
    useSyncStore();
  const lastManualExport = useSettingsStore((s) => s.settings.lastBackupAt);

  useEffect(() => {
    void refreshPendingCount();
  }, [refreshPendingCount]);

  const manualOverdue =
    lastManualExport === undefined || daysAgo(lastManualExport) > MANUAL_EXPORT_REMINDER_DAYS;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-neutral-200 px-3 py-2 text-xs text-neutral-600">
        <span>
          自动同步：
          {status === 'unconfigured' ? (
            <span className="text-neutral-500">这个版本没配同步服务器</span>
          ) : status === 'signed-in' && account ? (
            <span className="text-emerald-700">{account.email}</span>
          ) : (
            <a className="text-amber-700 underline" href={href({ name: 'settings' })}>
              未登录
            </a>
          )}
        </span>

        <span>上次成功：{lastSuccessAt ? `${daysAgo(lastSuccessAt)} 天前` : '从未'}</span>

        <span className={pendingCount > 0 ? 'text-amber-700' : ''}>
          待推送 {pendingCount} 项
          {pendingCount > 0 && (
            <button className="ml-1 underline" onClick={() => void drainSyncQueue()}>
              立即重试
            </button>
          )}
        </span>

        {errorMessage && <span className="text-amber-700">{errorMessage}</span>}
      </div>

      {manualOverdue && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          距上次手动导出已超过 {MANUAL_EXPORT_REMINDER_DAYS} 天。自动同步是主力，手动导出防的是
          同步服务器本身出问题（机器没了、证书过期、账号登不上）—— 两者是不同的故障域。
          <a className="ml-2 underline" href={href({ name: 'settings' })}>
            去导出
          </a>
        </div>
      )}
    </div>
  );
}
