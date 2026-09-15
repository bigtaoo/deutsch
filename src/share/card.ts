// FR-18.4：把今天的记录画成一张图。
//
// 1080×1350（4:5）—— 微信朋友圈、Instagram、Telegram 都按这个比例给最大的展示面积，
// 而 1:1 会把这张图里唯一的主角（那句德语）挤成五行。
//
// 为什么是 canvas 而不是「把 DOM 截个图」：截图要么引 html2canvas（一个几百 KB 的
// 依赖，还要复刻一遍 CSS 的排版规则），要么用 SVG foreignObject（Safari 上导出
// 常年出问题）。这张图的元素一共七样，直接画反而是最短的路，而且它不受
// 界面主题、字号设置、深色模式的影响 —— 分享出去的图在谁那儿都长一个样。
//
// 唯一需要小心的是**排版必须可测**：`wrapLines` 与 `fitLines` 是纯函数，
// 测量函数由调用方注入，所以在没有 canvas 的 jsdom 里也能穷举测试。

import { photoUrl } from './photos';
import { quoteAttribution, type Quote } from './quotes';

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;
const MARGIN = 88;

export interface ShareCardData {
  quote: Quote;
  photoId: string;
  /** 印在图上的名字。空字符串 = 不印（那一行留给日期） */
  name: string;
  /** `2026 年 9 月 15 日` */
  dateText: string;
  /** `23 分钟` */
  todayText: string;
  streakDays: number;
  totalDays: number;
}

type Measure = (text: string) => number;

// 一个 token = 一个中日韩字符（含全角标点），或一串非空白的西文加它后面的空格。
// 区间写成 \uXXXX 而不是字面字符：那个区间以不可见的全角空格起头，
// 直接把它打进正则里，源码上看到的是一段读不出来的东西。
const TOKEN_RE = /[\u3000-\u9fff\uff00-\uffef]|[^\s\u3000-\u9fff\uff00-\uffef]+\s*/g;

/**
 * 贪心折行。**中德混排要两套切分规则**：德语按空格断，中文按字断 ——
 * 中译那一行如果按空格断，整句话会是一个「词」，于是要么溢出画布，要么被缩到看不清。
 *
 * 连字符也算可断点（`Muttersprache-Niveau`），否则一个长复合词能顶掉半行。
 */
export function wrapLines(measure: Measure, text: string, maxWidth: number): string[] {
  const tokens = text.match(TOKEN_RE) ?? [];
  const lines: string[] = [];
  let current = '';

  for (const token of tokens) {
    const candidate = current + token;
    if (current && measure(candidate.trimEnd()) > maxWidth) {
      lines.push(current.trimEnd());
      current = token.trimStart();
    } else {
      current = candidate;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [''];
}

/**
 * 从最大字号往下试，直到折出来的行数不超过 `maxLines`。
 *
 * 缩字号而不是截断：这句话是图的主角，`Wer immer strebend sich bemüht…` 被截成
 * 「Wer immer strebend…」就没有意义了。真到了最小字号还超行，就让它超 ——
 * 字库里没有这么长的句子，而硬截会静默毁掉一张图。
 */
export function fitLines(
  measureAt: (fontSize: number) => Measure,
  text: string,
  maxWidth: number,
  sizes: number[],
  maxLines: number,
): { lines: string[]; fontSize: number } {
  let last = { lines: [text], fontSize: sizes[sizes.length - 1] };
  for (const fontSize of sizes) {
    const lines = wrapLines(measureAt(fontSize), text, maxWidth);
    last = { lines, fontSize };
    if (lines.length <= maxLines) return last;
  }
  return last;
}

const SERIF = 'Georgia, "Iowan Old Style", "Songti SC", "Times New Roman", serif';
const SANS =
  'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function loadPhoto(id: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    // 图没加载出来不该让「分享」这件事失败：底图退化成渐变，字一个不少。
    img.onerror = () => resolve(null);
    img.src = photoUrl(id);
  });
}

function drawBackground(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null): void {
  if (img) {
    // 照片已经是 4:5，这里仍然按 cover 画：万一哪天换了一张比例不同的，
    // 结果是被裁掉边缘，而不是整张图被拉变形。
    const scale = Math.max(CARD_WIDTH / img.width, CARD_HEIGHT / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, (CARD_WIDTH - w) / 2, (CARD_HEIGHT - h) / 2, w, h);
  } else {
    const fallback = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
    fallback.addColorStop(0, '#1d3f52');
    fallback.addColorStop(1, '#0f2530');
    ctx.fillStyle = fallback;
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  }

  // 压暗层。下半边压得重：所有的字都在下面 2/3，而底图里最亮的那张
  // （白垩崖，一片白与浅绿）不压的话白字直接消失。
  const scrim = ctx.createLinearGradient(0, 0, 0, CARD_HEIGHT);
  scrim.addColorStop(0, 'rgba(6, 12, 18, 0.26)');
  scrim.addColorStop(0.32, 'rgba(6, 12, 18, 0.36)');
  scrim.addColorStop(0.58, 'rgba(6, 12, 18, 0.58)');
  scrim.addColorStop(0.80, 'rgba(6, 12, 18, 0.80)');
  scrim.addColorStop(1, 'rgba(6, 12, 18, 0.90)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
}

/** 所有文字都带一层很淡的阴影 —— 底图是照片，纯白字压在浅色区域上会糊。 */
function withTextShadow(ctx: CanvasRenderingContext2D, draw: () => void): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 2;
  draw();
  ctx.restore();
}

/** 把一张分享图画进给定的 canvas。canvas 的像素尺寸由本函数设定。 */
export async function renderShareCard(
  canvas: HTMLCanvasElement,
  data: ShareCardData,
): Promise<void> {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('这台设备的浏览器不支持 canvas 2d，生成不了分享图');

  drawBackground(ctx, await loadPhoto(data.photoId));

  const contentWidth = CARD_WIDTH - MARGIN * 2;
  ctx.textBaseline = 'alphabetic';

  // ── 顶部：应用名。一行小字，说明这张图是哪儿来的 ──
  withTextShadow(ctx, () => {
    ctx.font = `500 26px ${SANS}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.textAlign = 'left';
    ctx.fillText('德语精听', MARGIN, MARGIN + 26);
  });

  // ── 底部往上排：数字行 → 名字与日期 → 细线 ──
  const statsBaseline = CARD_HEIGHT - MARGIN - 6;
  const statsLabelBaseline = statsBaseline - 54;
  const nameBaseline = statsLabelBaseline - 78;
  const ruleY = nameBaseline - 52;

  const stats: Array<[string, string]> = [
    ['今天', data.todayText],
    ['连续', `${data.streakDays} 天`],
    ['累计', `${data.totalDays} 天`],
  ];

  withTextShadow(ctx, () => {
    ctx.textAlign = 'left';
    stats.forEach(([label, value], i) => {
      const x = MARGIN + (contentWidth / 3) * i;
      ctx.font = `400 24px ${SANS}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.66)';
      ctx.fillText(label, x, statsLabelBaseline);
      ctx.font = `600 44px ${SANS}`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(value, x, statsBaseline);
    });

    // 名字在左、日期在右。**没有名字时日期换到左边** —— 否则那一行是
    // 左边一片空、右边贴边一行小字，看起来像排版出了错。
    if (data.name) {
      ctx.font = `500 38px ${SANS}`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(data.name, MARGIN, nameBaseline);
      ctx.textAlign = 'right';
    }
    ctx.font = `400 28px ${SANS}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.74)';
    ctx.fillText(data.dateText, data.name ? CARD_WIDTH - MARGIN : MARGIN, nameBaseline);
  });

  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.fillRect(MARGIN, ruleY, contentWidth, 1);

  // ── 引文块：从细线往上排，所以句子长的时候是往上长，底部三个数字纹丝不动 ──
  const measureAt = (fontSize: number): Measure => {
    ctx.font = `500 ${fontSize}px ${SERIF}`;
    return (text: string) => ctx.measureText(text).width;
  };
  const { lines, fontSize } = fitLines(measureAt, data.quote.de, contentWidth, [58, 52, 46, 42], 4);
  const lineHeight = Math.round(fontSize * 1.42);

  ctx.font = `400 28px ${SANS}`;
  const zhLines = wrapLines((t) => ctx.measureText(t).width, data.quote.zh, contentWidth);

  const attributionGap = 52;
  const zhGap = 40;
  const blockBottom = ruleY - 76;
  const zhHeight = zhLines.length * 42;
  const quoteBaseline = blockBottom - zhHeight - zhGap - attributionGap;

  withTextShadow(ctx, () => {
    ctx.textAlign = 'left';
    ctx.font = `500 ${fontSize}px ${SERIF}`;
    ctx.fillStyle = '#ffffff';
    lines.forEach((line, i) => {
      ctx.fillText(line, MARGIN, quoteBaseline - (lines.length - 1 - i) * lineHeight);
    });

    ctx.font = `italic 400 30px ${SERIF}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.fillText(`— ${quoteAttribution(data.quote)}`, MARGIN, quoteBaseline + attributionGap);

    ctx.font = `400 28px ${SANS}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.70)';
    zhLines.forEach((line, i) => {
      ctx.fillText(line, MARGIN, quoteBaseline + attributionGap + zhGap + 30 + i * 42);
    });
  });
}

/** 画一张并拿到 PNG。PNG 而不是 JPEG：字的边缘不该有压缩噪点。 */
export async function renderShareCardBlob(data: ShareCardData): Promise<Blob> {
  const canvas = document.createElement('canvas');
  await renderShareCard(canvas, data);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('生成图片失败'));
    }, 'image/png');
  });
}
