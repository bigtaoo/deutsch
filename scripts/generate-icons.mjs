// 生成图标与启动图 —— PWA 的（public/）与原生壳的（ios/ + android/）。
//
// 为什么自己画而不是引一个图形库：图标就是「深色圆角方块 + 五条波形竖条」，
// 像素级画出来只要两百行，而为一次性的构建产物装一个依赖不划算。
// 这条在接原生壳时又验了一次：官方的 `@capacitor/assets` 依赖 sharp，
// 而 sharp 要跑安装脚本编原生模块 —— 为了画几十个 PNG 引入一条需要编译的依赖链，
// 比自己多写一百行糟得多。所以原生那两套资源也在这里画。
// iOS 的「添加到主屏幕」只认 PNG（§2.2 里那条硬要求），所以不能只给 SVG。
//
// 用法：node scripts/generate-icons.mjs   （= npm run icons）
// 改了配色跑一次，产物入库 —— 它们是原生工程的一部分，CI 不重新生成。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const IOS_ASSETS = join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets');
const ANDROID_RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');

const BG = [23, 23, 23]; // neutral-900
const FG = [250, 250, 250];
const ACCENT = [56, 189, 248]; // sky-400
// 启动图底色跟应用主体一致（导航是 bg-white）。给深色会在启动图 → 首帧之间闪一下。
// capacitor.config.ts 里的 backgroundColor 必须与这个值一样。
const SPLASH_BG = [255, 255, 255];

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

/** 五条高度不同的竖条，像一段被截出来的波形 —— 这个工具做的就是把音频切成句子。 */
const BARS = [0.34, 0.62, 1.0, 0.5, 0.24];

/**
 * 返回一个 (x, y) → [r,g,b,a] 的取色函数，画一枚 size×size 的图标。
 *
 * shape 决定外形与镂空方式，这是各平台唯一真正不同的地方：
 *  - 'rounded'：圆角方块，四角透明。PWA / Android 传统图标。
 *  - 'square' ：整块不透明，一个透明像素都没有。**iOS 的 AppIcon 必须是这个** ——
 *               带 alpha 通道的图标会被 App Store 的校验直接打回，而 Xcode 本地构建
 *               不报错，所以这个坑只在第一次上传时才炸。
 *  - 'circle' ：圆形，圆外透明。Android 的 ic_launcher_round。
 *  - 'none'   ：完全不画底，只留波形。Android 自适应图标的前景层（底色由
 *               values/ic_launcher_background.xml 给）。
 *
 * padding 是留白比例。要留白的两种情形不一样：
 *  - maskable / adaptive：系统会用圆形或 squircle 裁掉一圈，留 0.2 才不会啃掉波形两端。
 *  - iOS AppIcon：系统自己加圆角，图案离边太近会显得挤，0.16 比较像原生图标的比例。
 */
function iconPainter(size, { shape, padding }) {
  const radius = shape === 'rounded' ? size * 0.22 : 0;
  const inner = size * (1 - padding * 2);
  const left = size * padding;
  const barWidth = inner / (BARS.length * 2 - 1);
  const center = size / 2;
  const transparent = [0, 0, 0, 0];

  return (x, y) => {
    if (shape === 'circle') {
      if (Math.hypot(x - center + 0.5, y - center + 0.5) > center) return transparent;
    } else if (radius > 0) {
      // 圆角：只在四个角上判断，比逐像素算圆形便宜
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      if (dx < radius && dy < radius && Math.hypot(radius - dx, radius - dy) > radius) {
        return transparent;
      }
    }

    const barIndex = Math.floor((x - left) / (barWidth * 2));
    const withinBar = x >= left && (x - left) % (barWidth * 2) < barWidth && barIndex < BARS.length;
    if (withinBar && barIndex >= 0) {
      const half = (inner * BARS[barIndex]) / 2;
      if (Math.abs(y - center) <= half) {
        return [...(barIndex === 2 ? ACCENT : FG), 255];
      }
    }
    return shape === 'none' ? transparent : [...BG, 255];
  };
}

const icon = (size, opts) => encodePng(size, size, iconPainter(size, opts), { alpha: opts.alpha ?? true });

/**
 * 启动图：纯色底 + 居中的图标。
 *
 * 图标只占短边的 28% —— Android 12+ 会在这张图上再叠一层系统的启动图圈，
 * 画满的话两者会打起来；iOS 那张 2732×2732 则要被裁到各种屏幕比例，
 * 图案离中心越近越安全。
 */
function splash(width, height) {
  const iconSize = Math.round(Math.min(width, height) * 0.28);
  const paint = iconPainter(iconSize, { shape: 'rounded', padding: 0.12 });
  const originX = Math.round((width - iconSize) / 2);
  const originY = Math.round((height - iconSize) / 2);

  return encodePng(width, height, (x, y) => {
    const lx = x - originX;
    const ly = y - originY;
    if (lx >= 0 && ly >= 0 && lx < iconSize && ly < iconSize) {
      const [r, g, b, a] = paint(lx, ly);
      // 圆角外是透明的，直接露出底色即可（图标内部没有半透明像素，不需要真正混色）。
      if (a === 255) return [r, g, b, 255];
    }
    return [...SPLASH_BG, 255];
  });
}

function write(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
}

// ── PWA（public/）──────────────────────────────────────────────────────────
write(join(PUBLIC_DIR, 'icon-192.png'), icon(192, { shape: 'rounded', padding: 0.12 }));
write(join(PUBLIC_DIR, 'icon-512.png'), icon(512, { shape: 'rounded', padding: 0.12 }));
write(join(PUBLIC_DIR, 'icon-maskable-512.png'), icon(512, { shape: 'square', padding: 0.2 }));
write(join(PUBLIC_DIR, 'apple-touch-icon.png'), icon(180, { shape: 'square', padding: 0.2 }));

// ── iOS ────────────────────────────────────────────────────────────────────
// 文件名与 Assets.xcassets 里 Contents.json 的 filename 一一对应，不能改。
write(
  join(IOS_ASSETS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'),
  icon(1024, { shape: 'square', padding: 0.16, alpha: false }),
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
  write(join(ANDROID_RES, `mipmap-${density}`, 'ic_launcher.png'), icon(size, { shape: 'rounded', padding: 0.12 }));
  write(join(ANDROID_RES, `mipmap-${density}`, 'ic_launcher_round.png'), icon(size, { shape: 'circle', padding: 0.2 }));
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

// 自适应图标的底色。模板给的是白色，而前景是浅色波形 —— 不改的话图标是一片空白。
write(
  join(ANDROID_RES, 'values', 'ic_launcher_background.xml'),
  Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!-- 由 scripts/generate-icons.mjs 生成。前景（ic_launcher_foreground）是浅色波形，\n` +
      `     所以底色必须是深的，否则自适应图标在启动器里是一片空白。 -->\n` +
      `<resources>\n` +
      `    <color name="ic_launcher_background">#${BG.map((c) => c.toString(16).padStart(2, '0')).join('')}</color>\n` +
      `</resources>\n`,
    'utf-8',
  ),
);

console.log('图标已写入 public/（PWA）、ios/App/App/Assets.xcassets、android/app/src/main/res');
