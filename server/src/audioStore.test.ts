import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioRejected, createFileAudioStore, sniffAudioType } from './audioStore.ts';

// 音频存储（变更 69）要成立的性质：按内容定址（哈希对不上就拒）、存了能按区间读回来、
// **不会把这台共用机器的盘写满**（单个 + 总量上限）、用户之间互相看不见、写到一半不留坏文件。

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const mp3 = (n: number, fill = 1) => {
  const b = new Uint8Array(n).fill(fill);
  b[0] = 0xff;
  b[1] = 0xfb;
  return b;
};

describe('createFileAudioStore', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'audio-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('存进去按哈希读回来，字节一样、类型按内容认', async () => {
    const store = createFileAudioStore(root, { maxBytes: 1000, quotaBytes: 5000 });
    const bytes = mp3(300);
    expect(await store.put('u1', sha(bytes), bytes)).toBe('created');
    expect(await store.size('u1', sha(bytes))).toBe(300);
    const res = (await store.open('u1', sha(bytes)))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('cache-control')).toContain('private');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('同一份传第二次什么都不做', async () => {
    const store = createFileAudioStore(root, { maxBytes: 1000, quotaBytes: 5000 });
    const bytes = mp3(100);
    await store.put('u1', sha(bytes), bytes);
    expect(await store.put('u1', sha(bytes), bytes)).toBe('exists');
    expect(await store.usage('u1')).toBe(100);
  });

  it('内容和哈希对不上：拒收，盘上什么都不留', async () => {
    const store = createFileAudioStore(root, { maxBytes: 1000, quotaBytes: 5000 });
    const bytes = mp3(100);
    await expect(store.put('u1', sha(mp3(100, 2)), bytes)).rejects.toMatchObject({ status: 400 });
    expect(await store.usage('u1')).toBe(0);
  });

  it('单个超限 413、总量超限 507', async () => {
    const store = createFileAudioStore(root, { maxBytes: 200, quotaBytes: 300 });
    const big = mp3(201);
    await expect(store.put('u1', sha(big), big)).rejects.toMatchObject({ status: 413 });
    const a = mp3(200, 1);
    const b = mp3(200, 2);
    await store.put('u1', sha(a), a);
    const err = await store.put('u1', sha(b), b).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AudioRejected);
    expect((err as AudioRejected).status).toBe(507);
  });

  it('总量按用户算，也按用户隔开：别人的音频拿不到', async () => {
    const store = createFileAudioStore(root, { maxBytes: 200, quotaBytes: 300 });
    const a = mp3(200);
    await store.put('u1', sha(a), a);
    expect(await store.open('u2', sha(a))).toBeNull();
    expect(await store.size('u2', sha(a))).toBeNull();
    expect(await store.put('u2', sha(a), a)).toBe('created'); // u1 用掉的额度不算 u2 的
  });

  it('Range：单区间 206、越界 416', async () => {
    const store = createFileAudioStore(root, { maxBytes: 1000, quotaBytes: 5000 });
    const bytes = mp3(100);
    await store.put('u1', sha(bytes), bytes);
    const part = (await store.open('u1', sha(bytes), 'bytes=10-19'))!;
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(10, 20));
    expect((await store.open('u1', sha(bytes), 'bytes=500-'))!.status).toBe(416);
  });

  it('哈希之外的名字一律不认 —— 名字直接进路径，不能拿来往上跳目录', async () => {
    const store = createFileAudioStore(root, { maxBytes: 1000, quotaBytes: 5000 });
    await expect(store.size('u1', '../../etc/passwd')).rejects.toMatchObject({ status: 400 });
    await expect(store.put('u1', 'ABC', mp3(10))).rejects.toMatchObject({ status: 400 });
  });

  it('写完不留临时文件', async () => {
    const store = createFileAudioStore(root, { maxBytes: 1000, quotaBytes: 5000 });
    const bytes = mp3(100);
    await store.put('u1', sha(bytes), bytes);
    expect(readdirSync(join(root, 'u1'))).toEqual([sha(bytes)]);
  });
});

describe('sniffAudioType', () => {
  const ascii = (s: string, pad = 12) => new Uint8Array([...s.padEnd(pad, '\0')].map((c) => c.charCodeAt(0)));
  it.each([
    [ascii('ID3'), 'audio/mpeg'],
    [new Uint8Array([0xff, 0xfb, 0x50, 0xc4]), 'audio/mpeg'],
    [ascii('\0\0\0 ftypM4A '), 'audio/mp4'],
    [ascii('RIFF\0\0\0\0WAVE'), 'audio/wav'],
    [ascii('OggS'), 'audio/ogg'],
    [ascii('hello'), 'application/octet-stream'],
  ])('%#', (head, type) => {
    expect(sniffAudioType(head)).toBe(type);
  });
});
