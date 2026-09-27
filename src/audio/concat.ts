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
// 2. **解码后重新编码成 64kbps 单声道 CBR mp3**（其余情况，变更 69）：VBR、规格不一致、不是 mp3。
//    VBR 不能按字节拼，因为去掉 Xing 头之后浏览器只能按码率估位置，`<audio>` 的 seek 会偏 —— 而跟读
//    整个建立在「跳到这一句的起点」上。转成 CBR 之后 seek 是精确的，体积还比原声小一半
//    （Aspekte neu C1 的原声平均 129kbps）。64kbps 单声道对说话录音听不出差别；再往下压就开始糊了，
//    而这个应用练的正是听。以前这条路是拼成 WAV（约 5MB/分钟），一本书的多轨题就有 470MB。
//
// ── 单个文件也可能转 ──
// VBR 的 mp3 单独一个也 seek 不准，WAV 单独一个也太大：这两种单个文件照样转。
// CBR mp3 与其它本来就压缩过的格式（m4a / ogg / opus）原样保留 —— 它们 seek 是准的，不必再损一代。
//
// **转码不是确定性的**：不同浏览器的 mp3 解码器差几个采样，同一份原声在两台设备上转出来字节不同。
// FR-3.6a 的「换没换音频」因此落到比时长那一档（0.5 秒容差），不会被误判成换过。

export interface ConcatResult {
  file: File;
  /** 走的是哪条路：原样 / 按字节拼，还是解码后重新编码 */
  method: 'bytes' | 'mp3';
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

/** 转码的规格：MPEG1 Layer III，44.1kHz，单声道，CBR 64kbps。 */
export const TRANSCODE_RATE = 44100;
export const TRANSCODE_KBPS = 64;

/** 一次喂给编码器多少采样（1152 的整数倍 = 整帧），每喂这么多就让一次主线程，界面不卡死。 */
const CHUNK = 1152 * 256;

/** Float32 [-1, 1] → Int16，越界的夹住。纯函数。 */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

type Mp3Encoder = { encodeBuffer(pcm: Int16Array): Uint8Array; flush(): Uint8Array };

/**
 * 流式编码：几轨一段一段喂进同一个编码器，拼接处没有缝；一次只在内存里放一轨的 PCM
 * （Aspekte 最长一轨 12 分钟 ≈ 127MB Float32，整题一次性解码要翻几倍）。
 * lamejs（LGPL-3.0，纯 JS 约 150KB）只有真要转码时才加载。
 */
export async function createMp3Stream(): Promise<{
  push(samples: Float32Array): Promise<void>;
  finish(): Uint8Array<ArrayBuffer>;
}> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const encoder: Mp3Encoder = new Mp3Encoder(1, TRANSCODE_RATE, TRANSCODE_KBPS);
  const chunks: Uint8Array[] = [];
  return {
    async push(samples) {
      for (let i = 0; i < samples.length; i += CHUNK) {
        chunks.push(encoder.encodeBuffer(toInt16(samples.subarray(i, i + CHUNK))));
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    finish() {
      chunks.push(encoder.flush());
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return out;
    },
  };
}

/** 单个文件要不要转：VBR 的 mp3（seek 不准）与 WAV（太大）要转，其余原样。 */
export function needsTranscode(bytes: Uint8Array): boolean {
  const mp3 = scanMp3(bytes);
  if (mp3) return !mp3.cbr;
  const riff = bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF';
  return riff && String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE';
}

async function decodeMono(file: File): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, TRANSCODE_RATE);
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
 * 按给定顺序拼接（顺带把单个 VBR / WAV 转成 CBR mp3）。
 * 单个 CBR mp3 或 m4a 之类原样返回 —— 不改字节，一课一个 mp3 的老路径与以前完全一致。
 */
export async function concatAudioFiles(files: File[]): Promise<ConcatResult> {
  if (files.length === 0) throw new Error('没有要拼的文件');

  if (files.length === 1) {
    const [only] = files;
    if (!needsTranscode(new Uint8Array(await only.arrayBuffer()))) return { file: only, method: 'bytes' };
    // 名字不改：课程记着的是这个名字，换设备补音频时按它认领（FR-3.6a）
    return { file: new File([await transcode(files)], only.name, { type: 'audio/mpeg' }), method: 'mp3' };
  }

  const buffers = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
  const joined = concatMp3Bytes(buffers);
  if (joined) {
    return { file: new File([joined], concatName(files, 'mp3'), { type: 'audio/mpeg' }), method: 'bytes' };
  }
  return { file: new File([await transcode(files)], concatName(files, 'mp3'), { type: 'audio/mpeg' }), method: 'mp3' };
}

async function transcode(files: File[]): Promise<Uint8Array<ArrayBuffer>> {
  const stream = await createMp3Stream();
  for (const f of files) await stream.push(await decodeMono(f)); // 串行：一次只解码一轨
  return stream.finish();
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
