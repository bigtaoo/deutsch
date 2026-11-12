import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEME_COLOR } from '@/app/theme';

/**
 * 配色的**数值**判据（变更 86 / §12.24，变更 90 起扩到三档 / §12.25）。
 *
 * 为什么要有这一份：那次改动的全部价值就在两个数字上 —— 正文对比度从 17.5:1（浅色）
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
const HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

/** 取 `marker` 那个选择器后面那一整块（到行首的 `}` 为止）。找不到就抛，不许静默返回空块。 */
function blockAfter(marker: string): string {
  const at = CSS.indexOf(marker);
  if (at < 0) throw new Error(`index.css 里找不到 ${marker} —— 配色块被改名或删掉了`);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('\n}', open);
  if (open < 0 || close < 0) throw new Error(`${marker} 这一块没闭合`);
  return CSS.slice(open, close);
}

function tokensIn(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// 浅色是 @theme 里的基准值，深色与夜间各自只覆盖一部分，所以要铺在浅色之上。
const light = tokensIn(blockAfter('@theme'));
const dark = { ...light, ...tokensIn(blockAfter(":root[data-theme='dark']")) };
const night = { ...light, ...tokensIn(blockAfter(":root[data-theme='night']")) };

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
  it('三套令牌都解析得出来 —— 解析失败会让下面每一条都变成空断言', () => {
    expect(Object.keys(light).length).toBeGreaterThan(10);
    for (const t of [dark, night]) {
      expect(t.surface).not.toBe(light.surface);
      expect(t.ink).not.toBe(light.ink);
    }
    expect(night.surface).not.toBe(dark.surface);
  });

  for (const [name, t] of [
    ['浅色', light],
    ['深色', dark],
    ['夜间', night],
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

      it('当前词的反白配色站得住（§12.17：warn 实底 + surface 字）≥ 4.5:1', () => {
        const ratio = contrast(t.surface, t.warn);
        expect(ratio, `surface on warn = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      });

      it('卡片与页面底分得开，但都不是纯白／纯黑 —— 一整屏纯白就是一块灯板', () => {
        expect(t.raised).not.toBe('#ffffff');
        expect(t.surface).not.toBe('#ffffff');
        expect(t.surface).not.toBe('#000000');
        expect(t.raised).not.toBe(t.surface);
      });
    });
  }

  it('夜间确实比深色更暗 —— 否则这一档白加（变更 90 的全部理由）', () => {
    // 底色更暗、字也更暗：只压底色的话字会浮在上面更扎眼，正是这次要消灭的东西。
    for (const token of ['surface', 'raised', 'sunken', 'ink', 'accent'] as const) {
      expect(
        luminance(night[token]),
        `${token}: 夜间 ${night[token]} vs 深色 ${dark[token]}`,
      ).toBeLessThan(luminance(dark[token]));
    }
  });
});

describe('减弱动态效果', () => {
  it('系统开了就把动画关掉 —— 跟读时长期在动的只有录音点和倒计时条', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });
});

describe('index.html 的主题引导（§12.25）', () => {
  it('深浅不再由媒体查询决定 —— 令牌块里不许再出现 prefers-color-scheme', () => {
    // 留着它就会和 data-theme 打架：系统浅色 + 手动夜间时两边给出相反的答案。
    // `color-scheme` 那几行和 reduced-motion 不在此列，所以只查令牌块本身。
    expect(blockAfter(":root[data-theme='dark']")).not.toContain('prefers-color-scheme');
    // 只查**规则**，不查注释 —— 文件头那段讲的就是「以前这里写的是媒体查询」。
    expect(CSS).not.toMatch(/@media \(prefers-color-scheme: dark\)\s*\{/);
  });

  it('只有一条 theme-color，且带 id 供脚本改写', () => {
    const metas = HTML.match(/<meta[^>]*name="theme-color"[^>]*>/g) ?? [];
    expect(metas).toHaveLength(1);
    expect(metas[0]).toContain('id="theme-color"');
  });

  it('内联脚本在首次绘制前跑 —— 排在 main.tsx 那条 module 之前', () => {
    const inline = HTML.indexOf("setAttribute('data-theme'");
    const entry = HTML.indexOf('src="/src/main.tsx"');
    expect(inline).toBeGreaterThan(0);
    expect(inline).toBeLessThan(entry);
  });

  it('脚本里的三个状态栏色值和 theme.ts、index.css 对得上', () => {
    // 三处各写一遍是没办法的事（内联脚本不能 import），所以这条守着它们一致。
    const m = HTML.match(
      /\{\s*light:\s*'(#[0-9a-f]{6})',\s*dark:\s*'(#[0-9a-f]{6})',\s*night:\s*'(#[0-9a-f]{6})'\s*\}/,
    );
    expect(m, 'index.html 里那张 {light,dark,night} 颜色表没找到').toBeTruthy();
    expect([m![1], m![2], m![3]]).toEqual([
      THEME_COLOR.light,
      THEME_COLOR.dark,
      THEME_COLOR.night,
    ]);
    expect(THEME_COLOR.dark).toBe(dark.surface);
    expect(THEME_COLOR.night).toBe(night.surface);
    // 浅色那条故意不是 surface，而是图标底色 —— 别「顺手改一致」。
    expect(THEME_COLOR.light).not.toBe(light.surface);
  });
});
