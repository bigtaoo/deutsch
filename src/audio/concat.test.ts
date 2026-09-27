// FR-1.8：多轨拼接。用手工拼出来的 MPEG1 Layer III 帧测字节那条路 ——
// 转码那条路：编码器是真的 lamejs；解码（Web Audio）jsdom 里没有，用一个假的 OfflineAudioContext 顶上。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  concatAudioFiles,
  concatMp3Bytes,
  createMp3Stream,
  needsTranscode,
  parseFrameHeader,
  pickListedFiles,
  scanMp3,
  toInt16,
} from './concat';

/** 44.1kHz 的一帧。128kbps → 417 字节，160kbps → 522 字节。 */
function frame({ kbps = 128, mono = false, fill = 0x11, marker }: { kbps?: 128 | 160; mono?: boolean; fill?: number; marker?: string } = {}): number[] {
  const length = kbps === 128 ? 417 : 522;
  const bytes = new Array<number>(length).fill(fill);
  bytes[0] = 0xff;
  bytes[1] = 0xfb; // MPEG1, Layer III, 无 CRC
  bytes[2] = kbps === 128 ? 0x90 : 0xa0; // 码率档 9/10，44.1kHz，无填充
  bytes[3] = mono ? 0xc0 : 0x00;
  if (marker) [...marker].forEach((c, i) => (bytes[36 + i] = c.charCodeAt(0)));
  return bytes;
}

function id3v2(payload = 20): number[] {
  return [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, payload, ...new Array<number>(payload).fill(0)];
}

function id3v1(): number[] {
  return [0x54, 0x41, 0x47, ...new Array<number>(125).fill(0x20)];
}

function mp3(parts: number[][]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(parts.flat());
}

describe('parseFrameHeader', () => {
  it('算出 Layer III 帧长', () => {
    expect(parseFrameHeader(new Uint8Array(frame()), 0)).toMatchObject({ length: 417, sampleRate: 44100, mono: false });
    expect(parseFrameHeader(new Uint8Array(frame({ kbps: 160, mono: true })), 0)).toMatchObject({ length: 522, mono: true });
  });

  it('不是帧头就返回 null', () => {
    expect(parseFrameHeader(new Uint8Array([0x49, 0x44, 0x33, 4]), 0)).toBeNull();
    expect(parseFrameHeader(new Uint8Array([0xff, 0xfb]), 0)).toBeNull(); // 不够 4 字节
  });
});

describe('scanMp3', () => {
  it('跳过 ID3v2、Info 头帧与 ID3v1，只留音频帧', () => {
    const bytes = mp3([id3v2(), frame({ marker: 'Info' }), frame({ fill: 1 }), frame({ fill: 2 }), id3v1()]);
    const scan = scanMp3(bytes)!;
    expect(scan.start).toBe(30 + 417);
    expect(scan.end).toBe(30 + 417 * 3);
    expect(scan.cbr).toBe(true);
  });

  it('Xing 头帧同样去掉 —— 留着它浏览器会把整段拼接报成第一轨的时长', () => {
    const scan = scanMp3(mp3([frame({ marker: 'Xing' }), frame()]))!;
    expect(scan.start).toBe(417);
  });

  it('码率在变 = VBR', () => {
    expect(scanMp3(mp3([frame(), frame({ kbps: 160 })]))!.cbr).toBe(false);
  });

  it('中间夹着垃圾字节就放弃（交给 WAV 兜底），不拼出一个坏文件', () => {
    expect(scanMp3(mp3([frame(), new Array<number>(2000).fill(0), frame()]))).toBeNull();
  });

  it('尾巴上的少量零填充不算坏', () => {
    expect(scanMp3(mp3([frame(), new Array<number>(64).fill(0)]))).not.toBeNull();
  });
});

describe('concatMp3Bytes', () => {
  it('同规格的 CBR：去掉标签后首尾相接', () => {
    const a = mp3([id3v2(), frame({ marker: 'Info' }), frame({ fill: 1 }), id3v1()]);
    const b = mp3([id3v2(40), frame({ marker: 'Info' }), frame({ fill: 2 }), frame({ fill: 3 })]);
    const out = concatMp3Bytes([a, b])!;
    expect(out.length).toBe(417 * 3);
    expect([out[4], out[417 + 4], out[834 + 4]]).toEqual([1, 2, 3]);
    expect(scanMp3(out)).toMatchObject({ start: 0, end: 417 * 3, cbr: true });
  });

  it('确定性：同样几个文件拼两次字节完全一样（换设备补音频不会被判成换过，FR-3.6a）', () => {
    const a = mp3([frame({ fill: 1 })]);
    const b = mp3([frame({ fill: 2 })]);
    expect(concatMp3Bytes([a, b])).toEqual(concatMp3Bytes([a, b]));
  });

  it('码率不同、声道不同、VBR 都拒绝按字节拼', () => {
    expect(concatMp3Bytes([mp3([frame()]), mp3([frame({ kbps: 160 })])])).toBeNull();
    expect(concatMp3Bytes([mp3([frame()]), mp3([frame({ mono: true })])])).toBeNull();
    expect(concatMp3Bytes([mp3([frame(), frame({ kbps: 160 })]), mp3([frame()])])).toBeNull();
  });

  it('不是 mp3 就拒绝', () => {
    expect(concatMp3Bytes([mp3([frame()]), new TextEncoder().encode('RIFF....WAVEfmt ')])).toBeNull();
  });
});

describe('concatAudioFiles', () => {
  it('只有一个文件时原样返回 —— 一课一个 mp3 的老路径字节不变', async () => {
    const file = new File([mp3([id3v2(), frame()])], 'a.mp3', { type: 'audio/mpeg' });
    const { file: out, method } = await concatAudioFiles([file]);
    expect(out).toBe(file);
    expect(method).toBe('bytes');
  });

  it('几个 CBR 文件走字节路，文件名标出拼了几轨', async () => {
    const a = new File([mp3([frame({ fill: 1 })])], '1_02.mp3');
    const b = new File([mp3([frame({ fill: 2 })])], '1_03.mp3');
    const c = new File([mp3([frame({ fill: 3 })])], '1_04.mp3');
    const { file, method } = await concatAudioFiles([a, b, c]);
    expect(method).toBe('bytes');
    expect(file.name).toBe('1_02 +2.mp3');
    expect(file.type).toBe('audio/mpeg');
    expect(file.size).toBe(417 * 3);
  });

  it('一个文件都没有是调用方的错', async () => {
    await expect(concatAudioFiles([])).rejects.toThrow();
  });
});

describe('toInt16', () => {
  it('[-1, 1] 映射到 16 位，越界的夹住', () => {
    expect([...toInt16(new Float32Array([0, 1, -1, 2, -3]))]).toEqual([0, 0x7fff, -0x8000, 0x7fff, -0x8000]);
  });
});

/** 最小的 WAV 头（RIFF….WAVE）+ 几个采样 */
function wavBytes(): Uint8Array {
  const out = new Uint8Array(48);
  out.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  out.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  return out;
}

describe('needsTranscode', () => {
  it('CBR mp3 不转；VBR mp3 转（seek 不准）；WAV 转（太大）；m4a 之类不认识的原样', () => {
    expect(needsTranscode(mp3([id3v2(), frame(), frame()]))).toBe(false);
    expect(needsTranscode(mp3([frame({ kbps: 128 }), frame({ kbps: 160 })]))).toBe(true);
    expect(needsTranscode(wavBytes())).toBe(true);
    expect(needsTranscode(new Uint8Array([0, 0, 0, 0x20, ...[...'ftypM4A '].map((c) => c.charCodeAt(0))]))).toBe(false);
  });

  it('带 Info 头的 CBR（LAME 写的）不转', () => {
    expect(needsTranscode(mp3([frame({ marker: 'Info' }), frame(), frame()]))).toBe(false);
  });
});

/** 1 秒 440Hz 正弦 */
const tone = (seconds: number) => {
  const out = new Float32Array(Math.round(44100 * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
  return out;
};

describe('createMp3Stream（真的 lamejs）', () => {
  it('编出来是 64kbps 单声道 44.1kHz 的 CBR —— 于是能按字节拼、seek 准', async () => {
    const stream = await createMp3Stream();
    await stream.push(tone(2));
    const bytes = stream.finish();
    const scanned = scanMp3(bytes)!;
    expect(scanned.cbr).toBe(true);
    expect(scanned.first).toMatchObject({ version: 3, sampleRate: 44100, mono: true, bitrateIndex: 5 }); // 5 = 64kbps
    expect(bytes.length / 2).toBeGreaterThan(7_500); // 64kbps ≈ 8000 字节/秒
    expect(bytes.length / 2).toBeLessThan(8_800);
  });

  it('分几段喂（几轨、或一轨切成好几块）：帧数 = 总采样数 / 1152，中间没有多出来的缝', async () => {
    const stream = await createMp3Stream();
    await stream.push(tone(1.3));
    await stream.push(tone(0.7));
    const bytes = stream.finish();
    let frames = 0;
    for (let at = 0; at < bytes.length; ) {
      const f = parseFrameHeader(bytes, at);
      if (!f) break;
      frames++;
      at += f.length;
    }
    const expected = (44100 * 2) / 1152; // ≈ 76.6
    expect(frames).toBeGreaterThanOrEqual(Math.floor(expected));
    expect(frames).toBeLessThanOrEqual(Math.ceil(expected) + 2); // 编码器延迟 + 末帧补齐
  });
});

describe('concatAudioFiles · 转码那条路', () => {
  /** 假的解码器：每个文件解成「文件字节数 / 100」秒的两声道正弦 */
  function fakeAudioContext() {
    const decoded: number[] = [];
    class FakeOfflineAudioContext {
      decodeAudioData(buf: ArrayBuffer) {
        const seconds = buf.byteLength / 100;
        decoded.push(seconds);
        const data = tone(seconds);
        return Promise.resolve({ length: data.length, numberOfChannels: 2, getChannelData: () => data });
      }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
    return decoded;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('几轨 VBR：按顺序逐轨解码、编成一个 CBR mp3，文件名标出拼了几轨', async () => {
    const decoded = fakeAudioContext();
    // 不是 mp3 的字节 → 字节路拒绝 → 转码；字节数定了假解码器解出来多长
    const a = new File([new Uint8Array(100)], '2_20.mp3');
    const b = new File([new Uint8Array(50)], '2_21.mp3');
    const { file, method } = await concatAudioFiles([a, b]);
    expect(method).toBe('mp3');
    expect(file.name).toBe('2_20 +1.mp3');
    expect(file.type).toBe('audio/mpeg');
    expect(decoded).toEqual([1, 0.5]);
    const scanned = scanMp3(new Uint8Array(await file.arrayBuffer()))!;
    expect(scanned.cbr).toBe(true);
    expect(scanned.first.mono).toBe(true);
  });

  it('单个 VBR mp3 也转，名字不改（课程按这个名字认领音频，FR-3.6a）', async () => {
    fakeAudioContext();
    const vbr = new File([mp3([frame({ kbps: 128 }), frame({ kbps: 160 }), frame({ kbps: 128 })])], '605038_LB_CD2 (17).mp3');
    const { file, method } = await concatAudioFiles([vbr]);
    expect(method).toBe('mp3');
    expect(file.name).toBe('605038_LB_CD2 (17).mp3');
    expect(file).not.toBe(vbr);
    expect(scanMp3(new Uint8Array(await file.arrayBuffer()))!.cbr).toBe(true);
  });

  it('单个 CBR mp3 不解码、原样返回', async () => {
    const decoded = fakeAudioContext();
    const cbr = new File([mp3([frame(), frame()])], 'a.mp3');
    expect((await concatAudioFiles([cbr])).file).toBe(cbr);
    expect(decoded).toEqual([]);
  });
});

describe('pickListedFiles', () => {
  const f = (name: string) => new File([], name);

  it('按清单的顺序挑，不按选择的顺序', () => {
    const { files, missing } = pickListedFiles([f('b.mp3'), f('x.mp3'), f('a.mp3')], ['a.mp3', 'b.mp3']);
    expect(files.map((x) => x.name)).toEqual(['a.mp3', 'b.mp3']);
    expect(missing).toEqual([]);
  });

  it('缺的逐个列出来', () => {
    expect(pickListedFiles([f('a.mp3')], ['a.mp3', 'b.mp3', 'c.mp3']).missing).toEqual(['b.mp3', 'c.mp3']);
  });
});
