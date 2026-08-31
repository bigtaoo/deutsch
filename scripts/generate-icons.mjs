// 生成 PWA 图标。
//
// 为什么自己画而不是引一个图形库：图标就是「深色圆角方块 + 三条波形竖条」，
// 像素级画出来只要几十行，而为一次性的构建产物装一个依赖不划算。
// iOS 的「添加到主屏幕」只认 PNG（§2.2 里那条硬要求），所以不能只给 SVG。
//
// 用法：node scripts/generate-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BG = [23, 23, 23]; // neutral-900
const FG = [250, 250, 250];
const ACCENT = [56, 189, 248]; // sky-400

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

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 五条高度不同的竖条，像一段被截出来的波形 —— 这个工具做的就是把音频切成句子。 */
const BARS = [0.34, 0.62, 1.0, 0.5, 0.24];

function makeIcon(size, { maskable }) {
  // maskable 图标要留出安全区，否则 Android 的圆形裁切会啃掉波形的两端。
  const padding = maskable ? 0.2 : 0.12;
  const radius = maskable ? 0 : size * 0.22;
  const inner = size * (1 - padding * 2);
  const left = size * padding;
  const barWidth = inner / (BARS.length * 2 - 1);
  const centerY = size / 2;

  return encodePng(size, (x, y) => {
    if (radius > 0) {
      // 圆角：只在四个角上判断，比逐像素算圆形便宜
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      if (dx < radius && dy < radius) {
        const d = Math.hypot(radius - dx, radius - dy);
        if (d > radius) return [0, 0, 0, 0];
      }
    }

    const barIndex = Math.floor((x - left) / (barWidth * 2));
    const withinBar = x >= left && (x - left) % (barWidth * 2) < barWidth && barIndex < BARS.length;
    if (withinBar && barIndex >= 0) {
      const half = (inner * BARS[barIndex]) / 2;
      if (Math.abs(y - centerY) <= half) {
        const color = barIndex === 2 ? ACCENT : FG;
        return [...color, 255];
      }
    }
    return [...BG, 255];
  });
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'icon-192.png'), makeIcon(192, { maskable: false }));
writeFileSync(join(OUT_DIR, 'icon-512.png'), makeIcon(512, { maskable: false }));
writeFileSync(join(OUT_DIR, 'icon-maskable-512.png'), makeIcon(512, { maskable: true }));
writeFileSync(join(OUT_DIR, 'apple-touch-icon.png'), makeIcon(180, { maskable: true }));
console.log('图标已写入 public/');
