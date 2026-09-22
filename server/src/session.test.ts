// 应用自己的会话令牌。它是长期有效的（90 天），所以每一条校验都得真的在。
//
// 令牌里**只放 sub** 是一个刻意的决定：邮箱与头像每次从库里读，这样白名单里删掉
// 一个人之后他手上那张旧令牌立刻失效。这里把这件事也钉住 —— 哪天有人为了省一次
// 查库把 email 塞进 payload，撤销就会静默失灵，而那在别处看不出来。

import { describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { SessionError, signSession, verifySession } from './session.ts';

const SECRET = new TextEncoder().encode('x'.repeat(32));
const OTHER = new TextEncoder().encode('y'.repeat(32));

describe('签发', () => {
  it('签出来的令牌自己认得', async () => {
    const { token } = await signSession(SECRET, 'user-1', 90);
    expect(await verifySession(SECRET, token)).toBe('user-1');
  });

  it('到期时刻按天算', async () => {
    const before = Date.now();
    const { expiresAt } = await signSession(SECRET, 'user-1', 90);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 90 * 86_400_000);
    expect(expiresAt).toBeLessThan(before + 91 * 86_400_000);
  });

  it('载荷里只有 sub —— 邮箱每次从库里读，白名单删人才能立刻生效', async () => {
    const { token } = await signSession(SECRET, 'user-1', 90);
    const payload = decodeJwt(token);
    expect(payload.sub).toBe('user-1');
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('name');
    expect(payload).not.toHaveProperty('picture');
  });

  it('用的是 HS256', async () => {
    const { token } = await signSession(SECRET, 'user-1', 90);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
  });
});

describe('校验', () => {
  it('换一个密钥就不认 —— 密钥只在服务器上', async () => {
    const { token } = await signSession(SECRET, 'user-1', 90);
    await expect(verifySession(OTHER, token)).rejects.toBeInstanceOf(SessionError);
  });

  it('改过一个字符的令牌不认', async () => {
    const { token } = await signSession(SECRET, 'user-1', 90);
    // 改**签名段的第一个字符**。两处讲究，都踩过：
    //   · 原来的写法是「把最后两个字符对调」—— 那两个字符碰巧相同时（base64url
    //     六十四个字母，概率约 1/64）token 一个字节都没变，于是校验理所当然地通过，
    //     用例红。CI 上真的红过一次（2026-09-22），而本机连跑三遍都是绿的。
    //   · 也不能改最后一个字符：HS256 的签名是 32 字节 = 256 位，base64url 编成
    //     43 个字符携带 258 位，**末字符有 2 位是填充位**，解码时被丢掉 ——
    //     只动到填充位的话签名解出来一模一样，照样通过。
    // 第一个字符的 6 位全是有效位，改了必然换一个签名。
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    // 防呆：万一哪天改法又退化成「其实没改」，这一行会先红。
    expect(tampered).not.toBe(token);
    await expect(verifySession(SECRET, tampered)).rejects.toBeInstanceOf(SessionError);
  });

  it('过期的不认', async () => {
    const { token } = await signSession(SECRET, 'user-1', -1);
    await expect(verifySession(SECRET, token)).rejects.toBeInstanceOf(SessionError);
  });

  it('不是 JWT 的东西不认，而且是 SessionError 不是随便一个 TypeError', async () => {
    for (const junk of ['', 'nicht-ein-token', 'a.b.c']) {
      await expect(verifySession(SECRET, junk)).rejects.toBeInstanceOf(SessionError);
    }
  });

  it('alg=none 的令牌不认 —— 这是 JWT 最老的那个坑', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      sub: 'user-1',
      iss: 'deutsch-sync',
      aud: 'deutsch-app',
    })}.`;
    await expect(verifySession(SECRET, forged)).rejects.toBeInstanceOf(SessionError);
  });

  it('两个用户的令牌互不串号', async () => {
    const a = await signSession(SECRET, 'user-a', 90);
    const b = await signSession(SECRET, 'user-b', 90);
    expect(await verifySession(SECRET, a.token)).toBe('user-a');
    expect(await verifySession(SECRET, b.token)).toBe('user-b');
    expect(a.token).not.toBe(b.token);
  });
});
