// 界面词汇表（SPEC §12）。
//
// 这里刻意不是「设计系统」，但它比之前那句「不做设计系统，只是别让 className 长串重复」
// 多担一件事：**它是三档状态语言的实现**（§12.3）。在它之前，任何状态都长成一个
// 整宽的彩色横幅加一段解释设计取舍的散文 —— 于是首页在你看到第一课之前先给你三层壳，
// 而黄底红底同时出现时你分不清哪个要求你现在停下来。
//
//   静默    一切正常 → 什么都不画
//   Note    需要知道但不挡路 → 单行、无底色、一个圆点标色
//   Banner  这一页现在做不了 → 有底色，且必须有一句话的标题 + 一个当场能解决的出口
//
// 那个必填的 `title` 是故意的：它逼作者把事情在一行里说完。设计理由留在代码注释
// 和 SPEC 里 —— 界面上只留「怎么办」。

import { useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:opacity-90',
  secondary: 'border border-line-strong bg-raised text-ink hover:bg-sunken',
  ghost: 'text-muted hover:bg-sunken',
  danger: 'border border-danger bg-raised text-danger hover:bg-danger-soft',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`rounded-ctl px-3 py-1.5 text-ui disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
  );
}

/** 输入类控件的统一外观。散落各页的 `rounded border border-neutral-300 …` 全换成它。 */
export const field =
  'rounded-ctl border border-line-strong bg-raised text-ui text-ink placeholder:text-faint focus:border-accent focus:outline-none';

/** 区块容器。圆角只有两档，容器一律 box（§12.5）。 */
export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-3 rounded-box border border-line bg-raised p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** 没有标题的容器：复习卡面、跟读当前句这类「内容自己就是标题」的地方。 */
export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-box border border-line bg-raised ${className}`}>{children}</div>;
}

/** 说明文字。13px + muted，是排版四级里最低的一级（§12.4）。 */
export function Hint({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' | 'danger' | 'ok' }) {
  const tones = {
    neutral: 'text-muted',
    warn: 'text-warn',
    danger: 'text-danger',
    ok: 'text-ok',
  };
  return <p className={`text-note ${tones[tone]}`}>{children}</p>;
}

const DOT_TONES = {
  neutral: 'bg-faint',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
} as const;

export type NoteTone = keyof typeof DOT_TONES;

/**
 * 「一行」那一档：需要知道，但不该挡路。
 *
 * 无底色、无边框，只有一个 6px 的圆点带颜色。它替掉了以前大量 `Banner tone="info"`——
 * 那些横幅说的都是「顺便告诉你一声」，却长得和「你现在过不去」一模一样。
 */
export function Note({
  tone = 'neutral',
  action,
  children,
}: {
  tone?: NoteTone;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 text-note text-muted">
      <span className={`mt-[0.45em] size-1.5 shrink-0 rounded-full ${DOT_TONES[tone]}`} />
      {/* action 跟在文字后面而不是推到最右：一行短提示配一个贴着屏幕边缘的链接，
          两者看起来是不相干的两样东西。 */}
      <div className="min-w-0 flex-1">
        {children}
        {action && <span className="ml-2 inline-flex items-center gap-2">{action}</span>}
      </div>
    </div>
  );
}

/**
 * 「拦路」那一档：这一页现在做不了。有底色，`title` 必填，`action` 强烈建议给。
 *
 * 只有 warn / danger / ok 三种色 —— info 那一种被删了，因为「顺便说一声」属于 Note。
 */
export function Banner({
  tone,
  title,
  action,
  children,
}: {
  tone: 'warn' | 'danger' | 'ok';
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const tones = {
    warn: 'border-warn/40 bg-warn-soft text-warn',
    danger: 'border-danger/40 bg-danger-soft text-danger',
    ok: 'border-ok/40 bg-ok-soft text-ok',
  };
  return (
    <div className={`space-y-2 rounded-box border px-4 py-3 text-ui ${tones[tone]}`}>
      <p className="font-semibold">{title}</p>
      {children && <div className="space-y-1 text-ink/85">{children}</div>}
      {action && <div className="flex flex-wrap items-center gap-2 pt-1">{action}</div>}
    </div>
  );
}

/** 小标签。替掉散落各处的 `rounded bg-amber-100 px-2 py-0.5 text-xs`。 */
export function Chip({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    neutral: 'bg-sunken text-muted',
    accent: 'bg-accent-soft text-accent',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
  };
  return (
    <span title={title} className={`shrink-0 rounded-full px-2 py-0.5 text-note ${tones[tone]}`}>
      {children}
    </span>
  );
}

/**
 * 折叠块。诊断信息、许可署名、参数解释这类「要在，但不该占主路径」的东西放进来。
 *
 * 用原生 `<details>`：键盘可达、无 JS 状态、打印时能全部展开。
 */
export function Disclosure({
  summary,
  defaultOpen = false,
  children,
}: {
  summary: string;
  /** 有内容时默认展开（FR-20 的笔记）—— 折叠块用来收纳，不是用来藏东西。 */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  // 展开状态放进 state 并由 onToggle 回写：`open` 这个 prop 是受控的，
  // 而这个组件会出现在**每帧重渲染**的页面上（通听播放时走 rAF）——
  // 直接把 defaultOpen 钉在 open 上，用户折叠之后下一帧就会被强行弹开。
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="group" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer list-none text-note text-muted hover:text-ink">
        <span className="inline-block w-3 transition-transform group-open:rotate-90">›</span> {summary}
      </summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  );
}

/**
 * 文件选择器。原生 `<input type="file">` 渲染出来是一句英文（「Choose File / No file
 * chosen」）加一个和这套令牌毫无关系的灰框，而它出现的位置恰好是「素材未下载」那条
 * 拦路横幅里唯一的出口。这里把真正的 input 藏起来，label 当按钮用 —— 点 label 会
 * 触发它关联的 input，不需要 JS。
 */
export function FilePicker({
  accept,
  children,
  onPick,
}: {
  accept: string;
  children: ReactNode;
  onPick: (file: File | undefined) => void;
}) {
  return (
    <label
      className={`inline-flex cursor-pointer items-center rounded-ctl px-3 py-1.5 text-ui ${VARIANTS.secondary}`}
    >
      {children}
      <input
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          // 清空之后选同一个文件还能再触发一次 change
          e.target.value = '';
        }}
      />
    </label>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-box border border-dashed border-line-strong p-8 text-center text-ui text-muted">
      {children}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 秒 → `m:ss.s`，标注界面要看得见十分之一秒（FR-4.5 的 ±0.1s 微调）。 */
export function formatTime(seconds: number | undefined, decimals = 1): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  // 秒数补到两位整数：`0:18.4`，不是 `0:018.4`。小数点和小数位各自额外占位。
  const width = decimals > 0 ? 3 + decimals : 2;
  return `${m}:${s.toFixed(decimals).padStart(width, '0')}`;
}
