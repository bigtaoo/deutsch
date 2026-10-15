// 变更 81：视频课（Jojo sucht das Glück）的音频 —— 从 HLS 视频流里抽出声音，转成 64kbps 单声道 mp3。
//
// ── 为什么要走这条路 ──
// Jojo 这类剧集课在 DW 页面上 `audios: []`，只有 `videos[].hlsVideoSrc`（2026-10-15 实测）。
// HLS 里也没有单独的音频轨：每个 MPEG-TS 分片里视频（avc1）和音频（AAC）交织在一起。
// 所以：master.m3u8 → 选码率最低的那条变体 → 逐个下分片 → 只取音频 PID 的 PES 负载
// （它本身就是 ADTS 封装的 AAC，首尾相接就是一个合法的 .aac 流）→ `decodeAudioData` → 复用教材
// 那套 mp3 编码器（`audio/concat.ts`）。
//
// 实测（第三季第 4 集）：36 个分片 28.8MB、6.4 秒下完，抽出来的 AAC 4.0MB，解码 334.88 秒，
// 与播放列表 EXTINF 加总的 334.84 秒对得上。三个域名（hlsvod.dw.com / dwvod-rwrtr / dwvod-pckgr
// .akamaized.net）从应用域名都能跨域读。
//
// **整段拼好再解码，不逐片解码**：AAC 每次从头解码都有一段编码器预滚（priming）采样，逐片解码再拼，
// 每个接缝都会多出几十毫秒，三十几个接缝累起来时间戳就整段漂了。
//
// ── 为什么转 mp3 而不是直接存 .aac ──
// ADTS 流没有索引，`<audio>` 只能按码率估 seek 位置；跟读整个建立在「跳到这一句的起点」上。
// 转成 CBR mp3 之后 seek 是精确的，后面的播放器、对齐、缓存一行都不用改。
//
// **转码不是确定性的**（与 concat.ts 同一个说法）：不同设备上的 AAC 解码器差几个采样，转出来的字节数
// 不一样。所以这类课补齐素材时「换没换音频」比时长，不比字节（见 importLesson.ts 里 `isHlsUrl` 那一处）。

import { createMp3Stream, TRANSCODE_RATE } from '@/audio/concat';

/** 认得出这是 HLS 播放列表地址就走这条路；`Lesson.audioSrc` 里记的就是它。 */
export function isHlsUrl(url: string): boolean {
  return /\.m3u8(?:$|[?#])/i.test(url);
}

/** master 播放列表里的一条变体。没有 BANDWIDTH 的记 Infinity，排到最后。 */
export interface HlsVariant {
  url: string;
  bandwidth: number;
}

/** 解析 master：每条 `#EXT-X-STREAM-INF` 后面那一行是变体地址（相对地址按 master 的地址解析）。 */
export function parseMasterPlaylist(text: string, baseUrl: string): HlsVariant[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!uri) continue;
    const bw = /[:,]BANDWIDTH=(\d+)/.exec(lines[i])?.[1];
    out.push({ url: new URL(uri, baseUrl).href, bandwidth: bw ? Number(bw) : Infinity });
  }
  return out;
}

/** 解析媒体播放列表：非注释行就是分片地址。顺带把 EXTINF 加总，用来核对解码出来的时长。 */
export function parseMediaPlaylist(text: string, baseUrl: string): { segments: string[]; duration: number } {
  const segments: string[] = [];
  let duration = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) duration += Number.parseFloat(line.slice(8)) || 0;
    else if (!line.startsWith('#')) segments.push(new URL(line, baseUrl).href);
  }
  return { segments, duration };
}

const TS_PACKET = 188;
const STREAM_TYPE_AAC_ADTS = 0x0f;

/**
 * 从一个 MPEG-TS 分片里取出 AAC 音频（ADTS 帧），丢掉视频。
 *
 * 只做这件事需要的那一点 TS：PAT（PID 0）→ PMT → 流类型 0x0F 的那个 PID → 它的 PES 负载去掉 PES 头。
 * 每个分片都自带 PAT/PMT（HLS 要求分片能独立解码），所以每片单独解析，不跨片记状态。
 */
export function extractAdts(ts: Uint8Array): Uint8Array {
  let pmtPid = -1;
  let audioPid = -1;
  const parts: Uint8Array[] = [];
  for (let o = 0; o + TS_PACKET <= ts.length; o += TS_PACKET) {
    if (ts[o] !== 0x47) throw new Error(`不是 MPEG-TS：第 ${o} 字节处没有同步字节`);
    const unitStart = (ts[o + 1] & 0x40) !== 0;
    const pid = ((ts[o + 1] & 0x1f) << 8) | ts[o + 2];
    const adaptation = (ts[o + 3] >> 4) & 3;
    const end = o + TS_PACKET;
    let p = o + 4;
    if (adaptation === 2) continue; // 只有适配域，没有负载
    if (adaptation === 3) p += 1 + ts[p];
    if (p >= end) continue;

    if (pid === 0 || pid === pmtPid) {
      if (unitStart) p += 1 + ts[p]; // pointer_field
      const sectionLength = ((ts[p + 1] & 0x0f) << 8) | ts[p + 2];
      const sectionEnd = Math.min(p + 3 + sectionLength - 4, end); // 去掉 CRC32
      if (pid === 0) {
        for (let i = p + 8; i + 4 <= sectionEnd; i += 4) {
          const program = (ts[i] << 8) | ts[i + 1];
          if (program !== 0) pmtPid = ((ts[i + 2] & 0x1f) << 8) | ts[i + 3];
        }
      } else if (audioPid < 0) {
        const programInfoLength = ((ts[p + 10] & 0x0f) << 8) | ts[p + 11];
        for (let i = p + 12 + programInfoLength; i + 5 <= sectionEnd; ) {
          const streamType = ts[i];
          const elementaryPid = ((ts[i + 1] & 0x1f) << 8) | ts[i + 2];
          const infoLength = ((ts[i + 3] & 0x0f) << 8) | ts[i + 4];
          if (streamType === STREAM_TYPE_AAC_ADTS) {
            audioPid = elementaryPid;
            break;
          }
          i += 5 + infoLength;
        }
      }
      continue;
    }

    if (pid === audioPid) {
      if (unitStart) p += 9 + ts[p + 8]; // PES 头：6 字节固定 + 3 字节可选头 + PES_header_data_length
      if (p < end) parts.push(ts.subarray(p, end));
    }
  }
  if (audioPid < 0) throw new Error('分片里没有 AAC 音频轨');
  return concatBytes(parts);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of parts) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function fetchText(url: string): Promise<{ text: string; url: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`播放列表请求失败：${res.status}`);
  // 用 res.url 当相对地址的基准：master 会被重定向到另一个域名，变体地址相对的是重定向之后那个
  return { text: await res.text(), url: res.url || url };
}

/**
 * 下载一条 HLS 流的声音，转成 64kbps 单声道 CBR mp3。
 *
 * 进度按分片数报（loaded = 已下的片数，total = 总片数）：分片没有统一的 Content-Length 可加总，
 * 而界面只需要一个百分比。
 *
 * 分片是**串行**下的、彼此之间不再额外等 1 秒：R-3 的礼貌间隔管的是「一次导入」这件事
 * （调用方整个包在 `politely()` 里），一条视频流的分片本来就是播放器连着取的，等于看一遍这集。
 */
export async function downloadHlsAudio(
  masterUrl: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob> {
  let playlist = await fetchText(masterUrl);
  const variants = parseMasterPlaylist(playlist.text, playlist.url);
  if (variants.length > 0) {
    // 声音在每条变体里都是同一份 AAC，取码率最低的那条：视频下得越少越好
    const lowest = variants.reduce((a, b) => (b.bandwidth < a.bandwidth ? b : a));
    playlist = await fetchText(lowest.url);
  }
  const { segments } = parseMediaPlaylist(playlist.text, playlist.url);
  if (segments.length === 0) throw new Error('播放列表里没有分片');

  const audio: Uint8Array[] = [];
  onProgress?.(0, segments.length);
  for (let i = 0; i < segments.length; i++) {
    const res = await fetch(segments[i]);
    if (!res.ok) throw new Error(`第 ${i + 1}/${segments.length} 个分片下载失败：${res.status}`);
    audio.push(extractAdts(new Uint8Array(await res.arrayBuffer())));
    onProgress?.(i + 1, segments.length);
  }

  const ctx = new OfflineAudioContext(1, 1, TRANSCODE_RATE);
  const buffer = await ctx.decodeAudioData(concatBytes(audio).buffer);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  const stream = await createMp3Stream();
  await stream.push(mono);
  return new Blob([stream.finish()], { type: 'audio/mpeg' });
}
