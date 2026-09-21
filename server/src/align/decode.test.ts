// 只测 extensionOf —— decodeToMono 要真的起一个 ffmpeg 子进程，那是集成测试的事，
// 不该挂在这套一秒半跑完的单测上。
//
// 扩展名这件事看着无关紧要，但它决定了 m4a 能不能被 ffmpeg 认出来（moov box 在文件尾部，
// 靠嗅探不一定行）。给错了的症状是「某些手动导入的课在服务器上对不了齐」，
// 而错误信息里只有一行 ffmpeg 的抱怨。

import { describe, expect, it } from 'vitest';
import { extensionOf } from './decode.ts';

describe('extensionOf', () => {
  it('DW 的 mp3', () => {
    expect(extensionOf('audio/mpeg')).toBe('mp3');
    expect(extensionOf('audio/mp3')).toBe('mp3');
  });

  it('手动导入可能是 m4a / aac / ogg / opus / wav / flac', () => {
    expect(extensionOf('audio/mp4')).toBe('m4a');
    expect(extensionOf('audio/x-m4a')).toBe('m4a');
    expect(extensionOf('audio/aac')).toBe('aac');
    expect(extensionOf('audio/ogg')).toBe('ogg');
    expect(extensionOf('audio/opus')).toBe('opus');
    expect(extensionOf('audio/wav')).toBe('wav');
    expect(extensionOf('audio/x-wav')).toBe('wav');
    expect(extensionOf('audio/wave')).toBe('wav');
    expect(extensionOf('audio/flac')).toBe('flac');
  });

  it('带参数的 Content-Type 照样认（浏览器会加 codecs=）', () => {
    expect(extensionOf('audio/mp4; codecs="mp4a.40.2"')).toBe('m4a');
    expect(extensionOf('audio/ogg;codecs=opus')).toBe('ogg');
  });

  it('大小写与空白无关', () => {
    expect(extensionOf('  AUDIO/MPEG  ')).toBe('mp3');
    expect(extensionOf('Audio/X-M4A')).toBe('m4a');
  });

  it('认不出来、缺失、空串一律退到 mp3 —— 这不是失败，ffmpeg 主要靠嗅探', () => {
    expect(extensionOf(undefined)).toBe('mp3');
    expect(extensionOf('')).toBe('mp3');
    expect(extensionOf('application/octet-stream')).toBe('mp3');
    expect(extensionOf('video/mp4')).toBe('mp3');
  });

  it('产出的永远是一个安全的裸扩展名 —— 它要拼进临时文件路径', () => {
    for (const type of ['audio/mpeg', 'audio/mp4', '../../etc/passwd', undefined]) {
      expect(extensionOf(type)).toMatch(/^[a-z0-9]+$/);
    }
  });
});
