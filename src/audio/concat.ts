// FR-1.8：把几轨音频按顺序拼成一个文件。
//
// ── 为什么要拼 ──
// 教材的一个 Aufgabe 常常跨好几轨（Aspekte neu C1 第一课那道题，Person 1~8 各占一轨），
// 而文稿里音轨号印在页边、复制出来整堆挤到页尾，没法据此把文字切到每一轨上。
// 能可靠切出来的单位是 Aufgabe（它有标题行），所以一课 = 一个 Aufgabe，音频 = 那几轨拼起来。
// 课程模型、播放器、对齐因此一行都不用改 —— 它们眼里仍然是一课一个音频。
//
// ── 两条路 ──
// 1. **按字节拼**（首选）：全是同一规格的 CBR mp3 时，把每个文件的标签（ID3v2 / ID3v1）
//    和 Xing/Info 头帧去掉，剩下的 MPEG 帧首尾相接。这是确定性的 —— 同样几个文件
//    在哪台设备上拼出来都是同样的字节，于是手机补音频时字节数与桌面那份一致，
//    不会被判成「换过音频」而白对一遍（FR-3.6a）。
//    Xing 头必须去掉：它记着「这个文件有多少帧」，留着第一个文件的那份，
//    浏览器会把整段拼接的时长报成第一轨的长度。
// 2. **解码后拼成 WAV**（兜底）：VBR、采样率不一致、不是 mp3。VBR 不能按字节拼，
//    因为去掉 Xing 头之后浏览器只能按码率估位置，`<audio>` 的 seek 会偏 —— 而跟读
//    整个建立在「跳到这一句的起点」上。代价是体积（44.1kHz 单声道 16 位，约 5MB/分钟）。

export interface ConcatResult {
  file: File;
  /** 走的是哪条路，界面上用来说明为什么这个文件突然变大了 */
  method: 'bytes' | 'wav';
}

interface FrameInfo {
  version: number; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  bitrateIndex: number;
  sampleRate: number;
  mono: boolean;
  length: number;
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/** 读一个 Layer III 帧头；不是合法帧头就返回 null。 */
export function parseFrameHeader(bytes: Uint8Array, at: number): FrameInfo | null {
  if (at + 4 > bytes.length) return null;
  const [b0, b1, b2, b3] = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  if (version === 1 || layer !== 1) return null; // 1 = 保留值；只收 Layer III
  const bitrateIndex = b2 >> 4;
  const srIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || srIndex === 3) return null;
  const sampleRate = SAMPLE_RATES[version][srIndex];
  const kbps = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex];
  const padding = (b2 >> 1) & 1;
  const length = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / sampleRate) + padding;
  return { version, bitrateIndex, sampleRate, mono: b3 >> 6 === 3, length };
}

function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const footer = bytes[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

function hasId3v1(bytes: Uint8Array): boolean {
  const at = bytes.length - 128;
  return at >= 0 && bytes[at] === 0x54 && bytes[at + 1] === 0x41 && bytes[at + 2] === 0x47; // "TAG"
}

function containsAscii(bytes: Uint8Array, from: number, to: number, word: string): boolean {
  outer: for (let i = from; i + word.length <= to; i++) {
    for (let j = 0; j < word.length; j++) {
      if (bytes[i + j] !== word.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

interface ScannedMp3 {
  /** 去掉标签和 Xing 头之后的纯音频帧区间 */
  start: number;
  end: number;
  first: FrameInfo;
  cbr: boolean;
}

/**
 * 从头到尾走一遍帧。任何一处对不上帧头就返回 null（交给 WAV 兜底）——
 * 宁可多花一点体积，也不要拼出一个中间夹着垃圾字节的文件。
 */
export function scanMp3(bytes: Uint8Array): ScannedMp3 | null {
  let at = id3v2Length(bytes);
  const end = hasId3v1(bytes) ? bytes.length - 128 : bytes.length;
  let start = at;
  let first: FrameInfo | null = null;
  let cbr = true;
  let index = 0;
  while (at < end) {
    const frame = parseFrameHeader(bytes, at);
    if (!frame) {
      // 文件尾巴上常有几十个字节的零填充或 APE 标签，走到这里之前至少有过帧就算正常结束。
      if (first && end - at < 512) break;
      return null;
    }
    if (index === 0 && containsAscii(bytes, at + 4, Math.min(at + frame.length, end), 'Xing')) {
      start = at + frame.length;
    } else if (index === 0 && containsAscii(bytes, at + 4, Math.min(at + frame.length, end), 'Info')) {
      start = at + frame.length;
    } else if (index === 0 && containsAscii(bytes, at + 4, Math.min(at + frame.length, end), 'VBRI')) {
      start = at + frame.length;
    } else if (!first) {
      first = frame;
    } else if (
      frame.bitrateIndex !== first.bitrateIndex ||
      frame.sampleRate !== first.sampleRate ||
      frame.mono !== first.mono
    ) {
      cbr = false;
    }
    at += frame.length;
    index++;
  }
  if (!first) return null;
  return { start, end: Math.min(at, end), first, cbr };
}

/** 只有「全是 CBR 且规格一致」才返回拼接好的字节，否则 null。纯函数，便于测试。 */
export function concatMp3Bytes(files: Uint8Array[]): Uint8Array<ArrayBuffer> | null {
  const scanned: ScannedMp3[] = [];
  for (const bytes of files) {
    const s = scanMp3(bytes);
    if (!s || !s.cbr) return null;
    const ref = scanned[0]?.first;
    if (
      ref &&
      (ref.bitrateIndex !== s.first.bitrateIndex ||
        ref.sampleRate !== s.first.sampleRate ||
        ref.mono !== s.first.mono ||
        ref.version !== s.first.version)
    ) {
      return null;
    }
    scanned.push(s);
  }
  const total = scanned.reduce((sum, s) => sum + (s.end - s.start), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  scanned.forEach((s, i) => {
    out.set(files[i].subarray(s.start, s.end), offset);
    offset += s.end - s.start;
  });
  return out;
}

/** 16 位 PCM 单声道 WAV。纯函数。 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out;
}

const WAV_RATE = 44100;

async function decodeMono(file: File): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, WAV_RATE);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

/** 拼好的文件名：`第一个 +N.mp3`，界面上一眼看得出这是拼出来的。 */
function concatName(files: File[], ext: string): string {
  const base = files[0].name.replace(/\.[^.]+$/, '');
  return `${base} +${files.length - 1}.${ext}`;
}

/**
 * 按给定顺序拼接。只有一个文件时原样返回 —— 不改字节，
 * 老路径（一课一个 mp3）的行为因此与以前完全一致。
 */
export async function concatAudioFiles(files: File[]): Promise<ConcatResult> {
  if (files.length === 0) throw new Error('没有要拼的文件');
  if (files.length === 1) return { file: files[0], method: 'bytes' };

  const buffers = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
  const joined = concatMp3Bytes(buffers);
  if (joined) {
    return { file: new File([joined], concatName(files, 'mp3'), { type: 'audio/mpeg' }), method: 'bytes' };
  }

  const parts: Float32Array[] = [];
  for (const f of files) parts.push(await decodeMono(f)); // 串行：一次只在内存里多放一轨的 PCM
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    all.set(p, offset);
    offset += p.length;
  }
  return { file: new File([encodeWav(all, WAV_RATE)], concatName(files, 'wav'), { type: 'audio/wav' }), method: 'wav' };
}

/**
 * 换设备补音频时（FR-3.6a），从一堆选中的文件里按课程记着的清单挑出那几个、排好顺序。
 * 缺哪个就列出来 —— 少一轨拼出来的时长就对不上，时间戳整段错位，不能将就。
 */
export function pickListedFiles(
  picked: File[],
  wanted: readonly string[],
): { files: File[]; missing: string[] } {
  const byName = new Map(picked.map((f) => [f.name, f]));
  const files: File[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const f = byName.get(name);
    if (f) files.push(f);
    else missing.push(name);
  }
  return { files, missing };
}
