import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 配色的**数值**判据（变更 86 / §12.24）。
 *
 * 为什么要有这一份：这次改动的全部价值就在两个数字上 —— 正文对比度从 17.5:1（浅色）
 * 和 15.2:1（深色）降到 11~12:1。而在这之前，CSS 里那十来个色值没有任何东西守着，
 * 下一次有人觉得「字不够黑」顺手改回 `#1a1918`，只会在几个月后以「晚上刺眼」的形式
 * 再报一次 —— 而那时谁也想不起来这是一次回退。
 *
 * 所以这里把区间写死，两头都卡：
 * - **下限 7:1**（WCAG AAA 正文）：别为了柔和把字弄得看不清；
 * - **上限 13:1**：别再回到「一块白板上的黑洞」。舒适阅读一般取 7~12，留一点余量。
 *
 * 读的是 `src/index.css` 的原文而不是运行时的 `getComputedStyle` —— jsdom 不跑
 * Tailwind，`@theme` 在那里根本不会变成真的自定义属性。
 * 路径从 `process.cwd()`（= 仓库根）起算：jsdom 环境里的 `import.meta.url` 不是
 * `file:` scheme，`fileURLToPath` 会当场抛。
 */

const CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** 第一个 `@media (prefers-color-scheme: dark)` 之前是浅色令牌，之后是深色覆盖。 */
const DARK_AT = CSS.indexOf('@media (prefers-color-scheme: dark)');

function tokensIn(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const light = tokensIn(CSS.slice(0, DARK_AT));
const dark = { ...light, ...tokensIn(CSS.slice(DARK_AT)) };

/** WCAG 2.x 相对亮度。 */
function luminance(hex: string): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('颜色令牌的对比度', () => {
  it('两套令牌都解析得出来 —— 解析失败会让下面每一条都变成空断言', () => {
    expect(Object.keys(light).length).toBeGreaterThan(10);
    expect(DARK_AT).toBeGreaterThan(0);
    expect(dark.surface).not.toBe(light.surface);
    expect(dark.ink).not.toBe(light.ink);
  });

  for (const [name, t] of [
    ['浅色', light],
    ['深色', dark],
  ] as const) {
    describe(name, () => {
      it('正文（ink）落在 7~13:1 —— 下限是看得清，上限是不刺眼', () => {
        for (const bg of ['surface', 'raised', 'sunken'] as const) {
          const ratio = contrast(t.ink, t[bg]);
          expect(ratio, `ink on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(7);
          expect(ratio, `ink on ${bg} = ${ratio.toFixed(2)}:1`).toBeLessThanOrEqual(13);
        }
      });

      it('次要说明（muted）≥ 4.5:1，编号与单位（faint）≥ 3:1', () => {
        expect(contrast(t.muted, t.raised)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.faint, t.raised)).toBeGreaterThanOrEqual(3);
      });

      it('主按钮上的字（accent-ink on accent）≥ 4.5:1', () => {
        expect(contrast(t['accent-ink'], t.accent)).toBeGreaterThanOrEqual(4.5);
      });

      it('三档语义色各自配得住自己的 -soft 底 ≥ 4.5:1', () => {
        for (const tone of ['ok', 'warn', 'danger'] as const) {
          const ratio = contrast(t[tone], t[`${tone}-soft`]);
          expect(ratio, `${tone} on ${tone}-soft = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      });

      it('卡片与页面底分得开，但都不是纯白／纯黑 —— 一整屏纯白就是一块灯板', () => {
        expect(t.raised).not.toBe('#ffffff');
        expect(t.surface).not.toBe('#ffffff');
        expect(t.surface).not.toBe('#000000');
        expect(t.raised).not.toBe(t.surface);
      });
    });
  }
});

describe('减弱动态效果', () => {
  it('系统开了就把动画关掉 —— 跟读时长期在动的只有录音点和倒计时条', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });
});

describe('index.html 的 theme-color', () => {
  it('深色那条跟深色的 --color-surface 一致（§12.5）', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const m = html.match(
      /<meta name="theme-color" content="(#[0-9a-f]{6})" media="\(prefers-color-scheme: dark\)"/,
    );
    expect(m?.[1]).toBe(dark.surface);
  });
});
