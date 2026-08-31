// 几个反复出现的样式片段。个人工具，不做设计系统，只是别让 className 长串在每个页面里重复。

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-neutral-800 text-white hover:bg-neutral-700',
  secondary: 'border border-neutral-300 bg-white hover:bg-neutral-50',
  ghost: 'text-neutral-600 hover:bg-neutral-100',
  danger: 'border border-red-300 bg-white text-red-700 hover:bg-red-50',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`rounded px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Hint({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' | 'error' | 'ok' }) {
  const tones = {
    neutral: 'text-neutral-500',
    warn: 'text-amber-700',
    error: 'text-red-700',
    ok: 'text-emerald-700',
  };
  return <p className={`text-sm ${tones[tone]}`}>{children}</p>;
}

export function Banner({ tone, children }: { tone: 'warn' | 'error' | 'ok' | 'info'; children: ReactNode }) {
  const tones = {
    warn: 'border-amber-300 bg-amber-50 text-amber-900',
    error: 'border-red-300 bg-red-50 text-red-900',
    ok: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    info: 'border-sky-300 bg-sky-50 text-sky-900',
  };
  return <div className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">{children}</div>;
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
