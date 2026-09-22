// 启动时序：哪些事必须等「表读完」，哪些事**一秒都不能等**。
//
// ── 为什么这段逻辑值得单独拿出来 ──
// 它原来是 App.tsx 里的一个 `Promise.allSettled(...).then(...)`，四件事排在一起。
// 但这四件事对「表还没读完」的容忍度完全不同，而混在一个 then 里看不出这个区别：
// 只要有**一个** load 永远不 settle，四件事就一件都不会发生。
//
// ── `allSettled` 挡不住的那种坏法 ──
// 原来那行的注释写的是「allSettled 而不是 all：某张表读挂了也得关」—— 想到的是 reject。
// 但 Promise 失败的方式不只是 reject：**永远不 settle** 的那种，`allSettled` 一样接不住
// （它要等每一个都有结果）。IndexedDB 真会这样：`open()` 撞上另一个连接占着旧版本时会
// 触发 `blocked`，那个请求就一直悬着，不成功也不失败。
//
// 后果是连锁的，而且每一条都不报错：
//   · 启动图不关 —— 原生壳里 `launchAutoHide: false`，关它的人就是下面这个回调；
//   · `notifyAppReady()` 不调 —— 热更插件 20 秒后判定这个 bundle 起不来，**回滚**；
//   · 查更新不跑 —— 于是连「下一版能修好它」都没有了。
// 三条合起来就是：一张表卡住 = 这台设备退回旧 bundle 并且再也更新不动。
// 2026-09-22 刚在更新器自己身上踩过一模一样的坑（变更 50），那次的代价是发一次 TestFlight。
//
// ── 所以分成两档 ──
// `onAlive`（关启动图 / 取消回滚倒计时 / 查更新）**最多等 `timeoutMs`**：它回答的是
// 「这个 bundle 活着吗」，而一个表读得慢的应用仍然是活着的。宁可早一点说「活着」，
// 也不要因为一张表把整个 bundle 判死。
//
// `onStoresReady`（同步）**老老实实等全部 settle，不设超时**：拉取会往库里写，写完由
// `onRemoteDataWritten` 让 store 重读；初次 `load()` 要是晚于那次重读，界面就退回到
// 拉取之前的旧值了。这条顺序约束是真的，不能为了「快一点」破掉 —— 而且它坏掉的方式
// 是「界面显示旧数据」，比回滚轻得多，不值得用超时去换。

/**
 * 最多等多久就认定「这个 bundle 是活的」。
 *
 * 上限由热更插件定：`notifyAppReady()` 的回滚倒计时是 20 秒（SPEC §7.12），所以这个数
 * 必须明显小于它，留够「超时之后那几个回调自己也要跑一会儿」的余量。8 秒对正常冷启动
 * 绰绰有余（五张表都是几百 KB 的标注层），又给回滚留了 12 秒的安全边际。
 */
const ALIVE_TIMEOUT_MS = 8000;

export interface BootOptions {
  /** 启动时要读的那几张表。 */
  loads: Promise<unknown>[];
  /**
   * 「应用起来了」：关启动图、取消热更的回滚倒计时、查更新。
   * **最多等 `timeoutMs`**，因为一张读不完的表不该让整个 bundle 被判死。只会调用一次。
   */
  onAlive: () => void;
  /**
   * 「表真的读完了」：同步。**不设超时** —— 它有一条真实的顺序约束（见文件头）。
   * 有表永远不 settle 时它就是不会被调用，这是对的。
   */
  onStoresReady: () => void;
  timeoutMs?: number;
}

/**
 * 排一次启动。同步返回，两个回调各自异步触发。
 *
 * @see BootOptions 两个回调为什么一个有超时一个没有
 */
export function scheduleBoot({
  loads,
  onAlive,
  onStoresReady,
  timeoutMs = ALIVE_TIMEOUT_MS,
}: BootOptions): void {
  const settled = Promise.allSettled(loads);

  // 「活着」只说一次：超时说过了，表后来读完也不再说第二遍。
  let announced = false;
  const announceAlive = () => {
    if (announced) return;
    announced = true;
    onAlive();
  };

  const timer = setTimeout(announceAlive, timeoutMs);
  void settled.then(() => {
    clearTimeout(timer);
    announceAlive();
    onStoresReady();
  });
}
