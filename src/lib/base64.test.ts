// base64 这一层存在的全部理由就是「btoa 处理不了德语」。
// 所以测的不是 base64 本身，而是那些会让 btoa 直接抛 InvalidCharacterError 的字符。

import { describe, expect, it } from 'vitest';
import { decodeBase64Utf8, encodeBase64Utf8 } from './base64';

describe('encodeBase64Utf8 / decodeBase64Utf8', () => {
  it('德语变音符与 ß 往返不变 —— 这是整个模块存在的理由', () => {
    const text = 'Straße, Gelegenheitsjob, Öffentlichkeit, Übung, ärgerlich';
    expect(decodeBase64Utf8(encodeBase64Utf8(text))).toBe(text);
  });

  it('中文与 emoji（多字节、代理对）也往返不变', () => {
    const text = '德语精听训练器 🎧 —— 「通听」';
    expect(decodeBase64Utf8(encodeBase64Utf8(text))).toBe(text);
  });

  it('直接 btoa 的两种坏结果，这里都没有', () => {
    // äöüß 落在 Latin1 里，btoa 不抛 —— 它只是**按 Latin1 编**，
    // 于是 ß 出去是一个字节而不是 UTF-8 的两个，解回来就成了别的字。这种错最难发现。
    expect(btoa('Straße')).not.toBe(encodeBase64Utf8('Straße'));
    expect(decodeBase64Utf8(encodeBase64Utf8('Straße'))).toBe('Straße');
    // Latin1 之外的字符 btoa 直接抛。
    expect(() => btoa('德语')).toThrow();
    expect(() => encodeBase64Utf8('德语')).not.toThrow();
  });

  it('空串往返成空串', () => {
    expect(encodeBase64Utf8('')).toBe('');
    expect(decodeBase64Utf8('')).toBe('');
  });

  it('解码时忽略换行 —— 按 60 字符折行的 base64 也要能读', () => {
    const plain = 'Alltagsdeutsch: Die Straße war voller Menschen.';
    const wrapped = encodeBase64Utf8(plain).replace(/(.{8})/g, '$1\n');
    expect(wrapped).toContain('\n');
    expect(decodeBase64Utf8(wrapped)).toBe(plain);
  });

  it('产出的是合法 base64（只有 A-Za-z0-9+/= ）', () => {
    expect(encodeBase64Utf8('Öl über Ölüberschuss')).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});
