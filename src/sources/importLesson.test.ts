// 「补齐素材之后要不要重新对齐」这一个判断（§0 变更 43）。
//
// 它值得单独测，是因为判错的代价完全不对称：判成「没变」最多是时间戳偏一点，
// 判成「变了」是在手机上白跑一次对齐 —— 一课两分钟，而且是用户看着进度条等的那种。
// 变更 43 之前那个判断拿「DW 页面上报的整数秒」去比「对齐写回的解码值」，
// 于是每一门在桌面上对齐过、又在手机上补齐素材的课都可能中招。

import { describe, expect, it } from 'vitest';
import { audioChanged } from './importLesson';

describe('audioChanged（补齐回来的音频是不是同一份）', () => {
  it('记过字节数且一个字节不差 → 没变，时间戳照用（桌面对齐、手机补齐的那条主路径）', () => {
    expect(audioChanged({ audioBytes: 7_340_032, audioDuration: 758.45 }, { bytes: 7_340_032, duration: 758.45 }, 756)).toBe(false);
  });

  it('字节数对不上 → DW 换过音频，要重对', () => {
    expect(audioChanged({ audioBytes: 7_340_032 }, { bytes: 7_400_000 }, 756)).toBe(true);
  });

  it('老课程没记过字节数：比的是解码值对解码值，不是解码值对页面整数', () => {
    // 标注层里那个 758.45 是对齐写回的解码值；DW 页面报的是 756。
    // 旧判据（页面整数、容差 1 秒）会把这一课判成「换过音频」—— 正是这次要修的。
    expect(audioChanged({ audioDuration: 758.45 }, { bytes: 7_340_032, duration: 758.5 }, 756)).toBe(false);
  });

  it('老课程 + 解码失败：退回页面上报的时长，容差 2 秒内仍算同一份', () => {
    expect(audioChanged({ audioDuration: 757.4 }, { bytes: 7_340_032 }, 756)).toBe(false);
  });

  it('真换了一版音频 → 差的是分钟，两条路都判得出来', () => {
    expect(audioChanged({ audioDuration: 758.45 }, { bytes: 7_340_032, duration: 690 }, 690)).toBe(true);
  });

  it('这次压根没下到音频 → 不猜，交给 hasTimings 那一支回答', () => {
    expect(audioChanged({ audioBytes: 7_340_032, audioDuration: 758.45 }, undefined, 756)).toBe(false);
  });

  it('既没字节数也没旧时长 → 当没变（这一课本来就没有时间戳）', () => {
    expect(audioChanged({}, { bytes: 7_340_032, duration: 758.45 }, 756)).toBe(false);
  });
});
