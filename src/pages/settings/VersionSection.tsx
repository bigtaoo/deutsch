import { useEffect, useState } from 'react';
import { Button, Disclosure, field, Hint, Note, Section } from '@/components/ui';
import {
  checkNativeUpdate,
  pendingUpdateVersion,
  probePlugins,
  readLastCheckLog,
  runningBuild,
  type CheckLogEntry,
  type RunningBuild,
} from '@/platform/nativeUpdate';
import {
  collectDeviceReport,
  reportToText,
  runUpdaterSelfTest,
  sendDeviceReport,
  type MethodOutcome,
} from '@/platform/bridgeDiag';
import { initSafeArea, safeAreaProbe, type Platform } from '@/platform/safeArea';
import { nativePlatform } from '@/platform/native';
import { wakeLockState } from '@/platform/wakeLock';

// 版本（SPEC §12.12 / 变更 41）。**这一块存在的唯一理由是让热更不是黑箱** ——
// 接了热更之后「我手机上到底是哪一版」不再能从 App Store 的版本号推出来：
// 壳的版本和跑着的前端版本从此是两个数，而且大多数时候不一样。
//
// 形状按 §12.3：平时是静默的两行事实（`Hint` 那一档，不是状态），只有「下好了等着
// 生效」时才升到一行提示（`Note`）。不给「立刻换上这一版」的按钮 —— 那是整个
// WebView 重载，会清掉只活在 React state 里的听写答案，而这一页恰恰可以从练习中途进来。
// （变更 52 加的是另一个按钮：「查一次」，不是「换一次」，见下方那段。）
//
// ── 这一块绝不能把自己整块抹掉（2026-09-22 真机修） ──
// 原来第一行是 `if (build === undefined) return null;`，而 `build` 来自一个**过原生桥**
// 的调用。桥调用失败的方式不只是 reject —— 插件没注册、原生侧不回调，那个 Promise
// 就永远不 settle，于是 `build` 永远是 undefined，**整个「版本」块在 iPhone 上一次
// 都没出现过**（它从 0.4.0 起就在那儿了）。症状是「设置页翻到底，对齐后端下面什么都没有」。
//
// 现在：平台由 `nativePlatform()` 单独问（不过桥，只是一次动态 import），版本号问不出来
// 就如实写「问不出来」。**诊断块无论如何都画** —— 它正是用来回答「这台设备上到底
// 发生了什么」的，一个会在出问题时自己消失的诊断等于没有。
//
// ── 「现在就查一次更新」按钮（变更 52，2026-09-23）──
// 之前没有这个按钮，理由写在上面：立刻**换 bundle**是整个 WebView 重载，会清掉
// 只活在 state 里的听写答案。但「查一次」和「换一次」是两件事——查询只是后台一次
// `checkNativeUpdate()`，不碰当前跑着的这份前端，加它没有那条顾虑。加它的理由是
// 变更 50 那次死锁：没有 Mac、看不到 Xcode 控制台时，「push 了 main，手机到底拿到
// 没有」原来要等下次冷启动才能看到结果，现在能在设置页当场把这个回路闭上，
// 而且查完就能看见 `readLastCheckLog()` 那份逐步记录，不再是「查了但不知道发生了什么」。
/**
 * 「现在就查一次更新」最多转多久（变更 57）。
 *
 * `checkNativeUpdate()` 里每一步都有自己的超时，加起来最坏约 113 秒
 * （fetch 8 + 冷启动的 current 25 + download 45 + next 10，再留一点余量）。
 * 但**「每一步都有超时」不等于「整个函数一定会返回」** —— 真机上按钮就是一直转着，
 * 而那恰恰说明有个 `await` 没被任何一道超时盖到。这一层不负责找出是哪一个，
 * 只负责让按钮**一定**会放开。
 */
const CHECK_HARD_TIMEOUT_MS = 150_000;

export function VersionSection() {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [build, setBuild] = useState<RunningBuild | null | undefined>(undefined);
  const [pending, setPending] = useState<string | null>(null);
  const [log, setLog] = useState<CheckLogEntry | null>(() => readLastCheckLog());
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);

  useEffect(() => {
    void nativePlatform().then(setPlatform);
    void runningBuild().then(setBuild);
    // 启动时那次 checkNativeUpdate 通常早跑完了（App.tsx）；没跑完也不等它 ——
    // 下次进这一页就看得到。为一个诊断块去订阅一次性事件不值。
    setPending(pendingUpdateVersion());
  }, []);

  const runCheckNow = async (): Promise<void> => {
    setChecking(true);
    setCheckNote(null);
    try {
      // checkNativeUpdate() 的生产实现把所有失败都收在自己的 try/catch/finally 里，
      // 正常情况下不会 reject——但这一按钮不该把「它一定不会 reject」当成前提。
      // 少这个 catch 的话，一次意外的 reject 会变成未处理的 rejection，
      // 且下面 finally 之后不会再报错，用户看到的只是按钮修好了、但控制台炸了一下。
      //
      // **再加一道总闸**（变更 57）：里面每一步都有超时，但「每一步都有超时」不等于
      // 「整个函数一定会返回」——2026-09-23 真机上按钮就是一直转着不停，而那说明
      // 有某个 `await` 不在任何一道超时的覆盖范围里。这一层不管是哪一个：
      // 到点就把按钮放开，并且**明说它没有回来**，因为「按钮转个不停」本身
      // 是要报告的事实，不是一个可以让人一直等下去的状态。
      await Promise.race([
        checkNativeUpdate().catch(() => null),
        new Promise((resolve) =>
          setTimeout(() => {
            setCheckNote(
              `查了 ${Math.round(CHECK_HARD_TIMEOUT_MS / 1000)} 秒还没有回来 —— 下面「上次查更新」那一行停在哪一步，就是卡住的那一步。`,
            );
            resolve(null);
          }, CHECK_HARD_TIMEOUT_MS),
        ),
      ]);
    } finally {
      setChecking(false);
      // 查完这几个数可能都变了：build 里的 queued 字段、pending、以及诊断块要读的日志。
      void runningBuild().then(setBuild);
      setPending(pendingUpdateVersion());
      setLog(readLastCheckLog());
    }
  };

  return (
    <Section
      title="版本"
      aside={
        platform === 'ios' ? (
          <Button onClick={() => void runCheckNow()} disabled={checking}>
            {checking ? '查询中…' : '现在就查一次更新'}
          </Button>
        ) : undefined
      }
    >
      {platform === null ? (
        <Hint>正在问这台设备…</Hint>
      ) : platform === 'web' ? (
        <Hint>
          网页版 —— 有新版时会自己更新，不用做任何事（关掉标签页再打开就是最新的）。
        </Hint>
      ) : build === undefined ? (
        <Hint>正在问原生侧版本号…</Hint>
      ) : build === null ? (
        <Hint>这个壳不带热更（只有 iOS 壳有），换前端要重新装包。</Hint>
      ) : (
        <>
          {/* 两个数各问各的，所以可能只有一个问得出来 —— 那也比两个都不说强。 */}
          <Hint>
            应用壳 {build.native ?? '问不出来'} —— 换它要过 App Store。
            <br />
            前端{' '}
            {build.bundle === undefined
              ? '问不出来'
              : build.bundle === 'builtin'
                ? `${build.native ?? '壳'}（随包那份）`
                : build.bundle}
            {' '}—— 这一份会自己更新。
          </Hint>
          {/* 桥哑掉是**热更可能停摆**的信号，不是一句「只是显示不出来」就能带过的。
              2026-09-22 真机上正是这样：同一个桥把更新器也挂住了，手机连着五次冷启动
              纹丝不动，而修复本身是 JS、只能靠热更下发 —— 死锁只能发新包解开。
              现在更新器不再被它否决（decideUpdate 里「未知不许否决更新」），但这一行
              仍要把话说清楚：这台设备的桥有问题，连着几次不换版本就该发包了。 */}
          {(build.native === undefined || build.bundle === undefined) && (
            <Hint tone="warn">
              有版本号问不出来 —— 原生桥没回话。热更会绕开它照常更新，但要是连着几次打开
              都不换版本，就是这台设备的桥彻底哑了，只能发一个新包解开。
            </Hint>
          )}
          {/* 「下好了等生效」优先报这次会话里刚下的那个；没有就报上次留下的记号
              （它存在 localStorage，不过桥，所以桥哑了它还在）。 */}
          {pending ? (
            <Note tone="accent">新版 {pending} 已下好，下次打开这个应用时生效。</Note>
          ) : build.queued && !(build.bundle ?? '').endsWith(build.queued) ? (
            <Note tone="accent">
              新版 {build.queued} 已下好（上次打开时下的），下次打开这个应用时生效。
            </Note>
          ) : null}
        </>
      )}
      {checkNote && <Hint tone="warn">{checkNote}</Hint>}
      {/* **无论平台、无论版本号问没问出来都画。** 它正是用来回答「这台设备上到底
          发生了什么」的，而一个会在出问题时自己消失的诊断等于没有。 */}
      <DeviceDiagnostics log={log} />
    </Section>
  );
}

/**
 * 这台设备上那几个**只能在真机上问**的数（变更 46）。
 *
 * 进 `Disclosure` 而不是摆在外面：按 §12.3，诊断属于「要在但不该占主路径」的东西。
 *
 * 安全区那一行是为一个具体的故障留的：iPhone 13 上出现过
 * `env(safe-area-inset-top)` 解析成 0、吸顶导航压住状态栏。
 *
 * 常亮那一行分三种状况说，因为「屏幕没保持亮」有三个完全不同的成因、
 * 三个完全不同的下一步 —— 见 `wakeLockState()` 的注释。
 *
 * **插件注册与查更新日志**（变更 52）也在这里：`probePlugins()` 同步、不过桥，
 * 能把「类没链进这次构建」和「调用本身超时」这两种成因分开——前者要发新包，
 * 后者纯粹是等或重试，`log` 参数（`readLastCheckLog()`）则是上一次
 * `checkNativeUpdate()` 走到了哪一步、结论是什么。
 */
function DeviceDiagnostics({ log }: { log: CheckLogEntry | null }) {
  // 正常情况下 App.tsx 启动时已经量过一次，这里直接读那一份（免得两处数字对不上）。
  // **但不能只依赖它**：启动时那一次排在 `nativePlatform()` 之后，而那是个异步动态
  // import —— 它失败、或者哪天被挪了位置，这一块就只会显示「还没量」，
  // 而这一块正是用来在装包之前先问出一个数的。没有就现量一次。
  const [probe, setProbe] = useState(safeAreaProbe);
  useEffect(() => {
    if (probe) return;
    void nativePlatform().then((p) => setProbe(initSafeArea(p)));
  }, [probe]);

  // 常亮是**会变的状态**（进出练习界面、切后台），所以定时重读，不是读一次就定住。
  // 一秒一跳：这一块本来就是打开来盯着看的，而它只是读三个内存里的布尔量。
  const [lock, setLock] = useState(wakeLockState);
  useEffect(() => {
    const timer = setInterval(() => setLock(wakeLockState()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 插件注册情况是同步的（`window.Capacitor.PluginHeaders` 是原生侧启动时一次性
  // 注入的静态数据），不会在会话中途变化，读一次就够，不用像常亮那样定时重读。
  const pluginProbe = probePlugins();

  return (
    <Disclosure summary="这台设备的边距与常亮">
      {probe ? (
        <Hint tone={probe.fallbackApplied ? 'warn' : 'neutral'}>
          {/* **平台要写在最前面**：同一个 `env() = 0`，在桌面浏览器和 iPhone 的普通
              Safari 标签页里是**正确**的（web 内容本来就不在刘海底下），只有在
              `ios` 原生壳里才是故障。不写平台，就是让人拿一个 0 去猜三种含义。 */}
          平台 {probe.platform} · 屏幕 {window.screen?.width}×{window.screen?.height}
          <br />
          安全区：env() 报 上 {probe.top}px / 下 {probe.bottom}px
          {probe.fallbackApplied
            ? ` —— 报的是 0，已按屏幕尺寸兜底到 ${probe.fallbackTop}px`
            : probe.platform === 'ios'
              ? ' —— env() 是好的，顶部要是还压着状态栏，成因就在别处'
              : ' —— 不在原生壳里，这里本来就该是 0（兜底只在 iOS 壳上装）'}
        </Hint>
      ) : (
        <Hint>安全区：还没量（应用刚启动那一下才量）。</Hint>
      )}

      {/* **除了此刻的状态，还要报「上一次申请的结果」。** 申请发生在应用挂载那一刻，
          而人是过一会儿才走到这一页来看的；中间可能切过后台（系统收走锁、回来再申请），
          也可能一开始就被拒了。只报此刻状态说不清「刚才那次到底成没成」。
          **iOS 上现在有两道防线**（变更 52）：这一行报的是 Web Wake Lock 那道，
          原生侧 `SceneDelegate.isIdleTimerDisabled` 那道不经过 JS、这里看不到、
          也不需要看到 —— 它坏不坏跟这一行的结果无关。 */}
      <Hint tone={!lock.supported || lock.lastResult === 'rejected' ? 'warn' : 'neutral'}>
        屏幕常亮（Web API）：
        {!lock.supported
          ? '这台 WebView 没有 Screen Wake Lock。'
          : lock.held
            ? '锁拿着，这个应用开着的时候屏幕不会自己灭（切到别的 App 或手动锁屏时系统会收回）。'
            : lock.lastResult === 'rejected'
              ? `最近一次申请（${formatAgo(lock.lastAgoMs)}前）被拒了`
                + (lock.lastErrorName ? `（${lock.lastErrorName}${lock.lastErrorMessage ? `：${lock.lastErrorMessage}` : ''}）` : '')
                + ' —— 已经排了下一次用户手势自动重试。'
              : lock.lastResult === 'ok'
                ? `最近一次申请（${formatAgo(lock.lastAgoMs)}前）拿到过锁，但这一刻没拿着。`
                : '还没申请到 —— 页面刚打开或正处在后台时会是这样，回到前台几秒后再看。'}
        {/* iOS 壳上另有不经过这层 API 的原生开关，坏了才需要出新包；低电量模式
            两道防线都拦不住，这一档只能如实说，没有代码能治。 */}
        {probe?.platform === 'ios' && (
          <>
            <br />
            iOS 壳另有原生接管（isIdleTimerDisabled），不依赖这个 Web API——上面这一行
            被拒不代表屏幕真的会灭。低电量模式下两道都会被系统忽略，那一档没有代码能治。
          </>
        )}
      </Hint>

      {/* 插件注册与上次查更新的完整记录（变更 52）。见文件头「诊断」那段：
          `updaterRegistered=false` 是「类没链进二进制」，要发新包；日志里的
          `xxx:timeout` 是「调用本身没人回」，纯粹是桥的事，下一版可能就好了 ——
          两种成因分得开，下一步才分得开。 */}
      {probe?.platform === 'ios' && (
        <Hint tone={pluginProbe.updaterRegistered ? 'neutral' : 'warn'}>
          插件注册：{pluginProbe.registered.length} 个
          {pluginProbe.registered.length > 0 ? `（${pluginProbe.registered.join('、')}）` : ''}
          <br />
          {pluginProbe.updaterRegistered
            ? `CapacitorUpdater 注册成功，方法：${pluginProbe.updaterMethods?.join('、') || '（空）'}`
            : 'CapacitorUpdater 不在这份名单里 —— 这不是调用超时，是这个类没链进这次构建，热更这一版起不来，只能发新包。'}
        </Hint>
      )}
      {/* **没有记录这件事本身就要说出来**（变更 57）。变更 52 当初定的是「从没查过就
          不画，别留一个空壳」——2026-09-23 的真机反馈把这条立场推翻了：用户报的正是
          「没有『上次查更新』这个信息，也没有步骤的信息」，而那时候这一块不画，
          于是这条**最强的线索**在界面上长得和「一切正常、只是还没查过」一模一样。
          （记录现在是逐步落盘的，见 `startCheckLog()`：连「开始了」那一笔都没有，
          就说明它连第一行都没跑到，或者这台设备根本写不了 localStorage。） */}
      {log ? (
        <Hint>
          上次查更新（{formatAgo(Date.now() - log.at)}前）：{log.outcome}
          <br />
          步骤：{log.steps.length > 0 ? log.steps.join(' → ') : '（还没走到任何一步）'}
        </Hint>
      ) : (
        <Hint tone="warn">
          从来没有记下过一次查更新 —— 连「开始了」那一笔都没有。查更新现在是每一步
          立刻落盘的，所以这说明它连第一行都没跑到，或者这台设备写不了 localStorage。
        </Hint>
      )}
      {probe?.platform === 'ios' && <BridgeSelfTest />}
    </Disclosure>
  );
}

/**
 * 桥自检与诊断上报（变更 56）。
 *
 * ── 为什么要逐个方法试 ──
 * 「原生桥没回话」这一句底下至少压着四种故障，而它们的下一步完全不同：插件类没注册
 * （要动 Swift）、插件实例整个造不出来（要换方案）、只是**头一次调用慢**（插件 `load()`
 * 在主线程做一大堆磁盘活，我们等 4 秒就放弃了——那只要放宽超时）、或者只有某一个方法
 * 坏了。把一组只读方法串行试一遍、各自计时，这四种就有了各自的形状：全哑、头一个特别慢
 * 后面都快、个别哑。见 `src/platform/bridgeDiag.ts` 顶部。
 *
 * ── 为什么两个出口都要有 ──
 * 「发到服务器」省事，但它要求登录是好的；而诊断真正用得上的时候，坏的可能正是登录。
 * 所以「复制诊断」是一条完全不经过网络的平行路，剪贴板再被 WKWebView 拒掉，
 * 还能退到「把文本摊开来自己选中」。**一个在出问题时会自己失效的诊断出口等于没有。**
 */
function BridgeSelfTest() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<MethodOutcome[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // 剪贴板被拒时把全文摊在这里让他自己选 —— 和 ZhPanel 那条退路同一个理由。
  const [rawText, setRawText] = useState<string | null>(null);

  const run = async (): Promise<MethodOutcome[]> => {
    setRunning(true);
    setStatus(null);
    try {
      const r = await runUpdaterSelfTest().catch(() => []);
      setResults(r);
      return r;
    } finally {
      setRunning(false);
    }
  };

  // 发之前先确保真的有一份自检结果：一份没有自检的报告基本说明不了问题，
  // 而「我点了发送」到「服务器上那份没用」之间隔着一次出包，代价太大。
  const send = async (): Promise<void> => {
    setStatus('正在收集…');
    const selfTest = results ?? (await run());
    setStatus('正在发送…');
    try {
      const report = await collectDeviceReport(selfTest);
      const { id } = await sendDeviceReport(report);
      setStatus(`已发送：${id}`);
    } catch (err) {
      setStatus(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const copy = async (): Promise<void> => {
    setStatus('正在收集…');
    const selfTest = results ?? (await run());
    const text = reportToText(await collectDeviceReport(selfTest));
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已复制到剪贴板');
      setRawText(null);
    } catch {
      // WKWebView 可能直接拒掉剪贴板 —— 不假装成功，摊开来让他自己选。
      setRawText(text);
      setStatus('剪贴板用不了，下面这段自己选中复制');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void run()} disabled={running}>
          {running ? '自检中…' : '跑一次桥自检'}
        </Button>
        <Button onClick={() => void send()} disabled={running}>
          发到服务器
        </Button>
        <Button onClick={() => void copy()} disabled={running}>
          复制诊断
        </Button>
      </div>
      {/* 自检最长可能跑一分多钟（桥没回过话时每个调用都按冷启动给足时间），
          不先说一句的话会以为是又卡住了 —— 而「又卡住了」正是这一块要查的东西。 */}
      <Hint>
        自检会把更新器的只读方法逐个调一遍，桥要是不回话，每个最多等 25 秒，
        整轮可能要一两分钟。耗时本身就是答案，请等它跑完。
      </Hint>
      {results && results.length > 0 && (
        <Hint tone={results.some((r) => r.outcome === 'timeout') ? 'warn' : 'neutral'}>
          {results.map((r) => (
            <span key={r.method}>
              {r.method} → {r.outcome}（{r.ms}ms）
              <br />
            </span>
          ))}
        </Hint>
      )}
      {status && <Hint>{status}</Hint>}
      {rawText && (
        <textarea readOnly value={rawText} rows={10} className={`${field} w-full p-2 font-mono text-note`} />
      )}
    </div>
  );
}

/** `3 秒` / `2 分钟` / `1 小时`。诊断行里的相对时刻，精度到这一档就够。 */
function formatAgo(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  return `${Math.round(min / 60)} 小时`;
}
