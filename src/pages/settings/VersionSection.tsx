import { useEffect, useState } from 'react';
import { Disclosure, Hint, Note, Section } from '@/components/ui';
import { pendingUpdateVersion, runningBuild, type RunningBuild } from '@/platform/nativeUpdate';
import { initSafeArea, safeAreaProbe } from '@/platform/safeArea';
import { nativePlatform } from '@/platform/native';
import { wakeLockSupported } from '@/platform/wakeLock';

// 版本（SPEC §12.12 / 变更 41）。**这一块存在的唯一理由是让热更不是黑箱** ——
// 接了热更之后「我手机上到底是哪一版」不再能从 App Store 的版本号推出来：
// 壳的版本和跑着的前端版本从此是两个数，而且大多数时候不一样。
//
// 形状按 §12.3：平时是静默的两行事实（`Hint` 那一档，不是状态），只有「下好了等着
// 生效」时才升到一行提示（`Note`）。不给「现在就更新」的按钮 —— 立刻换 bundle 是整个
// WebView 重载，会清掉只活在 React state 里的听写答案，而这一页恰恰可以从练习中途进来。
export function VersionSection() {
  const [build, setBuild] = useState<RunningBuild | null | undefined>(undefined);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    void runningBuild().then(setBuild);
    // 启动时那次 checkNativeUpdate 通常早跑完了（App.tsx）；没跑完也不等它 ——
    // 下次进这一页就看得到。为一个诊断块去订阅一次性事件不值。
    setPending(pendingUpdateVersion());
  }, []);

  if (build === undefined) return null;

  return (
    <Section title="版本">
      {build === null ? (
        <Hint>
          网页版 —— 有新版时会自己更新，不用做任何事（关掉标签页再打开就是最新的）。
        </Hint>
      ) : (
        <>
          <Hint>
            应用壳 {build.native} —— 换它要过 App Store。
            <br />
            前端 {build.bundle === 'builtin' ? `${build.native}（随包那份）` : build.bundle}
            {' '}—— 这一份会自己更新。
          </Hint>
          {pending && <Note tone="accent">新版 {pending} 已下好，下次打开这个应用时生效。</Note>}
        </>
      )}
      {/* **两个分支都要有**。原来它只挂在原生那一支上，理由是「浏览器上这两条没有争议」——
          那句话是错的：iPhone 上的 Safari 与主屏 PWA 也各有一套安全区行为，而它们恰恰是
          「原生壳上 env() 为什么是 0」的对照组。更实际的是，把它藏进原生分支意味着
          **只有装了新包的人才看得到它**，而这一块存在的理由就是在装包之前先问出一个数。 */}
      <DeviceDiagnostics />
    </Section>
  );
}

/**
 * 这台设备上两个**只能在真机上问**的数（变更 46）。
 *
 * 进 `Disclosure` 而不是摆在外面：按 §12.3，诊断属于「要在但不该占主路径」的东西。
 * **浏览器上也画**：见上面那段 —— 藏进原生分支等于「装了新包才看得到」，
 * 而它就是用来在装包之前先问出一个数的。
 *
 * 安全区那一行是为一个具体的故障留的：iPhone 13 上出现过
 * `env(safe-area-inset-top)` 解析成 0、吸顶导航压住状态栏。兜底已经装上了
 * （safeArea.ts），但**成因没有验过**，而这一行把它一眼验完：
 * 写着「env 报 47」就说明 env 是好的、问题在别处；写着「env 报 0，已兜底到 47」
 * 就说明嫌疑成立，下一步该去动 capacitor.config.ts 的 contentInset。
 */
function DeviceDiagnostics() {
  // 正常情况下 App.tsx 启动时已经量过一次，这里直接读那一份（免得两处数字对不上）。
  // **但不能只依赖它**：启动时那一次排在 `nativePlatform()` 之后，而那是个异步动态
  // import —— 它失败、或者哪天被挪了位置，这一块就只会显示「还没量」，
  // 而这一块正是用来在装包之前先问出一个数的。没有就现量一次。
  const [probe, setProbe] = useState(safeAreaProbe);
  useEffect(() => {
    if (probe) return;
    void nativePlatform().then((platform) => setProbe(initSafeArea(platform)));
  }, [probe]);

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
      <Hint tone={wakeLockSupported() ? 'neutral' : 'warn'}>
        {wakeLockSupported()
          ? '屏幕常亮：这台设备支持，练习界面上会一直亮着（切走或锁屏自动释放）。'
          : '屏幕常亮：这台 WebView 不支持 —— 练习时屏幕仍会按系统的自动锁屏时间灭掉。'}
      </Hint>
    </Disclosure>
  );
}
