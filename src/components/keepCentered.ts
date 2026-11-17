// 跟读时让当前句一直待在屏幕中间（变更 94 / §12.27）。
//
// 他的原话：「在手机上，跟读时的内容部分也要一直居中，现在很多时候我要自己操作。」
// 成因很直白 —— 跟读页上面压着一排设置、下面是一排按钮和底部浮层，手机那一屏装不下，
// 于是句子卡片经常半截在屏幕外；而跟读是**不能用手的**（嘴在读、眼睛在看词），
// 「自己滚一下」在这个场景里比在任何别处都贵。
//
// 为什么不无脑每次都滚：人也可能正自己往上翻看别的句子。判据因此是
// 「这张卡**现在**在不在该在的地方」—— 偏了才滚，正好就不动。
// 「该在的地方」= 可视区中间那一段，而可视区的下沿要减去底部浮层（§12.2 的 --bottom-inset），
// 否则在手机上会把卡片推到播放条底下去。

/** 一块矩形在可视区里的处境。只用数字，不碰 DOM —— 这样它可以被直接测。 */
export type Box = { top: number; height: number };

/**
 * 要不要把这块滚到中间？
 *
 * @param box        卡片相对可视区的位置（`getBoundingClientRect()`）
 * @param viewport   可视区高度（`innerHeight`）
 * @param bottomInset 底部浮层高度，这一段不算可视
 * @param tolerance  允许偏离中心多少像素还算「正好」—— 太小会每句都滚，抖
 */
export function needsCentering(
  box: Box,
  viewport: number,
  bottomInset = 0,
  tolerance = 80,
): boolean {
  const usable = viewport - bottomInset;
  if (usable <= 0) return false;

  // 比可视区还高的卡（手机上的长句）居中反而会把开头推出去 —— 这时只要求**顶部**可见。
  if (box.height >= usable) return box.top < 0 || box.top > usable * 0.25;

  const center = box.top + box.height / 2;
  return Math.abs(center - usable / 2) > tolerance;
}

/** 当前底部浮层占了多少 —— 读 §12.2 那两个 CSS 变量里的 --bottom-inset。 */
export function bottomInsetPx(): number {
  if (typeof getComputedStyle !== 'function') return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset');
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/** 偏了就滚到中间。jsdom 和老 WebView 里没有 scrollIntoView，所以每一步都要兜住。 */
export function centerIfNeeded(el: HTMLElement | null): boolean {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  if (typeof el.scrollIntoView !== 'function') return false;
  const rect = el.getBoundingClientRect();
  if (!needsCentering({ top: rect.top, height: rect.height }, window.innerHeight, bottomInsetPx())) {
    return false;
  }
  // 跟得上就平滑，用户说了「别动」就瞬时 —— 读句子的节奏里，一次 300ms 的滑动是看得见的。
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  return true;
}
