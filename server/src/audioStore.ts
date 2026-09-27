// 手动导入的课的音频（变更 69）。
//
// ── 为什么服务器上要存音频了 ──
// 以前的立场是「缓存层一个字节都不上服务器」：DW 的课有下载地址，换设备自己去 DW 拉；
// 手动导入的课（教材）没有地址，每台设备都要自己选一次文件。用户买了教材、要在电脑和手机
// 之间自动同步，而这个服务只服务他一个人（allowlist + 每个请求都鉴权，见 SPEC §2.6.7），
// 于是给手动导入的课一个地址：**这台服务器上、按内容哈希定址的那一份**。
// 标注层里记的就是这个哈希（`Lesson.audioRef`），换设备时按它下载 —— 和 DW 的课走同一套「有地址就能补齐」。
//
// ── 按 SHA-256 定址 ──
// 名字就是内容的哈希：写之前算一遍、对不上就拒收，于是同一个名字永远是同一份字节，
// GET 可以放心长缓存；同一份音频传两次只存一份；下载下来的字节与上传的逐位一致，
// FR-3.6a 的「换没换音频」按字节数一比就知道没换，不会白对一遍。
//
// ── 每个用户一个目录、有总量上限 ──
// 这台机器上还跑着别人的东西（见 deploy/README.md），一个失控的客户端不能把盘写满。
// 一本教材转成 64kbps 单声道约 100MB，默认上限 5GB 足够放几十本。

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parseRange } from './align/weights.ts';

export const SHA256_RE = /^[0-9a-f]{64}$/;

export interface AudioStore {
  readonly maxBytes: number;
  /** 这一份在不在；在就回字节数 */
  size(userId: string, sha256: string): Promise<number | null>;
  /** 存一份。哈希对不上、超过单个或总量上限时抛 AudioRejected。已经有了就什么都不做。 */
  put(userId: string, sha256: string, bytes: Uint8Array): Promise<'created' | 'exists'>;
  /** 读一份（支持单区间 Range）。没有这一份回 null。 */
  open(userId: string, sha256: string, range?: string): Promise<Response | null>;
  usage(userId: string): Promise<number>;
}

export class AudioRejected extends Error {
  readonly status: 400 | 413 | 507;
  constructor(message: string, status: 400 | 413 | 507) {
    super(message);
    this.status = status;
  }
}

function safeUserDir(userId: string): string {
  return userId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown';
}

/** 按头几个字节认格式。存的时候不记类型：同一个哈希在哪台设备上传都是同一份字节，类型也就是同一个。 */
export function sniffAudioType(head: Uint8Array): string {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  return 'application/octet-stream';
}

export function createFileAudioStore(rootDir: string, limits: { maxBytes: number; quotaBytes: number }): AudioStore {
  const dirOf = (userId: string) => join(rootDir, safeUserDir(userId));
  const pathOf = (userId: string, sha256: string) => {
    if (!SHA256_RE.test(sha256)) throw new AudioRejected('非法的音频哈希', 400);
    return join(dirOf(userId), sha256);
  };

  const size: AudioStore['size'] = async (userId, sha256) => {
    try {
      const info = await stat(pathOf(userId, sha256));
      return info.isFile() ? info.size : null;
    } catch (err) {
      if (err instanceof AudioRejected) throw err;
      return null;
    }
  };

  const usage: AudioStore['usage'] = async (userId) => {
    let names: string[];
    try {
      names = await readdir(dirOf(userId));
    } catch {
      return 0; // 还没传过 —— 目录不存在不是错误
    }
    let total = 0;
    for (const n of names) if (SHA256_RE.test(n)) total += (await stat(join(dirOf(userId), n))).size;
    return total;
  };

  return {
    maxBytes: limits.maxBytes,
    size,
    usage,

    async put(userId, sha256, bytes) {
      const path = pathOf(userId, sha256);
      if (bytes.length > limits.maxBytes) throw new AudioRejected(`单个音频超过 ${limits.maxBytes} 字节上限`, 413);
      if ((await size(userId, sha256)) !== null) return 'exists';
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== sha256) throw new AudioRejected('内容和哈希对不上（传输中坏了？）', 400);
      if ((await usage(userId)) + bytes.length > limits.quotaBytes) {
        throw new AudioRejected(`音频总量超过 ${limits.quotaBytes} 字节上限`, 507);
      }
      await mkdir(dirOf(userId), { recursive: true });
      // 先写临时文件再改名：写到一半断电，留下的是一个认不出的 .tmp，而不是一个名字对、内容缺的文件
      const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, bytes);
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      return 'created';
    },

    async open(userId, sha256, range) {
      const total = await size(userId, sha256);
      if (total === null) return null;
      const path = pathOf(userId, sha256);
      const head = new Uint8Array(12);
      const fh = await open(path, 'r');
      try {
        await fh.read(head, 0, 12, 0);
      } finally {
        await fh.close();
      }
      const headers = new Headers({
        'content-type': sniffAudioType(head),
        // 按内容定址，同一个名字永远是同一份字节；private：它要登录才拿得到，不许中间的缓存留一份
        'cache-control': 'private, max-age=31536000, immutable',
        'accept-ranges': 'bytes',
      });
      const span = parseRange(range, total);
      if (range && !span) {
        headers.set('content-range', `bytes */${total}`);
        return new Response('Range 不合法', { status: 416, headers });
      }
      const start = span?.start ?? 0;
      const end = span?.end ?? total - 1;
      headers.set('content-length', String(end - start + 1));
      if (span) headers.set('content-range', `bytes ${start}-${end}/${total}`);
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
      return new Response(stream, { status: span ? 206 : 200, headers });
    },
  };
}
