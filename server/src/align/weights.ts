// 权重站：把 `${modelDir}` 当只读静态目录对外提供。
//
// ── 为什么这台服务器要管这件事 ──
// 浏览器跑的是**我们自己量化的** 4-bit 权重（scripts/quantize-align-model.py），
// HF 上没有这份文件；而前端托管在 Cloudflare，那边单文件上限 25 MiB，230MB 放不进去。
// 于是唯一剩下的位置就是这台本来就要有的服务器。客户端取一次，transformers.js
// 自己存进 Cache API，之后离线可用 —— 所以这条路一年也就走几次。
//
// ── 不要求登录 ──
// 这里面只有一个 Apache-2.0 的模型文件，不是学习内容。要求登录反而会坏事：
// transformers.js 的取件走它自己的 fetch，加不上 Authorization 头。
// 真正的护栏是 CORS 白名单（只有自己的前端 origin 能读）+ 下面这份扩展名白名单。
//
// ── 为什么自己写而不是用 serveStatic ──
// @hono/node-server 的 serveStatic 只认相对进程 cwd 的路径，而权重在挂进来的
// `/data` 卷里（绝对路径、可配置）。加上要支持 Range（230MB 断了能续）、
// 要钉死扩展名白名单，自己写反而短。

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

/** 能对外提供的扩展名。模型目录里只该有这两类东西。 */
const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
};

/**
 * 把 URL 里那一段变成磁盘路径，顺便挡住目录穿越。
 *
 * 判据是「解析成绝对路径之后必须仍然在 dir 底下」，而不是「路径里没有 `..`」——
 * 后者对 `%2e%2e`、对 Windows 的分隔符、对多重编码都不成立，而前者对它们全都成立。
 * 用 `relative()` 而不是字符串前缀比较：前缀比较会把 `/data/models-evil` 当成
 * `/data/models` 底下。
 */
export function resolveWeightsPath(dir: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (!(extname(decoded).toLowerCase() in CONTENT_TYPES)) return null;
  const base = resolve(dir);
  const full = resolve(base, decoded);
  const inside = relative(base, full);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
  return full;
}

/** `bytes=1000-` / `bytes=0-99`。只认单区间 —— 多区间没人用，而实现要发 multipart。 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  // `bytes=-500` = 最后 500 字节。
  const start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end = rawStart === '' || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

/**
 * 取一个权重文件。
 *
 * @param rel URL 里 `/v1/align/weights/` 之后那一段，例如
 *   `oliverguhr/wav2vec2-large-xlsr-53-german-cv9/onnx/model_q4.onnx`
 */
export async function serveWeights(dir: string, rel: string, range?: string): Promise<Response> {
  const path = resolveWeightsPath(dir, rel);
  if (!path) return new Response('不提供这个文件', { status: 404 });

  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return new Response('不提供这个文件', { status: 404 });
    size = info.size;
  } catch {
    return new Response('这台服务器上没有这份权重', { status: 404 });
  }

  const headers = new Headers({
    'content-type': CONTENT_TYPES[extname(path).toLowerCase()],
    // 权重文件按 modelId 定址、内容永不变，所以可以放心长缓存。
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
  });

  const span = parseRange(range, size);
  if (range && !span) {
    headers.set('content-range', `bytes */${size}`);
    return new Response('Range 不合法', { status: 416, headers });
  }

  const start = span?.start ?? 0;
  const end = span?.end ?? size - 1;
  headers.set('content-length', String(end - start + 1));
  if (span) headers.set('content-range', `bytes ${start}-${end}/${size}`);

  const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
  return new Response(stream, { status: span ? 206 : 200, headers });
}
