// 这一层的价值全在「峰值内存」上，而内存峰值测不了。所以测的是能测的那部分：
//   1. 真的按分片取，且每个分片都带 Range —— 原生壳靠这个才走 FileHandle 而不是整份读盘；
//   2. 拼出来的字节与源文件**逐字节相同**（错一个字节 = 模型加载失败，而且报错完全对不上号）；
//   3. 服务端不支持 Range 时**放手**，退回原路而不是自己造一个错的响应。
// 第 3 条是这层的安全阀：忽略 Range 的服务器会把整份文件当成每个分片返回。

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createStreamingWeightsCache, probeRanged } from './rangedFetch';

// 用 4 字节的分片跑完整条流程。真实值是 8MB，但「offset 有没有推进」「最后一片会不会
// 越界」跟分片大小无关，而拿 8MB 去测要分配几十 MB —— 那会把 vitest 的 worker 撑爆。
const CHUNK = 4;

const PREFIX = '/models/';
const URL_ONNX = `${PREFIX}some-org/some-model/onnx/model_q4f16.onnx`;

/** TS 7 的 BodyInit 不吃 Uint8Array<ArrayBufferLike>，取出它底下那段 ArrayBuffer。 */
function body(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** 假一个支持 Range 的静态服务器。记下每一次请求的 Range 头。 */
function rangeServer(bytes: Uint8Array) {
  const ranges: string[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const header = (init?.headers as Record<string, string> | undefined)?.Range;
    ranges.push(header ?? '(none)');
    const match = /bytes=(\d+)-(\d+)/.exec(header ?? '');
    if (!match) return new Response(body(bytes), { status: 200 });
    const from = Number(match[1]);
    const to = Math.min(bytes.length - 1, Number(match[2]));
    return new Response(body(bytes.slice(from, to + 1)), {
      status: 206,
      headers: { 'Content-Range': `bytes ${from}-${to}/${bytes.length}` },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { ranges, fetchMock, url: URL_ONNX };
}

afterEach(() => vi.unstubAllGlobals());

describe('probeRanged', () => {
  it('从 content-range 读出总长度', async () => {
    rangeServer(new Uint8Array(1234));
    expect(await probeRanged(URL_ONNX)).toBe(1234);
  });

  it('服务端忽略 Range（回 200）时返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(10), { status: 200 })));
    expect(await probeRanged(URL_ONNX)).toBeNull();
  });

  it('回 206 但给的是整份时也返回 null —— Vite dev server 实测就是这样', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new ArrayBuffer(196703176), {
            status: 206,
            headers: { 'Content-Range': 'bytes 0-196703175/196703176' },
          }),
      ),
    );
    expect(await probeRanged(URL_ONNX)).toBeNull();
  });

  it('请求本身炸了也只是返回 null —— 探测失败不该让对齐失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await probeRanged(URL_ONNX)).toBeNull();
  });
});

describe('createStreamingWeightsCache', () => {
  it('分片取回来的字节与源文件完全一致，且每片都带 Range', async () => {
    // 不是分片的整数倍：最后一片必须只取剩下的那 3 个字节，不能越界。
    const size = CHUNK * 2 + 3;
    const source = new Uint8Array(size);
    for (let i = 0; i < size; i++) source[i] = (i * 31 + 7) & 0xff;

    const server = rangeServer(source);
    const cache = createStreamingWeightsCache(PREFIX, CHUNK);
    const res = await cache.match(URL_ONNX);
    expect(res).toBeDefined();
    // Content-Length 必须在，transformers.js 靠它一次性把缓冲分配到位。
    expect(res!.headers.get('Content-Length')).toBe(String(size));

    const got = new Uint8Array(await res!.arrayBuffer());
    expect(got.length).toBe(size);
    expect(got).toEqual(source);

    // 一次探测 + 三个分片，全部带 Range。
    expect(server.ranges).toEqual([
      'bytes=0-0',
      `bytes=0-${CHUNK - 1}`,
      `bytes=${CHUNK}-${CHUNK * 2 - 1}`,
      `bytes=${CHUNK * 2}-${size - 1}`,
    ]);
  });

  it('不支持 Range 就放手（返回 undefined），让 transformers.js 走原路', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(4), { status: 200 })));
    const cache = createStreamingWeightsCache(PREFIX);
    expect(await cache.match(URL_ONNX)).toBeUndefined();
  });

  it('只接管随包权重里的 .onnx —— 小 JSON 和远端 URL 一概不碰', async () => {
    const server = rangeServer(new Uint8Array(8));
    const cache = createStreamingWeightsCache(PREFIX);
    expect(await cache.match(`${PREFIX}some-org/some-model/config.json`)).toBeUndefined();
    expect(await cache.match('https://huggingface.co/x/resolve/main/onnx/model.onnx')).toBeUndefined();
    // 一次请求都不该发出去。
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it('put 是空操作 —— 已经在盘上的文件不该再抄一份进 Cache API', async () => {
    const cache = createStreamingWeightsCache(PREFIX);
    await expect(cache.put()).resolves.toBeUndefined();
  });
});
