// 变更 81：HLS 抽音频。TS 分片是手搓的最小合法包（PAT → PMT → 视频 + AAC 两条流），
// 字段位置照 ISO/IEC 13818-1；真分片在 2026-10-15 的浏览器实测里跑过（见 hls.ts 文件头）。

import { afterEach, describe, expect, it, vi } from 'vitest';

const pushed: Float32Array[] = [];
vi.mock('@/audio/concat', () => ({
  TRANSCODE_RATE: 44100,
  createMp3Stream: async () => ({
    push: async (pcm: Float32Array) => void pushed.push(pcm),
    finish: () => new Uint8Array([0xff, 0xfb]),
  }),
}));

import { downloadHlsAudio, extractAdts, isHlsUrl, parseMasterPlaylist, parseMediaPlaylist } from './hls';

const PMT_PID = 0x1000;
const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;

/** 一个 188 字节的 TS 包；负载不够长时用适配域填满（真分片里也是这么填的）。 */
function packet(pid: number, unitStart: boolean, payload: number[]): number[] {
  const head = [0x47, (unitStart ? 0x40 : 0) | (pid >> 8), pid & 0xff];
  const room = 188 - 4 - payload.length;
  if (room === 0) return [...head, 0x10, ...payload];
  // adaptation_field_control = 3：适配域 + 负载
  const adaptation = room === 1 ? [0] : [room - 1, 0x00, ...new Array(room - 2).fill(0xff)];
  return [...head, 0x30, ...adaptation, ...payload];
}

function pat(): number[] {
  // pointer_field, table_id, section_length=13, tsid, ver, sec, last, program 1 → PMT_PID, CRC
  return packet(0, true, [0, 0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff, 1, 2, 3, 4]);
}

function pmt(streams: Array<[type: number, pid: number]>): number[] {
  const entries = streams.flatMap(([type, pid]) => [type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0]);
  const len = 9 + entries.length + 4;
  return packet(PMT_PID, true, [0, 0x02, 0xb0, len, 0, 1, 0xc1, 0, 0, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0, ...entries, 1, 2, 3, 4]);
}

/** PES 头：起始码 + stream_id + 长度 + 两个标志字节 + 头长 5（一个 PTS）。 */
function pes(payload: number[]): number[] {
  return [0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1, ...payload];
}

function segment(...packets: number[][]): Uint8Array {
  return new Uint8Array(packets.flat());
}

const STREAMS: Array<[number, number]> = [
  [0x1b, VIDEO_PID],
  [0x0f, AUDIO_PID],
];

describe('extractAdts', () => {
  it('只留 AAC 那条流的负载：去掉 PES 头、跨包接上、视频包跳过', () => {
    const ts = segment(
      pat(),
      pmt(STREAMS),
      packet(VIDEO_PID, true, [9, 9, 9]),
      packet(AUDIO_PID, true, pes([0xff, 0xf1, 1, 2])),
      packet(VIDEO_PID, false, [9]),
      packet(AUDIO_PID, false, [3, 4]),
      packet(AUDIO_PID, true, pes([0xff, 0xf1, 5])),
    );
    expect([...extractAdts(ts)]).toEqual([0xff, 0xf1, 1, 2, 3, 4, 0xff, 0xf1, 5]);
  });

  it('负载正好填满 184 字节、没有适配域的包也认', () => {
    const body = new Array(184 - 14).fill(7);
    const ts = segment(pat(), pmt(STREAMS), packet(AUDIO_PID, true, pes(body)));
    expect(extractAdts(ts)).toHaveLength(body.length);
  });

  it('PMT 里没有 AAC 流时报错，而不是交出一段空音频', () => {
    expect(() => extractAdts(segment(pat(), pmt([[0x1b, VIDEO_PID]])))).toThrow('没有 AAC');
  });

  it('不是 TS（比如拿到了一张错误页）时报错', () => {
    expect(() => extractAdts(new Uint8Array(188).fill(0x3c))).toThrow('不是 MPEG-TS');
  });
});

describe('播放列表', () => {
  it('isHlsUrl 认 .m3u8，带查询串也认；mp3 不认', () => {
    expect(isHlsUrl('https://x.invalid/a/master.m3u8')).toBe(true);
    expect(isHlsUrl('https://x.invalid/a/master.m3u8?token=1')).toBe(true);
    expect(isHlsUrl('https://x.invalid/a.mp3')).toBe(false);
    expect(isHlsUrl('https://x.invalid/m3u8/a.mp3')).toBe(false);
  });

  it('master：相对地址按 master 解析，没写码率的排到最后', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1200000,RESOLUTION=640x360',
      'index_0_av.m3u8?null=0',
      '#EXT-X-STREAM-INF:PROGRAM-ID=1,RESOLUTION=320x180',
      '',
      'https://other.invalid/low.m3u8',
    ].join('\r\n');
    expect(parseMasterPlaylist(text, 'https://cdn.invalid/i/folge.csmil/master.m3u8')).toEqual([
      { url: 'https://cdn.invalid/i/folge.csmil/index_0_av.m3u8?null=0', bandwidth: 1200000 },
      { url: 'https://other.invalid/low.m3u8', bandwidth: Infinity },
    ]);
  });

  it('媒体列表：分片按出现顺序，EXTINF 加总成时长', () => {
    const text = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.000,\nsegment1_0_av.ts\n#EXTINF:4.5,\nsegment2_0_av.ts\n#EXT-X-ENDLIST\n';
    expect(parseMediaPlaylist(text, 'https://cdn.invalid/i/index.m3u8')).toEqual({
      segments: ['https://cdn.invalid/i/segment1_0_av.ts', 'https://cdn.invalid/i/segment2_0_av.ts'],
      duration: 14.5,
    });
  });
});

describe('downloadHlsAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    pushed.length = 0;
  });

  function stubNetwork(): string[] {
    const urls: string[] = [];
    const files: Record<string, { url?: string; body: string | Uint8Array }> = {
      // master 被重定向到另一个域名：变体地址要相对重定向之后那个
      'https://hls.invalid/master.m3u8': {
        url: 'https://rwrtr.invalid/i/master.m3u8',
        body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=300000\nlow.m3u8\n',
      },
      'https://rwrtr.invalid/i/low.m3u8': { body: '#EXTM3U\n#EXTINF:10,\nseg1.ts\n#EXTINF:3,\nseg2.ts\n' },
      'https://rwrtr.invalid/i/seg1.ts': { body: segment(pat(), pmt(STREAMS), packet(AUDIO_PID, true, pes([1, 2]))) },
      'https://rwrtr.invalid/i/seg2.ts': { body: segment(pat(), pmt(STREAMS), packet(AUDIO_PID, true, pes([3]))) },
    };
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const file = files[url];
      if (!file) return { ok: false, status: 404 };
      return {
        ok: true,
        url: file.url ?? url,
        text: async () => file.body as string,
        arrayBuffer: async () => (file.body as Uint8Array).slice().buffer,
      };
    });
    return urls;
  }

  it('取码率最低的变体、整段拼好只解码一次、混成单声道转 mp3', async () => {
    const urls = stubNetwork();
    const decoded: number[][] = [];
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        async decodeAudioData(buf: ArrayBuffer) {
          decoded.push([...new Uint8Array(buf)]);
          const channels = [new Float32Array([1, 0.5]), new Float32Array([0, 0.5])];
          return { length: 2, numberOfChannels: 2, getChannelData: (c: number) => channels[c] };
        }
      },
    );
    const progress: Array<[number, number]> = [];

    const blob = await downloadHlsAudio('https://hls.invalid/master.m3u8', (l, t) => progress.push([l, t]));

    expect(urls).not.toContain('https://rwrtr.invalid/i/high.m3u8');
    expect(decoded).toEqual([[1, 2, 3]]);
    expect(pushed.map((p) => [...p])).toEqual([[0.5, 0.5]]);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect(blob.type).toBe('audio/mpeg');
  });

  it('分片下载失败时报第几片，不交出半截音频', async () => {
    stubNetwork();
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('.ts')
        ? { ok: false, status: 503 }
        : { ok: true, url, text: async () => '#EXTM3U\n#EXTINF:10,\nseg1.ts\n' },
    );
    await expect(downloadHlsAudio('https://hls.invalid/media.m3u8')).rejects.toThrow('第 1/1 个分片下载失败：503');
  });
});
