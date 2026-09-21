// manuscriptHash 要回答的问题只有一个：「DW 是不是改过稿」（FR-3.7）。
// 两种错都很贵：漏报 = 时间戳与挖空 offset 静默全废；误报 = 每次补齐素材都弹一次警告。
// 折叠空白那一步正好卡在这两者之间，所以它是这里的主角。

import { describe, expect, it } from 'vitest';
import { cyrb53, manuscriptHash } from './hash';

describe('cyrb53', () => {
  it('同一串同一个值（同步、确定）', () => {
    expect(cyrb53('Alltagsdeutsch')).toBe(cyrb53('Alltagsdeutsch'));
  });

  it('改一个字就换一个值', () => {
    expect(cyrb53('Alltagsdeutsch')).not.toBe(cyrb53('Alltagsdeutsck'));
  });

  it('seed 不同结果不同', () => {
    expect(cyrb53('abc', 0)).not.toBe(cyrb53('abc', 1));
  });

  it('空串也给得出值，不是 undefined', () => {
    expect(cyrb53('')).toBeTruthy();
  });

  it('大小写敏感、变音符敏感 —— 德语里这两样都是意义差别', () => {
    expect(cyrb53('Straße')).not.toBe(cyrb53('strasse'));
    expect(cyrb53('schon')).not.toBe(cyrb53('schön'));
  });
});

describe('manuscriptHash', () => {
  it('改一个换行不算改稿', () => {
    expect(manuscriptHash('Erster Satz.\nZweiter Satz.')).toBe(
      manuscriptHash('Erster Satz. Zweiter Satz.'),
    );
  });

  it('多余空格、制表符、空行都折成一个空格', () => {
    const base = manuscriptHash('a b c');
    expect(manuscriptHash('a  b\t\tc')).toBe(base);
    expect(manuscriptHash('a\n\n\nb\r\nc')).toBe(base);
  });

  it('首尾空白无关', () => {
    expect(manuscriptHash('  Text.  \n')).toBe(manuscriptHash('Text.'));
  });

  it('真的改了字就变 —— 这条漏了就是标注静默全废', () => {
    expect(manuscriptHash('Die Straße war leer.')).not.toBe(
      manuscriptHash('Die Straße war voll.'),
    );
  });

  it('词之间少一个空格算改稿（那会让 offset 整体前移）', () => {
    expect(manuscriptHash('Die Straße')).not.toBe(manuscriptHash('DieStraße'));
  });
});
