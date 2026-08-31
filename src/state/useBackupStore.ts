// FR-11.9：备份状态常驻可见 —— 上次成功时间、待推送变更数、token 剩余有效期。
// 这个 store 是 UI 的唯一数据源；实际的网络请求都在 src/github/* 里。

import { create } from 'zustand';
import { getMeta, putMeta, deleteMeta } from '@/db/meta';
import { META_KEYS } from '@/db/schema';
import { verifyToken, shouldWarnAboutExpiry, type GitHubIdentity } from '@/github/auth';
import { createBackupRepo, listPrivateRepos, verifyRepo, type RepoRef, type RepoVerification } from '@/github/repo';
import { getQueue } from '@/github/queue';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface PersistedBackupStatus {
  lastSuccessAt?: number;
  tokenExpiresAt?: string; // ISO
}

interface BackupState {
  status: ConnectionStatus;
  identity: GitHubIdentity | null;
  repo: RepoRef | null;
  tokenExpiresAt: Date | null;
  tokenLast4: string | null; // FR-11.2：界面此后只显示后四位
  lastSuccessAt: number | null;
  pendingCount: number;
  errorMessage: string | null;

  /** 启动时调用一次：从 IndexedDB 读回上次连接状态，不发任何网络请求。 */
  hydrate: () => Promise<void>;

  /** FR-11.2：粘贴 token 后自动 GET /user。成功则把 token 存入 meta。 */
  connectWithToken: (token: string) => Promise<void>;

  /** FR-11.3：一键创建仓库，或选择已有的一个。 */
  createRepo: (name: string) => Promise<void>;
  listExistingRepos: () => Promise<RepoRef[]>;
  chooseExistingRepo: (ref: RepoRef) => Promise<RepoVerification>;

  refreshPendingCount: () => Promise<void>;
  recordPushSuccess: () => Promise<void>;

  /** 仅供"生成配对二维码"这一显式用户动作调用，不在别处暴露原始 token。 */
  exportTokenForPairing: () => Promise<string | undefined>;

  disconnect: () => Promise<void>;
}

async function getToken(): Promise<string | undefined> {
  return getMeta<string>(META_KEYS.githubToken);
}

export const useBackupStore = create<BackupState>((set, get) => ({
  status: 'disconnected',
  identity: null,
  repo: null,
  tokenExpiresAt: null,
  tokenLast4: null,
  lastSuccessAt: null,
  pendingCount: 0,
  errorMessage: null,

  hydrate: async () => {
    const [token, repo, backupStatus, pendingQueue] = await Promise.all([
      getToken(),
      getMeta<RepoRef>(META_KEYS.githubRepo),
      getMeta<PersistedBackupStatus>(META_KEYS.backupStatus),
      getQueue(),
    ]);
    set({
      status: token ? 'connected' : 'disconnected',
      repo: repo ?? null,
      tokenLast4: token ? token.slice(-4) : null,
      lastSuccessAt: backupStatus?.lastSuccessAt ?? null,
      tokenExpiresAt: backupStatus?.tokenExpiresAt ? new Date(backupStatus.tokenExpiresAt) : null,
      pendingCount: pendingQueue.length,
    });
    // 身份信息（用户名/头像）不落库，重连时静默刷新一次；离线时保持已连接但不知道身份也无妨。
    if (token) {
      void verifyToken(token)
        .then(({ identity, expiry }) => {
          set({ identity });
          if (expiry.expiresAt) void persistExpiry(expiry.expiresAt);
        })
        .catch(() => {
          /* 离线或 token 失效：保留已连接的 UI 状态，等用户下次主动操作时再暴露错误 */
        });
    }
  },

  connectWithToken: async (token: string) => {
    set({ status: 'connecting', errorMessage: null });
    try {
      const { identity, expiry } = await verifyToken(token);
      await putMeta(META_KEYS.githubToken, token);
      if (expiry.expiresAt) await persistExpiry(expiry.expiresAt);
      set({ status: 'connected', identity, tokenExpiresAt: expiry.expiresAt, tokenLast4: token.slice(-4) });
    } catch (err) {
      set({ status: 'error', errorMessage: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  createRepo: async (name: string) => {
    const token = await getToken();
    if (!token) throw new Error('尚未连接 GitHub');
    const ref = await createBackupRepo(token, name);
    await putMeta(META_KEYS.githubRepo, ref);
    set({ repo: ref });
  },

  listExistingRepos: async () => {
    const token = await getToken();
    if (!token) throw new Error('尚未连接 GitHub');
    return listPrivateRepos(token);
  },

  chooseExistingRepo: async (ref: RepoRef) => {
    const token = await getToken();
    if (!token) throw new Error('尚未连接 GitHub');
    const verification = await verifyRepo(token, ref);
    if (verification.private && verification.writable) {
      await putMeta(META_KEYS.githubRepo, ref);
      set({ repo: ref });
    }
    return verification;
  },

  refreshPendingCount: async () => {
    const queue = await getQueue();
    set({ pendingCount: queue.length });
  },

  recordPushSuccess: async () => {
    const now = Date.now();
    const existing = (await getMeta<PersistedBackupStatus>(META_KEYS.backupStatus)) ?? {};
    await putMeta(META_KEYS.backupStatus, { ...existing, lastSuccessAt: now });
    set({ lastSuccessAt: now });
    await get().refreshPendingCount();
  },

  exportTokenForPairing: async () => getToken(),

  disconnect: async () => {
    await Promise.all([deleteMeta(META_KEYS.githubToken), deleteMeta(META_KEYS.githubRepo)]);
    set({ status: 'disconnected', identity: null, repo: null, tokenExpiresAt: null, tokenLast4: null });
  },
}));

async function persistExpiry(expiresAt: Date): Promise<void> {
  const existing = (await getMeta<PersistedBackupStatus>(META_KEYS.backupStatus)) ?? {};
  await putMeta(META_KEYS.backupStatus, { ...existing, tokenExpiresAt: expiresAt.toISOString() });
}

/** 供设置页横幅判断是否要显示"token 即将过期"提醒（FR-11.5）。 */
export function isExpiryWarningActive(state: Pick<BackupState, 'tokenExpiresAt'>): boolean {
  return shouldWarnAboutExpiry(state.tokenExpiresAt);
}
