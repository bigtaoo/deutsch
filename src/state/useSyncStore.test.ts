// FR-11.9：同步状态**常驻可见**。这个 store 是那一块 UI 的唯一数据源。
//
// 这里要钉的不是网络（那在 sync/* 里测过），而是三件只在 store 这一层出错的事：
//   ① 「推通了」和「拉通了」是两件事，分开记 —— 合成一个的话，「拉悄悄停了」
//      的症状（另一台设备上的东西一直不来）在界面上是一片绿。
//   ② 登录失效要立刻把界面切回未登录，而**离线不算失效** —— 把离线当失效，
//      人在地铁里打开应用就会看到「请重新登录」。
//   ③ 退出登录必须顺手清掉本地记的版本号，否则换账号之后每次推送先撞一个 409。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME, META_KEYS } from '@/db/schema';
import { getMeta, putMeta } from '@/db/meta';
import type { SyncAccount } from '@/sync/session';

const ACCOUNT: SyncAccount = { email: 'tao@example.invalid', name: 'Tao', picture: null };

let configured = true;
vi.mock('@/sync/config', () => ({ isSyncConfigured: () => configured }));

const getQueue = vi.fn(async () => [] as unknown[]);
// alarmingCount 是纯函数（标脏项不算故障，§0 变更 43），mock 里照原样实现一份。
vi.mock('@/sync/queue', () => ({
  getQueue: () => getQueue(),
  alarmingCount: (queue: { deferred?: boolean }[]) => queue.filter((q) => !q.deferred).length,
}));

const forgetAllVersions = vi.fn(async () => {});
vi.mock('@/sync/docs', () => ({ forgetAllVersions: () => forgetAllVersions() }));

const getSession = vi.fn<() => Promise<unknown>>();
const refreshAccount = vi.fn<() => Promise<SyncAccount | null>>();
const signIn = vi.fn<() => Promise<SyncAccount>>();
const signOut = vi.fn(async () => {});
vi.mock('@/sync/session', () => ({
  getSession: () => getSession(),
  refreshAccount: () => refreshAccount(),
  signIn: () => signIn(),
  signOut: () => signOut(),
}));

const { useSyncStore } = await import('./useSyncStore');

const INITIAL = useSyncStore.getState();

/** hydrate 里的 refreshAccount 是 fire-and-forget，等一拍让它落地。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  configured = true;
  getQueue.mockResolvedValue([]);
  getSession.mockResolvedValue(undefined);
  refreshAccount.mockResolvedValue(ACCOUNT);
  useSyncStore.setState({
    ...INITIAL,
    status: 'signed-out',
    account: null,
    lastSuccessAt: null,
    lastPullAt: null,
    pendingCount: 0,
    errorMessage: null,
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  const db = await getDB();
  db.close();
  _resetDBForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe('hydrate', () => {
  it('这个构建没配同步服务器时整块关掉，一次库都不读', async () => {
    configured = false;
    await useSyncStore.getState().hydrate();
    expect(useSyncStore.getState().status).toBe('unconfigured');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('没登录过：signed-out，没有账号', async () => {
    await useSyncStore.getState().hydrate();
    expect(useSyncStore.getState()).toMatchObject({ status: 'signed-out', account: null });
  });

  it('登录过：读回账号、上次推送、上次拉取与待推数', async () => {
    getSession.mockResolvedValue({ token: 'tok', expiresAt: 0, account: ACCOUNT });
    getQueue.mockResolvedValue([{}, {}, {}]);
    await putMeta(META_KEYS.syncStatus, { lastSuccessAt: 111, lastPullAt: 222 });

    await useSyncStore.getState().hydrate();

    expect(useSyncStore.getState()).toMatchObject({
      status: 'signed-in',
      account: ACCOUNT,
      lastSuccessAt: 111,
      lastPullAt: 222,
      pendingCount: 3,
    });
  });

  it('推送时刻与拉取时刻分开记 —— 只有推成功过时拉取那栏仍是空的', async () => {
    getSession.mockResolvedValue({ token: 'tok', expiresAt: 0, account: ACCOUNT });
    await putMeta(META_KEYS.syncStatus, { lastSuccessAt: 111 });
    await useSyncStore.getState().hydrate();
    expect(useSyncStore.getState().lastSuccessAt).toBe(111);
    expect(useSyncStore.getState().lastPullAt).toBeNull();
  });

  it('令牌被服务器撤销：界面立刻切回未登录并给出原因', async () => {
    getSession.mockResolvedValue({ token: 'tok', expiresAt: 0, account: ACCOUNT });
    refreshAccount.mockResolvedValue(null);

    await useSyncStore.getState().hydrate();
    await tick();

    expect(useSyncStore.getState()).toMatchObject({ status: 'signed-out', account: null });
    expect(useSyncStore.getState().errorMessage).toContain('重新登录');
  });

  it('离线不算失效 —— refreshAccount 仍给回账号时状态保持已登录', async () => {
    getSession.mockResolvedValue({ token: 'tok', expiresAt: 0, account: ACCOUNT });
    await useSyncStore.getState().hydrate();
    await tick();
    expect(useSyncStore.getState().status).toBe('signed-in');
    expect(useSyncStore.getState().errorMessage).toBeNull();
  });
});

describe('登录 / 退出', () => {
  it('登录中是一个单独的状态 —— 按钮据此变灰', async () => {
    let resolve!: (account: SyncAccount) => void;
    signIn.mockReturnValue(new Promise<SyncAccount>((r) => (resolve = r)));

    const pending = useSyncStore.getState().signIn();
    expect(useSyncStore.getState().status).toBe('signing-in');
    resolve(ACCOUNT);
    await pending;
    expect(useSyncStore.getState()).toMatchObject({ status: 'signed-in', account: ACCOUNT });
  });

  it('登录失败：退回未登录，把后端的原话显示出来，并把错继续抛给调用方', async () => {
    signIn.mockRejectedValue(new Error('这个邮箱不在白名单里'));
    await expect(useSyncStore.getState().signIn()).rejects.toThrow('白名单');
    expect(useSyncStore.getState()).toMatchObject({ status: 'signed-out', account: null });
    expect(useSyncStore.getState().errorMessage).toBe('这个邮箱不在白名单里');
  });

  it('重新登录会清掉上一次的报错', async () => {
    useSyncStore.setState({ errorMessage: '上次那条' });
    signIn.mockResolvedValue(ACCOUNT);
    await useSyncStore.getState().signIn();
    expect(useSyncStore.getState().errorMessage).toBeNull();
  });

  it('退出登录顺手清掉本地记的版本号 —— 不清的话换账号后每次推送先撞 409', async () => {
    useSyncStore.setState({ status: 'signed-in', account: ACCOUNT });
    await useSyncStore.getState().signOut();
    expect(forgetAllVersions).toHaveBeenCalledOnce();
    expect(useSyncStore.getState()).toMatchObject({
      status: 'signed-out',
      account: null,
      errorMessage: null,
    });
  });
});

describe('状态刷新', () => {
  it('refreshStatus 重读待推数与两个时刻', async () => {
    getQueue.mockResolvedValue([{}, {}]);
    await putMeta(META_KEYS.syncStatus, { lastSuccessAt: 7, lastPullAt: 8 });
    await useSyncStore.getState().refreshStatus();
    expect(useSyncStore.getState()).toMatchObject({
      pendingCount: 2,
      lastSuccessAt: 7,
      lastPullAt: 8,
    });
  });

  it('记一次推送成功：写库也写内存，且不抹掉已有的拉取时刻', async () => {
    await putMeta(META_KEYS.syncStatus, { lastPullAt: 999 });
    await useSyncStore.getState().recordPushSuccess();

    const persisted = await getMeta<{ lastSuccessAt?: number; lastPullAt?: number }>(
      META_KEYS.syncStatus,
    );
    expect(persisted?.lastPullAt).toBe(999);
    expect(persisted?.lastSuccessAt).toBeGreaterThan(0);
    expect(useSyncStore.getState().lastSuccessAt).toBe(persisted?.lastSuccessAt);
  });

  it('markSessionExpired 立刻切回未登录（由同步链路的钩子调进来）', () => {
    useSyncStore.setState({ status: 'signed-in', account: ACCOUNT });
    useSyncStore.getState().markSessionExpired();
    expect(useSyncStore.getState()).toMatchObject({ status: 'signed-out', account: null });
    expect(useSyncStore.getState().errorMessage).toContain('重新登录');
  });
});
