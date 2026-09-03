// FR-11.9：同步状态**常驻可见** —— 登录的账号、上次成功时间、待推送变更数。
// 这个 store 是 UI 的唯一数据源；实际的网络请求都在 src/sync/* 里。

import { create } from 'zustand';
import { getMeta, putMeta } from '@/db/meta';
import { META_KEYS } from '@/db/schema';
import { isSyncConfigured } from '@/sync/config';
import { getQueue } from '@/sync/queue';
import { forgetAllVersions } from '@/sync/docs';
import {
  getSession,
  refreshAccount,
  signIn as performSignIn,
  signOut as performSignOut,
  type SyncAccount,
} from '@/sync/session';

export type SyncStatus = 'unconfigured' | 'signed-out' | 'signing-in' | 'signed-in' | 'error';

interface PersistedSyncStatus {
  lastSuccessAt?: number;
  /** 上次**拉取**跑通的时刻（FR-11.19）。由 sync/pull.ts 写。 */
  lastPullAt?: number;
}

interface SyncState {
  status: SyncStatus;
  account: SyncAccount | null;
  lastSuccessAt: number | null;
  /**
   * 上次拉取跑通的时刻。和「上次推送成功」分开显示（FR-11.9）：
   * 推通了不代表拉通了，而「拉悄悄停了」的症状就是「另一台设备上的东西一直不来」——
   * 只看推送那一行的话状态条会一片绿，用户只能靠猜。
   */
  lastPullAt: number | null;
  pendingCount: number;
  errorMessage: string | null;

  /** 启动时调用一次：从 IndexedDB 读回上次的登录状态，不阻塞渲染。 */
  hydrate: () => Promise<void>;

  signIn: () => Promise<void>;
  signOut: () => Promise<void>;

  /** 重读「待推送几项 + 上次推送/拉取时刻」。同步链路每次 onChange 都调它。 */
  refreshStatus: () => Promise<void>;
  recordPushSuccess: () => Promise<void>;

  /** 令牌被撤销 / 过期时由 sync/trigger.ts 的钩子调进来。 */
  markSessionExpired: () => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  status: isSyncConfigured() ? 'signed-out' : 'unconfigured',
  account: null,
  lastSuccessAt: null,
  lastPullAt: null,
  pendingCount: 0,
  errorMessage: null,

  hydrate: async () => {
    if (!isSyncConfigured()) {
      set({ status: 'unconfigured' });
      return;
    }
    const [session, persisted, queue] = await Promise.all([
      getSession(),
      getMeta<PersistedSyncStatus>(META_KEYS.syncStatus),
      getQueue(),
    ]);
    set({
      status: session ? 'signed-in' : 'signed-out',
      account: session?.account ?? null,
      lastSuccessAt: persisted?.lastSuccessAt ?? null,
      lastPullAt: persisted?.lastPullAt ?? null,
      pendingCount: queue.length,
    });

    // 向服务器确认一次令牌还认不认。离线时 refreshAccount 保持原状，
    // 只有明确的 401 才会把界面切回未登录。
    if (session) {
      void refreshAccount().then((account) => {
        if (account) set({ account });
        else set({ status: 'signed-out', account: null, errorMessage: '登录已失效，请重新登录' });
      });
    }
  },

  signIn: async () => {
    set({ status: 'signing-in', errorMessage: null });
    try {
      const account = await performSignIn();
      set({ status: 'signed-in', account });
    } catch (err) {
      set({
        status: 'signed-out',
        account: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  signOut: async () => {
    await performSignOut();
    // 本地记的版本号跟着账号走，换账号后留着只会平白撞 409。
    await forgetAllVersions();
    set({ status: 'signed-out', account: null, errorMessage: null });
  },

  refreshStatus: async () => {
    const [queue, persisted] = await Promise.all([
      getQueue(),
      getMeta<PersistedSyncStatus>(META_KEYS.syncStatus),
    ]);
    set({
      pendingCount: queue.length,
      lastSuccessAt: persisted?.lastSuccessAt ?? null,
      lastPullAt: persisted?.lastPullAt ?? null,
    });
  },

  recordPushSuccess: async () => {
    const now = Date.now();
    const existing = (await getMeta<PersistedSyncStatus>(META_KEYS.syncStatus)) ?? {};
    await putMeta(META_KEYS.syncStatus, { ...existing, lastSuccessAt: now });
    set({ lastSuccessAt: now });
    await get().refreshStatus();
  },

  markSessionExpired: () => {
    set({ status: 'signed-out', account: null, errorMessage: '登录已失效，请重新登录' });
  },
}));
