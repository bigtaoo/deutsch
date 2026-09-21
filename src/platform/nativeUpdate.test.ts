import { describe, expect, it } from 'vitest';
import { decideUpdate, versionAtLeast, type OtaManifest } from './nativeUpdate';

// 热更的全部判断都在 decideUpdate 里（原生侧只管下载和切换），所以这一组用例就是
// 「什么时候更新、什么时候不更新」的契约。SPEC §7.11。

const manifest = (over: Partial<OtaManifest> = {}): OtaManifest => ({
  buildId: 'a1b2c3d',
  version: '0.4.0+a1b2c3d',
  url: 'https://d.gamestao.com/ota/bundle-a1b2c3d.zip',
  minNative: '0.4.0',
  bytes: 37_000_000,
  ...over,
});

describe('versionAtLeast', () => {
  it('按位比较，不按字典序', () => {
    // 字典序会说 '0.10.0' < '0.9.0'，那会让第 10 个壳版本之后的所有人停在原地。
    expect(versionAtLeast('0.10.0', '0.9.0')).toBe(true);
    expect(versionAtLeast('0.9.0', '0.10.0')).toBe(false);
  });

  it('相等算够', () => {
    expect(versionAtLeast('0.4.0', '0.4.0')).toBe(true);
  });

  it('缺补丁号当 0', () => {
    expect(versionAtLeast('1.2', '1.2.0')).toBe(true);
    expect(versionAtLeast('1.2', '1.2.1')).toBe(false);
  });

  it('解析不出来的当 0.0.0 —— 输给一切，宁可不更新', () => {
    expect(versionAtLeast('', '0.4.0')).toBe(false);
    expect(versionAtLeast('unknown', '0.0.0')).toBe(true);
  });
});

describe('decideUpdate', () => {
  it('内置 bundle 一律要更新 —— 出包那一刻之后的改动全在这个包里', () => {
    expect(decideUpdate(manifest(), 'builtin', '0.4.0')).toEqual({
      action: 'download',
      version: '0.4.0+a1b2c3d',
      url: 'https://d.gamestao.com/ota/bundle-a1b2c3d.zip',
    });
  });

  it('版本一样就不动', () => {
    const d = decideUpdate(manifest(), '0.4.0+a1b2c3d', '0.4.0');
    expect(d).toEqual({ action: 'skip', reason: '已经是最新' });
  });

  it('壳太旧就不下 —— 热更换不了原生代码', () => {
    const d = decideUpdate(manifest({ minNative: '0.5.0' }), 'builtin', '0.4.0');
    expect(d.action).toBe('skip');
    expect(d.action === 'skip' && d.reason).toContain('0.5.0');
  });

  it('壳比门槛新当然可以', () => {
    expect(decideUpdate(manifest({ minNative: '0.4.0' }), 'builtin', '0.6.2').action).toBe(
      'download',
    );
  });

  it('回滚也要跟着走 —— 相等判断，不比大小', () => {
    // 线上出问题回退一个 commit：manifest 的 buildId 变回旧的那个。
    // 比大小的客户端会把这次回退当"旧版"拒掉，恰好在最需要更新的时候不更新。
    const rolledBack = manifest({ buildId: 'old1234', version: '0.4.0+old1234' });
    expect(decideUpdate(rolledBack, '0.4.0+a1b2c3d', '0.4.0').action).toBe('download');
  });

  it('manifest 残缺就当没看见', () => {
    expect(decideUpdate(manifest({ buildId: '' }), 'builtin', '0.4.0').action).toBe('skip');
    expect(decideUpdate(manifest({ url: '' }), 'builtin', '0.4.0').action).toBe('skip');
  });
});
