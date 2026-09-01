// 生成图标与启动图 —— PWA 的（public/）与原生壳的（ios/ + android/）。
//
// 为什么自己画，而不是引一个图形库、或者让图像模型出图：
//  1. 要的不是一张图，是三十多张互不相同的图 —— iOS 那张必须无 alpha 通道、Android
//     自适应前景必须抠掉底、maskable 要多留被裁的余量，还有 11 张不同比例的启动图。
//     图像模型只能给一张 1024，剩下全靠降采样，而降采样出的 48px 一定比直接在 48px 上
//     算覆盖率的糊。
//  2. 这枚图标是纯几何（气泡 + 斜体 Ä + 渐强的波），代码是它的正确表示形式：
//     配色、倾角、振幅都是常量，改一个数重跑一遍，进版本库的是「设计」而不是「某次抽卡」。
//  3. 官方的 `@capacitor/assets` 依赖 sharp，而 sharp 要跑安装脚本编原生模块 ——
//     为画几十个 PNG 引入一条需要编译的依赖链，比自己多写两百行糟得多。
// iOS 的「添加到主屏幕」只认 PNG（§2.2 那条硬要求），所以不能只给 SVG。
//
// 用法：node scripts/generate-icons.mjs   （= npm run icons）
// 改了参数跑一次，产物入库 —— 它们是原生工程的一部分，CI 不重新生成。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const IOS_ASSETS = join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets');
const ANDROID_RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * alpha: false 写的是 PNG color type 2（RGB，**没有 alpha 通道**），不是「alpha 全 255」。
 * 这条只为 iOS 的 AppIcon 存在：App Store 的校验拒收带 alpha 通道的图标，
 * 而它看的是通道在不在，不是有没有透明像素 —— 所以 RGBA 全不透明照样会被打回，
 * 且 Xcode 本地构建完全不报错，第一次上传才炸。
 */
function encodePng(width, height, pixelAt, { alpha = true } = {}) {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc(height * (width * channels + 1));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      if (alpha) raw[offset++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // RGBA / RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * ── 图案 ──────────────────────────────────────────────────────────────────
 *
 * 一枚圆润的半透明对话气泡，里面是斜体的 Ä，一条渐强上扬的波从气泡背后穿过。
 *
 * 三个元素各说一件事，缺一不可：
 *  - **气泡** = 语言 / 说话。这是语言类 App 的通用视觉词（Babbel、HelloTalk 都在用）。
 *    只画波形的话，播客、录音机、播放器的图标全长那样，说不出「学语言」。
 *  - **Ä** = 德语。带变音符的字母是任何人都能认出的「外语」记号，不懂德语正字法的人
 *    也知道这是个带奇怪符号的字母。
 *  - **波** = 听。它压在 Ä 的脚下、从气泡下缘穿出去。
 *
 * 「灵动」只靠两个旋钮，别再往里加第四层元素 —— 48px 装不下：
 *  - Ä 是**斜体**（SHEAR）。字母一倾就有速度感，在气泡里也更像「正在说的话」。
 *  - 波是**渐强**的（振幅左小右大、中线一路抬高，右端甩出气泡）。等幅正弦是节拍器，
 *    渐强才像一句话被说出来。
 *
 * 图层顺序 **底 → 波 → 气泡 → Ä**：气泡半透明，所以波在气泡里透出浅浅一截、探出
 * 气泡后是实色 —— 这是「通透」的唯一来源。注意 **iOS 的 AppIcon 不能带 alpha 通道**，
 * 所以这里的透明只能是画出来的（半透明色叠在浅底上），不能是真的镂空。
 *
 * 几何全部写在 1024 的设计稿坐标里（下面这一坨常量），改图案只改这里。
 */
const TILE = [224, 242, 254]; // #e0f2fe = sky-100。比 sky-50 深一档 ——
// sky-50（#f0f8fe 那档）几乎是白的，摆在浅色壁纸上整枚图标没有边界。
// 代价是气泡与底都变成浅蓝、两者的对比跟着掉，所以 BUBBLE_ALPHA 一起从 0.62 提到 0.76
// （气泡叠出来是 rgb(96,202,250)，底是 224,242,254）。改这一个常量，自适应底色 xml
// 会跟着重新生成，但 index.html 的 theme-color 和 vite manifest 的 theme_color 得手动跟上。
const SKY = [56, 189, 248]; // sky-400，气泡
const INK_COLOR = [2, 132, 199]; // sky-600，Ä / 波 / 两点
// 0.76 是配 sky-100 底试出来的：再淡气泡就融进底色（62% 配 sky-50 时刚好，
// 底一深就不够了），再浓就看不出波从背后穿过 —— 那是「通透」的唯一来源。
const BUBBLE_ALPHA = 0.76;
const INK_ALPHA = 1;
// 启动图底色。跟应用主体一致（导航是 bg-white）—— 给深色会在启动图 → 首帧之间闪一下。
// capacitor.config.ts 里的 backgroundColor 必须与这个值一样。
const SPLASH_BG = [255, 255, 255];

// 气泡：近乎胶囊的圆角矩形 ∪ 一颗尾巴圆点（iMessage 那种，不是尖角三角）。
// 只留一颗 —— 第二颗小圆点在 48px 下只有 1 个像素，纯占地方。
//
// 尾巴在**右下**而不是左下（对话气泡两边都常见，iMessage 的发出消息就在右）：
// 波的低谷压在左下，尾巴放那边会被波从接缝处切断，看起来像一颗脱离气泡的孤点；
// 而波到右端已经抬起来了，右下是整枚图案唯一的空地。
// 它必须和气泡主体**有重叠**（这里压进去约 17 个设计单位），否则中间会留一条浅缝。
const BUB = { x0: 152, y0: 130, x1: 872, y1: 770, r: 250, tail: [[696, 796, 56]] };
// 斜体 Ä。apex 是错切**前**的顶点：错切后它右移 SHEAR × (footY − apex.y) ≈ 44。
const SHEAR = 0.15; // ≈ 8.5°
const A = { apex: [488, 306], footY: 596, halfSpan: 130, sw: 34, barT: 0.66 };
// 两点单独定位，不跟着错切（错切会把圆压成椭圆），落在错切后的顶点上方
const DOTS = [
  [473, 226, 38],
  [589, 226, 38],
];
const WAVE = { x0: 112, x1: 912, cy0: 706, cy1: 654, amp0: 14, amp1: 50, humps: 5, hw: 21 };

// ── SDF 基元（都在设计稿坐标里，返回有符号距离，内部为负）─────────────────
const circleSdf = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

function segSdf(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function rrectSdf(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(x - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(y - cy) - ((y1 - y0) / 2 - r);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

const bubbleSdf = (x, y) => {
  let d = rrectSdf(x, y, BUB.x0, BUB.y0, BUB.x1, BUB.y1, BUB.r);
  for (const [cx, cy, r] of BUB.tail) d = Math.min(d, circleSdf(x, y, cx, cy, r));
  return d;
};

/**
 * 渐强的波，拍成折线算距离。
 *
 * 步数固定 280：弦高误差 = 曲率 × 步长² / 8，折算到 1024px 约 0.05 像素，比抗锯齿
 * 本身的精度还细。这里不做「只扫附近几段」的窗口剪枝 —— 振幅和中线都随 x 变，
 * 剪枝的前提（折线在 x 上单调且带宽恒定）不再成立，而全扫 280 段在最大那张
 * （2732 的启动图，图案只占短边 28%）也就多花一秒。
 */
const WAVE_STEPS = 280;
const WAVE_LAMBDA = (2 * (WAVE.x1 - WAVE.x0)) / WAVE.humps;
const WAVE_PTS = Array.from({ length: WAVE_STEPS + 1 }, (_, i) => {
  const t = i / WAVE_STEPS;
  const x = WAVE.x0 + (WAVE.x1 - WAVE.x0) * t;
  const cy = WAVE.cy0 + (WAVE.cy1 - WAVE.cy0) * t;
  const amp = WAVE.amp0 + (WAVE.amp1 - WAVE.amp0) * t;
  return [x, cy - amp * Math.sin((2 * Math.PI * (x - WAVE.x0)) / WAVE_LAMBDA)];
});

function waveSdf(x, y) {
  let best = Infinity;
  for (let i = 0; i < WAVE_PTS.length - 1; i++) {
    const a = WAVE_PTS[i];
    const b = WAVE_PTS[i + 1];
    const d = segSdf(x, y, a[0], a[1], b[0], b[1]);
    if (d < best) best = d;
  }
  return best - WAVE.hw;
}

/**
 * 斜体的 A：两条斜笔 + 一根横杠，全部圆头。
 *
 * 斜体的实现是把**查询点**反向错切（水平错切下横杠仍然是水平的）。错切后 SDF 不再是
 * 严格的距离，误差量级 SHEAR²/2 ≈ 1%，抗锯齿看不出来。
 * 不用字体：一是不想为三条线引一条字体 + 光栅化的依赖，二是各家字体的 Ä 两点位置和
 * 笔画粗细都不一样，而这里要跟波的粗细严格对齐。
 */
function letterSdf(x, y) {
  const sx = x + SHEAR * (y - A.footY);
  const [ax, ay] = A.apex;
  const barY = ay + (A.footY - ay) * A.barT;
  const bx = A.halfSpan * A.barT;
  return Math.min(
    segSdf(sx, y, ax, ay, ax - A.halfSpan, A.footY) - A.sw,
    segSdf(sx, y, ax, ay, ax + A.halfSpan, A.footY) - A.sw,
    segSdf(sx, y, ax - bx, barY, ax + bx, barY) - A.sw * 0.86,
  );
}

const dotsSdf = (x, y) => Math.min(...DOTS.map(([cx, cy, r]) => circleSdf(x, y, cx, cy, r)));

/**
 * 墨迹的外接框，用来把图案摆进各平台的留白里。
 *
 * **按长边贴合**（而不是按宽度）：改了参数图案可能变成高瘦形，按宽度贴合会竖向溢出。
 * 波的上下界必须采样折线才知道（振幅随 x 变），不能用常量算。
 */
function inkBounds() {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const acc = (ax, ay, bx, by) => {
    x0 = Math.min(x0, ax);
    y0 = Math.min(y0, ay);
    x1 = Math.max(x1, bx);
    y1 = Math.max(y1, by);
  };
  acc(BUB.x0, BUB.y0, BUB.x1, BUB.y1);
  for (const [cx, cy, r] of BUB.tail) acc(cx - r, cy - r, cx + r, cy + r);
  for (const [cx, cy, r] of DOTS) acc(cx - r, cy - r, cx + r, cy + r);
  for (const [x, y] of WAVE_PTS) acc(x - WAVE.hw, y - WAVE.hw, x + WAVE.hw, y + WAVE.hw);
  // 斜体 A 的三个端点：错切后的位置 ± 笔画半宽（横杠更细，按斜笔算就够）
  const [ax, ay] = A.apex;
  const shifted = ax - SHEAR * (ay - A.footY); // 查询点反向错切 ⇒ 图形正向平移
  for (const [px, py] of [
    [shifted, ay],
    [ax - A.halfSpan, A.footY],
    [ax + A.halfSpan, A.footY],
  ]) {
    acc(px - A.sw, py - A.sw, px + A.sw, py + A.sw);
  }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}
const INK = inkBounds();

/** 有符号距离 → 覆盖率。d 与 unit 同单位，unit 是一个像素的边长。
 *  SDF 抗锯齿的标准近似（把边界当直线），每像素只算一次距离，比超采样又快又准。 */
function coverage(d, unit) {
  const t = 0.5 - d / unit;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** src over dst，两边都是非预乘的 [r, g, b, a(0..1)] */
function over(dst, src, srcA) {
  if (srcA <= 0) return dst;
  const outA = srcA + dst[3] * (1 - srcA);
  if (outA <= 0) return [0, 0, 0, 0];
  const s = srcA / outA;
  const w = (dst[3] * (1 - srcA)) / outA;
  return [src[0] * s + dst[0] * w, src[1] * s + dst[1] * w, src[2] * s + dst[2] * w, outA];
}

/**
 * 返回一个 (x, y) → [r,g,b,a] 的取色函数，画一枚 size×size 的图标。
 *
 * shape 决定底怎么画，这是各平台唯一真正不同的地方：
 *  - 'rounded'：圆角方块，四角透明。PWA / Android 传统图标。
 *  - 'square' ：整块不透明，一个透明像素都没有。**iOS 的 AppIcon 必须是这个** ——
 *               带 alpha 通道的图标会被 App Store 的校验直接打回，而 Xcode 本地构建
 *               不报错，所以这个坑只在第一次上传时才炸。
 *  - 'circle' ：圆形，圆外透明。Android 的 ic_launcher_round。
 *  - 'none'   ：完全不画底。用在 Android 自适应图标的前景层（底色由
 *               values/ic_launcher_background.xml 给，必须等于 TILE），以及启动图
 *               （直接画在 SPLASH_BG 上，这样启动图上看不见图标的方框边界）。
 *
 * padding 是留白比例。注意贴合的是**紧贴墨迹的外接框**（不是整张设计稿），
 * 所以这些数值比"设计稿留白"直觉上的要小。各档的依据：
 *  - rounded(0.08) / square(0.10)：系统只加圆角、不裁切，图案占到 80~84% 才不显小。
 *  - maskable(0.18) / circle(0.18)：内容必须落在直径 80% 的圆里。外接框是
 *    842×722（设计单位），缩到 64% 后半对角线 0.39 < 0.40，刚好进得去；
 *    而外接框的四个角本来就是空的（波的两端在中腰、两点在顶部中间），实际更宽裕。
 *  - adaptive(0.28)：Android 自适应图标只保证中间 66/108 = 61% 可见，还会做视差位移。
 *    按半对角线 ≤ 0.3055 反解，padding 至少 0.268 —— 这一档不能再小。
 */
function iconPainter(size, { shape, padding }) {
  const box = size * (1 - padding * 2);
  const scale = box / Math.max(INK.w, INK.h); // 按长边贴合
  const offX = (size - INK.w * scale) / 2;
  const offY = (size - INK.h * scale) / 2;
  const unit = 1 / scale; // 一个像素在设计稿坐标里的边长
  const half = size / 2;
  const radius = size * 0.22;

  return (px, py) => {
    const cx = px + 0.5; // 像素中心：覆盖率要按中心到边界的距离算
    const cy = py + 0.5;

    let tileCov;
    if (shape === 'none') {
      tileCov = 0;
    } else if (shape === 'square') {
      tileCov = 1;
    } else if (shape === 'circle') {
      tileCov = coverage(Math.hypot(cx - half, cy - half) - half, 1);
    } else {
      tileCov = coverage(rrectSdf(cx, cy, 0, 0, size, size, radius), 1);
    }

    // 像素中心 → 设计稿坐标
    const x = (cx - offX) / scale + INK.x0;
    const y = (cy - offY) / scale + INK.y0;

    let p = [TILE[0], TILE[1], TILE[2], tileCov];
    p = over(p, INK_COLOR, coverage(waveSdf(x, y), unit) * INK_ALPHA);
    p = over(p, SKY, coverage(bubbleSdf(x, y), unit) * BUBBLE_ALPHA);
    p = over(p, INK_COLOR, coverage(letterSdf(x, y), unit) * INK_ALPHA);
    p = over(p, INK_COLOR, coverage(dotsSdf(x, y), unit) * INK_ALPHA);
    return [Math.round(p[0]), Math.round(p[1]), Math.round(p[2]), Math.round(p[3] * 255)];
  };
}

const icon = (size, opts) => encodePng(size, size, iconPainter(size, opts), { alpha: opts.alpha ?? true });

/**
 * 启动图：纯色底 + 居中的图案，**不画图标的方框**（shape: 'none'）—— 画了的话启动图上
 * 会出现一个和底色差一点点的方块边界，很脏。
 *
 * 图案只占短边的 28%：Android 12+ 会在这张图上再叠一层系统的启动图圈，画满的话两者
 * 会打起来；iOS 那张 2732×2732 则要被裁到各种屏幕比例，图案离中心越近越安全。
 */
function splash(width, height) {
  const boxSize = Math.round(Math.min(width, height) * 0.28);
  const paint = iconPainter(boxSize, { shape: 'none', padding: 0 });
  const originX = Math.round((width - boxSize) / 2);
  const originY = Math.round((height - boxSize) / 2);

  return encodePng(width, height, (x, y) => {
    const lx = x - originX;
    const ly = y - originY;
    if (lx >= 0 && ly >= 0 && lx < boxSize && ly < boxSize) {
      const [r, g, b, a] = paint(lx, ly);
      if (a > 0) {
        const t = a / 255;
        return [
          Math.round(r * t + SPLASH_BG[0] * (1 - t)),
          Math.round(g * t + SPLASH_BG[1] * (1 - t)),
          Math.round(b * t + SPLASH_BG[2] * (1 - t)),
          255,
        ];
      }
    }
    return [...SPLASH_BG, 255];
  });
}

function write(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
}

// ── PWA（public/）──────────────────────────────────────────────────────────
write(join(PUBLIC_DIR, 'icon-192.png'), icon(192, { shape: 'rounded', padding: 0.08 }));
write(join(PUBLIC_DIR, 'icon-512.png'), icon(512, { shape: 'rounded', padding: 0.08 }));
write(join(PUBLIC_DIR, 'icon-maskable-512.png'), icon(512, { shape: 'square', padding: 0.18 }));
write(join(PUBLIC_DIR, 'apple-touch-icon.png'), icon(180, { shape: 'square', padding: 0.10 }));

// ── iOS ────────────────────────────────────────────────────────────────────
// 文件名与 Assets.xcassets 里 Contents.json 的 filename 一一对应，不能改。
write(
  join(IOS_ASSETS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'),
  icon(1024, { shape: 'square', padding: 0.10, alpha: false }),
);
// Splash.imageset 的 1x/2x/3x 指向三个文件名，但内容可以是同一张：
// 这是一张被 aspectFill 铺开的整屏图，密度对它没有意义。
const iosSplash = splash(2732, 2732);
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  write(join(IOS_ASSETS, 'Splash.imageset', name), iosSplash);
}

// ── Android ────────────────────────────────────────────────────────────────
// 尺寸取自 Capacitor 的模板文件，一格不改 —— 换了尺寸就得同时改 res 目录名。
const LAUNCHER = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const ADAPTIVE = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const [density, size] of Object.entries(LAUNCHER)) {
  write(join(ANDROID_RES, `mipmap-${density}`, 'ic_launcher.png'), icon(size, { shape: 'rounded', padding: 0.08 }));
  write(join(ANDROID_RES, `mipmap-${density}`, 'ic_launcher_round.png'), icon(size, { shape: 'circle', padding: 0.18 }));
  // 自适应图标的前景层：只有波形，底色走 values/ic_launcher_background.xml。
  // padding 0.28 而不是 0.2 —— 自适应图标的 108dp 里只有中间 66dp 保证可见，
  // 系统还会对前景做视差位移，按 0.2 来两端会被啃掉。
  write(
    join(ANDROID_RES, `mipmap-${density}`, 'ic_launcher_foreground.png'),
    icon(ADAPTIVE[density], { shape: 'none', padding: 0.28 }),
  );
}

// 启动图：竖屏/横屏各五个密度，外加一张给没有匹配到 qualifier 的兜底。
const SPLASH_SIZES = {
  mdpi: [320, 480],
  hdpi: [480, 800],
  xhdpi: [720, 1280],
  xxhdpi: [960, 1600],
  xxxhdpi: [1280, 1920],
};
for (const [density, [shortSide, longSide]] of Object.entries(SPLASH_SIZES)) {
  write(join(ANDROID_RES, `drawable-port-${density}`, 'splash.png'), splash(shortSide, longSide));
  write(join(ANDROID_RES, `drawable-land-${density}`, 'splash.png'), splash(longSide, shortSide));
}
write(join(ANDROID_RES, 'drawable', 'splash.png'), splash(480, 320));

// 自适应图标的底色。模板给的是白色 —— 不改的话浅色气泡贴在白底上没有边界。
write(
  join(ANDROID_RES, 'values', 'ic_launcher_background.xml'),
  Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!-- 由 scripts/generate-icons.mjs 生成。**必须等于脚本里的 TILE** ——\n` +
      `     前景（ic_launcher_foreground）是画在透明底上的气泡 + Ä + 波，\n` +
      `     底色不对的话自适应图标就不是这个设计了。 -->\n` +
      `<resources>\n` +
      `    <color name="ic_launcher_background">#${TILE.map((c) => c.toString(16).padStart(2, '0')).join('')}</color>\n` +
      `</resources>\n`,
    'utf-8',
  ),
);

console.log('图标已写入 public/（PWA）、ios/App/App/Assets.xcassets、android/app/src/main/res');
