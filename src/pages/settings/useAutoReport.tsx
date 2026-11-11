// 诊断按钮的自动上报（变更 88）。
//
// 这个 hook 存在的全部理由是**让六个按钮各自只多一行代码**。它们分散在四个文件里
// （SettingsPage / DictSection / RestoreSection / VersionSection），形状各不相同 ——
// 有的在 `aside` 里、有的带 1.7 秒延时、有的要等一轮自检。要是每处各写一遍
// 「收集 → 发 → 显示一行 → 吞掉错误」，第七个按钮加进来时一定会漏掉其中一步，
// 而漏掉的最可能是「显示那一行」—— 静默的自动上报等于没上报。
//
// 为什么返回的是一个现成的节点而不是字符串：调用处就不用再记得去画它。
// 节点在没上报过时是 `null`，画出来等于什么都没有。

import { useCallback, useState, type ReactNode } from 'react';
import { autoSendReport, type DiagTrigger, type MethodOutcome } from '@/platform/bridgeDiag';
import { Hint } from '@/components/ui';

export interface AutoReport {
  /** 直接塞进 JSX 的那一行字；没上报过时是 `null`。 */
  note: ReactNode;
  /** 按钮干完活之后调一次。`note` 是那个按钮自己在界面上显示的结论。 */
  report: (opts?: { note?: string; selfTest?: MethodOutcome[] }) => void;
}

export function useAutoReport(trigger: DiagTrigger): AutoReport {
  const [line, setLine] = useState<string | null>(null);

  const report = useCallback(
    (opts?: { note?: string; selfTest?: MethodOutcome[] }) => {
      setLine('正在上报…');
      // `autoSendReport` 自己永不抛 —— 这里不再 catch 一道，省得把「它不抛」这件事
      // 变成两处都要维护的约定。
      void autoSendReport(trigger, opts ?? {}).then(setLine);
    },
    [trigger],
  );

  return {
    note: line === null ? null : <Hint>{line}</Hint>,
    report,
  };
}
