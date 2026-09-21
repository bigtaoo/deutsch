import { useEffect, useState } from 'react';
import { Hint, Note, Section } from '@/components/ui';
import { pendingUpdateVersion, runningBuild, type RunningBuild } from '@/platform/nativeUpdate';

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
    </Section>
  );
}
