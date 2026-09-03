// 音频 → 16kHz 单声道 float32 波形。用容器里那个 ffmpeg。
//
// ── 为什么是 ffmpeg，而不是一个 npm 的 mp3 解码器 ──
// 三条路各自的形状：浏览器用 Web Audio（`decodeToMono16k`），iOS 用 `AVAudioFile`，
// 这里用 ffmpeg —— 三处都是「把解码交给这个平台上最经得起考验的那个解码器」。
// 纯 JS 的 mp3 解码器要么慢一个量级，要么在 VBR / ID3 封面图 / 奇怪采样率上翻车，
// 而 DW 的 mp3 恰好都带 ID3 封面图。
//
// ── 为什么先落临时文件，不直接喂 stdin ──
// mp3 从 stdin 进是好的，但 m4a/aac 的 moov box 在文件尾部，ffmpeg 要能 seek 才认
// （手动导入的课程可能是 m4a）。落一个临时文件是一行的代价，换来「格式不挑」。
// 扩展名照 Content-Type 给：ffmpeg 主要靠嗅探，但给对了能省掉一类无信息量的报错。

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class DecodeError extends Error {}

/** MIME → 扩展名。认不出来退到 mp3（DW 的音频一律是 mp3）。 */
export function extensionOf(contentType: string | undefined): string {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return (
    (
      {
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a',
        'audio/aac': 'aac',
        'audio/ogg': 'ogg',
        'audio/opus': 'opus',
        'audio/wav': 'wav',
        'audio/x-wav': 'wav',
        'audio/wave': 'wav',
        'audio/flac': 'flac',
      } as Record<string, string>
    )[type] ?? 'mp3'
  );
}

export interface DecodeOptions {
  sampleRate: number;
  /** 超过这个秒数就拒绝 —— 一期 Alltagsdeutsch 是 8~10 分钟，30 分钟已经很宽松了。 */
  maxSeconds: number;
  ffmpegPath?: string;
}

/**
 * 解码。失败时抛 `DecodeError`，消息里带 ffmpeg 的最后几行 ——
 * 「音频坏了」和「服务器配错了」在日志里必须能一眼分开。
 */
export async function decodeToMono(
  audio: Uint8Array,
  extension: string,
  options: DecodeOptions,
): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), 'align-'));
  const input = join(dir, `audio.${extension}`);
  try {
    await writeFile(input, audio);
    const raw = await runFfmpeg(input, options);
    // 采样点数不是 4 的整数倍 = 管子被截断了（进程被杀、磁盘满）。
    // 静默截断的后果是整课时间戳整体偏移，所以宁可在这里失败。
    if (raw.length % 4 !== 0) throw new DecodeError('解码输出被截断了');
    const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    if (samples.length === 0) throw new DecodeError('这段音频里没有可解码的声音');
    const seconds = samples.length / options.sampleRate;
    if (seconds > options.maxSeconds) {
      throw new DecodeError(`音频 ${Math.round(seconds)} 秒，超过 ${options.maxSeconds} 秒上限`);
    }
    // 拷一份：上面那个视图指向 Buffer 的内存池，而池子会被后续 IO 复用。
    return new Float32Array(samples);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(input: string, options: DecodeOptions): Promise<Buffer> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    input,
    // 只要第一条音轨。`-vn` 是给 ID3 封面图准备的 —— 它在 ffmpeg 眼里是一条视频流。
    '-map',
    '0:a:0',
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(options.sampleRate),
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    'pipe:1',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(options.ffmpegPath ?? 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => {
      // 只留尾部：ffmpeg 出错时话很多，而有用的总在最后几行。
      err = (err + b.toString()).slice(-2000);
    });
    child.on('error', (e) =>
      reject(new DecodeError(`起不了 ffmpeg（镜像里装了吗？）：${e.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      reject(new DecodeError(`ffmpeg 退出码 ${code}：${err.trim() || '没有输出'}`));
    });
  });
}
