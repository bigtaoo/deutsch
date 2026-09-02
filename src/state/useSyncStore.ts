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
}

interface SyncState {
  status: SyncStatus;
  account: SyncAccount | null;
  lastSuccessAt: number | null;
  pendingCount: number;
  errorMessage: string | null;

  /** 启动时调用一次：从 IndexedDB 读回上次的登录状态，不阻塞渲染。 */
  hydrate: () => Promise<void>;

  signIn: () => Promise<void>;
  signOut: () => Promise<void>;

  refreshPendingCount: () => Promise<void>;
  recordPushSuccess: () => Promise<void>;

  /** 令牌被撤销 / 过期时由 sync/trigger.ts 的钩子调进来。 */
  markSessionExpired: () => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  status: isSyncConfigured() ? 'signed-out' : 'unconfigured',
  account: null,
  lastSuccessAt: null,
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

  refreshPendingCount: async () => {
    set({ pendingCount: (await getQueue()).length });
  },

  recordPushSuccess: async () => {
    const now = Date.now();
    const existing = (await getMeta<PersistedSyncStatus>(META_KEYS.syncStatus)) ?? {};
    await putMeta(META_KEYS.syncStatus, { ...existing, lastSuccessAt: now });
    set({ lastSuccessAt: now });
    await get().refreshPendingCount();
  },

  markSessionExpired: () => {
    set({ status: 'signed-out', account: null, errorMessage: '登录已失效，请重新登录' });
  },
}));
