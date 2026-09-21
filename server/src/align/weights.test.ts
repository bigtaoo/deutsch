// 权重站。测的是**安全边界**（目录穿越、扩展名白名单）与 Range，
// 不测「文件内容对不对」—— 那是 scp 上去的人的事。

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRange, resolveWeightsPath, serveWeights } from './weights.ts';

let dir = '';
const REL = 'oliverguhr/wav2vec2-large-xlsr-53-german-cv9/onnx/model_q4.onnx';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'weights-'));
  await mkdir(join(dir, 'oliverguhr/wav2vec2-large-xlsr-53-german-cv9/onnx'), { recursive: true });
  await writeFile(join(dir, REL), Buffer.from('0123456789'));
  await writeFile(join(dir, 'oliverguhr/wav2vec2-large-xlsr-53-german-cv9/config.json'), '{"a":1}');
  await writeFile(join(dir, 'secret.env'), 'SESSION_SECRET=nope');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveWeightsPath', () => {
  it('放行模型目录里的 json 与 onnx', () => {
    expect(resolveWeightsPath(dir, REL)).toBe(join(dir, REL));
  });

  it('挡住目录穿越，包括编码过的', () => {
    for (const rel of ['../secret.env', '..%2Fsecret.env', 'a/../../secret.env', '%2e%2e/x.json']) {
      expect(resolveWeightsPath(dir, rel)).toBeNull();
    }
  });

  it('挡住白名单以外的扩展名 —— .env 和无扩展名都不给', () => {
    expect(resolveWeightsPath(dir, 'secret.env')).toBeNull();
    expect(resolveWeightsPath(dir, 'oliverguhr')).toBeNull();
  });

  it('前缀相同但不是同一个目录的旁边那个目录也进不来', () => {
    expect(resolveWeightsPath('/data/models', '../models-evil/x.onnx')).toBeNull();
  });
});

describe('parseRange', () => {
  it('bytes=2-5', () => expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 }));
  it('bytes=4- 到末尾', () => expect(parseRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 }));
  it('bytes=-3 是最后三个字节', () => expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 }));
  it('越界或倒置一律 null', () => {
    expect(parseRange('bytes=10-12', 10)).toBeNull();
    expect(parseRange('bytes=5-2', 10)).toBeNull();
    expect(parseRange('bytes=-', 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
    expect(parseRange(undefined, 10)).toBeNull();
  });
  it('end 超过文件末尾时夹回去', () =>
    expect(parseRange('bytes=8-99', 10)).toEqual({ start: 8, end: 9 }));
});

describe('serveWeights', () => {
  it('整份取：200 + content-length + 可缓存', async () => {
    const res = await serveWeights(dir, REL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await res.text()).toBe('0123456789');
  });

  it('分片取：206 + content-range', async () => {
    const res = await serveWeights(dir, REL, 'bytes=2-4');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await res.text()).toBe('234');
  });

  it('Range 不合法回 416，而不是把整份给出去', async () => {
    const res = await serveWeights(dir, REL, 'bytes=99-200');
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('文件不在回 404', async () => {
    const res = await serveWeights(dir, 'oliverguhr/nope/onnx/model_q4.onnx');
    expect(res.status).toBe(404);
  });

  it('穿越出去回 404', async () => {
    expect((await serveWeights(dir, '../secret.env')).status).toBe(404);
  });
});
